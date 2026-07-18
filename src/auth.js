/* ============================================================================
   Middlewares de autenticação e autorização

   - exigirLogin: bloqueia quem não está logado.
   - exigirPapel(...): bloqueia quem está logado mas não tem o papel certo.
   - paginaInicialPorPapel: para onde mandar cada usuário depois do login.
   ========================================================================== */

/** Rota da "home" de cada papel. */
function paginaInicialPorPapel(papel) {
  switch (papel) {
    case 'responsavel':
      return '/responsavel';
    case 'admin':
      return '/responsavel'; // admin cai no painel por enquanto
    case 'solicitante':
    default:
      return '/solicitante';
  }
}

/** Deixa passar apenas quem tem sessão ativa. */
function exigirLogin(req, res, next) {
  if (req.session && req.session.usuario) {
    return next();
  }
  // Requisições de API respondem JSON; navegação normal vai para o login.
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, erro: 'Não autenticado.' });
  }
  return res.redirect('/login');
}

/** Deixa passar apenas quem tem um dos papéis informados. */
function exigirPapel(...papeisPermitidos) {
  return (req, res, next) => {
    const usuario = req.session && req.session.usuario;
    if (!usuario) {
      return res.redirect('/login');
    }
    if (!papeisPermitidos.includes(usuario.papel)) {
      // Logado, mas sem permissão: manda para a própria home.
      return res.redirect(paginaInicialPorPapel(usuario.papel));
    }
    return next();
  };
}

module.exports = { exigirLogin, exigirPapel, paginaInicialPorPapel };
