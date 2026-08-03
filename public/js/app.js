/* ============================================================================
   Script compartilhado das páginas logadas.

   - Carrega o usuário atual (/api/eu) e preenche o cabeçalho.
   - DESENHA O MENU a partir das permissões devolvidas pelo servidor.
   - Controla o menu do usuário e o logout.

   O menu não é mais HTML fixo em cada página: o servidor diz quais itens o
   usuário pode ver (src/menu.js) e aqui eles são desenhados. Assim um módulo
   novo aparece em todas as páginas sem editar nenhuma view.
   ========================================================================== */

(async function () {
  // Elementos do header (podem não existir em todas as páginas).
  const avatarEl = document.getElementById('user-avatar');
  const nomeEl = document.getElementById('user-name');
  const chip = document.getElementById('user-chip');
  const menu = document.getElementById('user-menu');
  const menuNome = document.getElementById('menu-nome');
  const menuEmail = document.getElementById('menu-email');
  const menuPapel = document.getElementById('menu-papel');
  const btnSair = document.getElementById('btn-sair');
  const navEl = document.getElementById('main-nav');
  const contaEl = document.getElementById('menu-conta-itens');

  // Gera as iniciais a partir do nome (ex.: "Victor Diniz" -> "VD").
  function iniciais(nome) {
    const partes = String(nome).trim().split(/\s+/);
    const primeira = partes[0]?.[0] || '';
    const ultima = partes.length > 1 ? partes[partes.length - 1][0] : '';
    return (primeira + ultima).toUpperCase();
  }

  function esc(txt) {
    const d = document.createElement('div');
    d.textContent = txt == null ? '' : String(txt);
    return d.innerHTML;
  }

  /** Marca como ativo o item cujo href corresponde à página aberta. */
  function ehAtual(href) {
    const atual = window.location.pathname;
    if (href === atual) return true;
    // /painel/terceiro deve ficar ativo também em /painel/terceiro/algo
    return href !== '/' && atual.startsWith(href + '/');
  }

  /**
   * Cada item vira ícone + rótulo. O `title` existe porque em tela estreita o
   * CSS oculta o rótulo e sobra só o ícone — sem ele, o item ficaria sem
   * identificação nenhuma.
   */
  function desenharMenu(itens) {
    if (!navEl) return;
    navEl.innerHTML = (itens || [])
      .map(
        (i) =>
          `<a href="${esc(i.href)}"${ehAtual(i.href) ? ' class="active"' : ''} title="${esc(i.rotulo)}">` +
          `<span class="material-symbols-rounded nav-icone">${esc(i.icone || 'chevron_right')}</span>` +
          `<span class="nav-rotulo">${esc(i.rotulo)}</span>` +
          `</a>`
      )
      .join('');
  }

  function desenharMenuDaConta(itens) {
    if (!contaEl) return;
    if (!itens || !itens.length) {
      contaEl.innerHTML = '';
      return;
    }
    contaEl.innerHTML =
      itens
        .map(
          (i) =>
            `<a href="${esc(i.href)}">` +
            `<span class="material-symbols-rounded">${esc(i.icone || 'chevron_right')}</span> ` +
            `${esc(i.rotulo)}</a>`
        )
        .join('') + '<div class="user-menu__sep"></div>';
  }

  // Busca o usuário logado, o menu e preenche o cabeçalho.
  try {
    const resp = await fetch('/api/eu');
    if (resp.status === 401) {
      window.location.href = '/login';
      return;
    }
    const dados = await resp.json();
    if (dados.ok) {
      const u = dados.usuario;
      if (avatarEl) avatarEl.textContent = iniciais(u.nome);
      if (nomeEl) nomeEl.textContent = u.nome;
      if (menuNome) menuNome.textContent = u.nome;
      if (menuEmail) menuEmail.textContent = u.email;
      if (menuPapel) menuPapel.textContent = dados.papelRotulo || u.papel;

      desenharMenu(dados.menu);
      desenharMenuDaConta(dados.menuConta);

      // Compatibilidade: elementos marcados como exclusivos de admin em
      // páginas que ainda não usam o menu dinâmico.
      if (dados.ehAdmin) {
        document.querySelectorAll('[data-admin-only]').forEach((el) => {
          el.hidden = false;
        });
      }

      // Deixa os dados à disposição da página (ex.: o painel usa o papel).
      window.usuarioAtual = u;
      window.permissoes = {
        ehAdmin: !!dados.ehAdmin,
        formularios: dados.formularios || [],
        paineis: dados.paineis || [],
      };
      document.dispatchEvent(new CustomEvent('usuario-carregado', { detail: dados }));
    }
  } catch (e) {
    // Sem conexão: não trava a página, apenas não popula o header.
  }

  // Abre/fecha o menu do usuário.
  if (chip && menu) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));
    menu.addEventListener('click', (e) => e.stopPropagation());
  }

  // Logout.
  if (btnSair) {
    btnSair.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/logout', { method: 'POST' });
        const dados = await resp.json();
        window.location.href = dados.redirect || '/login';
      } catch (e) {
        window.location.href = '/login';
      }
    });
  }
})();
