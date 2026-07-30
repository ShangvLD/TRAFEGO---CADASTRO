/* ============================================================================
   Middlewares de autenticação e autorização

   - exigirLogin        : bloqueia quem não está logado.
   - exigirPapel(...)   : bloqueia por nome de papel (uso pontual).
   - exigirAdmin        : atalho para as telas de administração.
   - exigirFormulario(m): bloqueia quem não pode PREENCHER o módulo m.
   - exigirPainel(m)    : bloqueia quem não pode ACOMPANHAR o módulo m.

   As duas últimas consultam src/papeis.js e src/modulos.js — as regras de
   acesso ficam declaradas lá, não espalhadas pelas rotas. Acrescentar um módulo
   não exige escrever middleware novo.
   ========================================================================== */

const { acharModulo, dominioPermitido, rotaFormulario, rotaPainel } = require('./modulos');
const papeis = require('./papeis');

/** Responde negativa no formato certo: JSON em /api/, redirecionamento em página. */
function negar(req, res, { status, erro, destino }) {
  if (req.path.startsWith('/api/')) {
    return res.status(status).json({ ok: false, erro });
  }
  return res.redirect(destino);
}

/** Para onde mandar cada usuário depois do login. */
function paginaInicialPorPapel(papel) {
  // Quem acompanha algum painel cai no painel; quem só preenche cai no
  // formulário. Assim cada perfil entra já onde trabalha.
  const paineis = papeis.paineisDoPapel(papel);
  if (paineis.length) return rotaPainel(paineis[0]);

  const formularios = papeis.formulariosDoPapel(papel);
  if (formularios.length) return rotaFormulario(formularios[0]);

  // Papel sem nada liberado: manda para a página de acompanhamento, que só
  // lista as próprias solicitações (não deixa o usuário num beco sem saída).
  return '/minhas-solicitacoes';
}

/** Deixa passar apenas quem tem sessão ativa. */
function exigirLogin(req, res, next) {
  if (req.session && req.session.usuario) {
    return next();
  }
  return negar(req, res, { status: 401, erro: 'Não autenticado.', destino: '/login' });
}

/** Deixa passar apenas quem tem um dos papéis informados. */
function exigirPapel(...papeisPermitidos) {
  return (req, res, next) => {
    const usuario = req.session && req.session.usuario;
    if (!usuario) {
      return negar(req, res, { status: 401, erro: 'Não autenticado.', destino: '/login' });
    }
    if (!papeisPermitidos.includes(usuario.papel)) {
      return negar(req, res, {
        status: 403,
        erro: 'Sem permissão para esta ação.',
        destino: paginaInicialPorPapel(usuario.papel),
      });
    }
    return next();
  };
}

/** Somente quem tem perfil administrativo. */
function exigirAdmin(req, res, next) {
  const usuario = req.session && req.session.usuario;
  if (!usuario) {
    return negar(req, res, { status: 401, erro: 'Não autenticado.', destino: '/login' });
  }
  if (!papeis.ehAdmin(usuario.papel)) {
    return negar(req, res, {
      status: 403,
      erro: 'Somente administradores.',
      destino: paginaInicialPorPapel(usuario.papel),
    });
  }
  return next();
}

/**
 * Permissão para PREENCHER o formulário de um módulo.
 *
 * Três verificações, nesta ordem:
 *   1. o papel tem esse módulo liberado?
 *   2. o módulo está restrito a admin nesta fase?
 *   3. o e-mail atende à restrição de domínio do módulo?
 *
 * A checagem de domínio existe porque o Cadastro Terceiro é preenchido pelo
 * time interno — quem tem e-mail @jomedlog.com.br. Agregado e candidato são
 * externos e não têm essa restrição.
 */
function exigirFormulario(slug) {
  return (req, res, next) => {
    const usuario = req.session && req.session.usuario;
    if (!usuario) {
      return negar(req, res, { status: 401, erro: 'Não autenticado.', destino: '/login' });
    }

    const modulo = acharModulo(slug);
    if (!modulo) {
      return negar(req, res, { status: 404, erro: 'Módulo não encontrado.', destino: '/' });
    }

    const admin = papeis.ehAdmin(usuario.papel);

    if (!papeis.podeFormulario(usuario.papel, slug)) {
      return negar(req, res, {
        status: 403,
        erro: `Sem permissão para o ${modulo.rotulo}.`,
        destino: paginaInicialPorPapel(usuario.papel),
      });
    }

    if (modulo.somenteAdmin && !admin) {
      return negar(req, res, {
        status: 403,
        erro: `O ${modulo.rotulo} está em validação e restrito a administradores.`,
        destino: paginaInicialPorPapel(usuario.papel),
      });
    }

    if (!dominioPermitido(modulo, usuario.email)) {
      return negar(req, res, {
        status: 403,
        erro: `O ${modulo.rotulo} é restrito a e-mails @${modulo.dominioExigido}.`,
        destino: paginaInicialPorPapel(usuario.papel),
      });
    }

    req.modulo = modulo; // as rotas usam para saber a tabela e os rótulos
    return next();
  };
}

/** Permissão para ACOMPANHAR/APROVAR o painel de um módulo. */
function exigirPainel(slug) {
  return (req, res, next) => {
    const usuario = req.session && req.session.usuario;
    if (!usuario) {
      return negar(req, res, { status: 401, erro: 'Não autenticado.', destino: '/login' });
    }

    const modulo = acharModulo(slug);
    if (!modulo) {
      return negar(req, res, { status: 404, erro: 'Módulo não encontrado.', destino: '/' });
    }

    if (!papeis.podePainel(usuario.papel, slug)) {
      return negar(req, res, {
        status: 403,
        erro: `Sem permissão para o painel de ${modulo.rotuloCurto}.`,
        destino: paginaInicialPorPapel(usuario.papel),
      });
    }

    req.modulo = modulo;
    return next();
  };
}

module.exports = {
  exigirLogin,
  exigirPapel,
  exigirAdmin,
  exigirFormulario,
  exigirPainel,
  paginaInicialPorPapel,
};
