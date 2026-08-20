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

/* ============================================================================
   Datas: o banco grava em UTC, a tela mostra no fuso de quem está lendo

   POR QUE ISSO EXISTE: os carimbos de tempo são gravados em UTC (veja AGORA_SQL
   em src/db.js). Exibir o valor cru mostrava tudo 3 horas adiantado no Brasil —
   um atendimento das 17:43 aparecia como 20:43. Passava despercebido porque a
   diferença é constante: parece só "um horário", não um erro.

   Fica aqui, em app.js, porque quatro telas formatavam data cada uma do seu
   jeito. Com a conversão espalhada, bastaria uma delas ficar para trás.
   ========================================================================== */
(function () {
  'use strict';

  /** "2026-08-05 20:43:11" (UTC do banco) -> objeto Date correto. */
  function comoData(valor) {
    if (!valor) return null;
    const txt = String(valor).trim();

    // Já tem fuso declarado (ISO com Z ou ±hh:mm)? Então respeita o que veio.
    if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(txt)) {
      const d = new Date(txt);
      return isNaN(d) ? null : d;
    }

    // Formato do banco, sem fuso: é UTC, e precisa ser dito explicitamente —
    // sem o "Z" o navegador interpretaria como hora local e o erro dobraria.
    const m = txt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));

    // Só a data, sem hora: não há o que converter.
    const so = txt.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (so) return new Date(+so[1], +so[2] - 1, +so[3]);

    const d = new Date(txt);
    return isNaN(d) ? null : d;
  }

  const pad = (n) => String(n).padStart(2, '0');

  /** 05/08/2026 */
  function dataBR(valor) {
    const d = comoData(valor);
    if (!d) return '—';
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  }

  /** 05/08/2026 17:43 */
  function dataHoraBR(valor) {
    const d = comoData(valor);
    if (!d) return '—';
    return `${dataBR(valor)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** 05/08/2026 às 17:43 */
  function dataHoraPorExtenso(valor) {
    const d = comoData(valor);
    if (!d) return '';
    return `${dataBR(valor)} às ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  window.comoData = comoData;
  window.dataBR = dataBR;
  window.dataHoraBR = dataHoraBR;
  window.dataHoraPorExtenso = dataHoraPorExtenso;
})();

/* ============================================================================
   Clientes/operações: dos "| | | |" para chips

   O campo "assunto" guarda os clientes separados por "|". Nos 51 registros
   importados do Microsoft Forms havia UMA COLUNA POR CLIENTE, e a maioria vinha
   vazia — então o texto cru sai assim:

     "MERCADO LIVRE | SHOPEE | AMAZON | | | | | |"

   O painel já limpava isso e desenhava chips coloridos; as outras telas
   (relatórios, minhas solicitações, painel genérico) mostravam o texto cru,
   canos vazios incluídos. Isto vive aqui, e não em cada view, porque era
   exatamente a cópia por tela que deixou uma certa e três erradas.
   ========================================================================== */
(function () {
  'use strict';

  // Marcas conhecidas têm cor fixa; as demais recebem uma cor ESTÁVEL (a mesma
  // sempre para o mesmo nome) por hash — assim o cliente novo não troca de cor
  // a cada carregamento.
  const CLIENTE_COR = {
    'MERCADO LIVRE': '#c98a00',
    'SHOPEE':        '#ee4d2d',
    'AMAZON':        '#146eb4',
    'SAMSUNG':       '#034ea2',
    'BAYER':         '#1f8a4c',
    'LOREAL':        '#111827',
    "L'OREAL":       '#111827',
    'KENVUE':        '#c026d3',
    'KENVUE ANGEL':  '#db2777', // mesma família do KENVUE, tom distinto
  };

  const CLIENTE_PALETA = [
    '#005a9e', '#c98a00', '#ee4d2d', '#7b2ff7', '#1f8a4c', '#0e7490', '#9d174d',
    '#4338ca', '#0f766e', '#a16207', '#be123c', '#3f6212', '#b91c1c', '#6d28d9',
  ];

  function escapar(txt) {
    const d = document.createElement('div');
    d.textContent = txt == null ? '' : String(txt);
    return d.innerHTML;
  }

  function corCliente(nome) {
    const chave = String(nome || '').toUpperCase();
    if (CLIENTE_COR[chave]) return CLIENTE_COR[chave];
    let h = 0;
    for (let i = 0; i < chave.length; i++) h = (h * 31 + chave.charCodeAt(i)) >>> 0;
    return CLIENTE_PALETA[h % CLIENTE_PALETA.length];
  }

  /** "MERCADO LIVRE | SHOPEE | | |" -> ['MERCADO LIVRE', 'SHOPEE'] */
  function clientesDe(assunto) {
    const vistos = new Set();
    const lista = [];
    for (const parte of String(assunto || '').split('|')) {
      const nome = parte.trim();
      if (!nome) continue;
      const chave = nome.toUpperCase();
      if (vistos.has(chave)) continue; // o Forms repetia o cliente em colunas diferentes
      vistos.add(chave);
      lista.push(nome);
    }
    return lista;
  }

  /** Chips coloridos, para tabela e modal. */
  function clientesChips(assunto) {
    const nomes = clientesDe(assunto);
    if (!nomes.length) return '<span style="color:var(--text-secondary)">—</span>';
    return '<div class="cliente-chips">' + nomes.map((n) =>
      '<span class="cliente-chip" style="--chip:' + corCliente(n) + '">' + escapar(n) + '</span>'
    ).join('') + '</div>';
  }

  /** Texto limpo, para CSV e para o arquivo de exportação. */
  function clientesTexto(assunto, separador) {
    return clientesDe(assunto).join(separador || ' | ');
  }

  window.corCliente = corCliente;
  window.clientesDe = clientesDe;
  window.clientesChips = clientesChips;
  window.clientesTexto = clientesTexto;
})();
