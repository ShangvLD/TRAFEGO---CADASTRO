/* ============================================================================
   Script compartilhado das páginas logadas.

   - Carrega o usuário atual (/api/eu) e preenche o cabeçalho.
   - Controla o menu do usuário e o logout.
   ========================================================================== */

(async function () {
  // Elementos do header (podem não existir em todas as páginas).
  const avatarEl = document.getElementById('user-avatar');
  const nomeEl = document.getElementById('user-name');
  const chip = document.getElementById('user-chip');
  const menu = document.getElementById('user-menu');
  const menuNome = document.getElementById('menu-nome');
  const menuEmail = document.getElementById('menu-email');
  const btnSair = document.getElementById('btn-sair');

  // Gera as iniciais a partir do nome (ex.: "Victor Diniz" -> "VD").
  function iniciais(nome) {
    const partes = String(nome).trim().split(/\s+/);
    const primeira = partes[0]?.[0] || '';
    const ultima = partes.length > 1 ? partes[partes.length - 1][0] : '';
    return (primeira + ultima).toUpperCase();
  }

  // Busca o usuário logado e preenche o cabeçalho.
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

      // Admin enxerga as duas áreas (envio + aprovação): revela os links
      // de navegação marcados como exclusivos de admin.
      if (u.papel === 'admin') {
        document.querySelectorAll('[data-admin-only]').forEach((el) => {
          el.hidden = false;
        });
      }
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
