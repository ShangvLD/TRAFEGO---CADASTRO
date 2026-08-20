/* ============================================================================
   Papéis de usuário e permissões por módulo

   O acesso é DERIVADO daqui, não espalhado por ifs nas rotas. Cada papel diz:

     formularios : em quais módulos pode PREENCHER          ('*' = todos)
     paineis     : de quais módulos pode ACOMPANHAR/APROVAR ('*' = todos)
     admin       : acessa a configuração do formulário

   PARA ACRESCENTAR UM MÓDULO: crie aqui o papel do solicitante e o do
   responsável correspondentes. O resto (menu, rotas, middlewares) se ajusta
   sozinho, porque tudo consulta estas funções.

   PAPÉIS LEGADOS: 'solicitante' e 'responsavel' existem em produção e continuam
   funcionando — o CHECK do banco os aceita e o mapa abaixo os traduz para o
   comportamento que já tinham. Sem isso, os usuários atuais perderiam acesso.
   ========================================================================== */

const { SLUGS } = require('./modulos');

const PAPEIS = {
  // ---- Acesso total -------------------------------------------------------
  admin: {
    rotulo: 'Administrador',
    formularios: '*',
    paineis: '*',
    admin: true,
  },

  // ---- Responsável: acompanha e decide em TODOS os módulos ----------------
  // Terceiro, agregado e candidato. É o perfil padrão de quem analisa
  // solicitação — não aprova só um tipo.
  responsavel: {
    rotulo: 'Responsável',
    formularios: [],
    paineis: '*',
    admin: false,
  },

  // ---- Responsáveis RESTRITOS a um módulo ---------------------------------
  // Opcionais: use quando alguém deve ver só um tipo de solicitação. O papel
  // "responsavel" acima é o padrão e alcança os três.
  responsavel_terceiro: {
    rotulo: 'Responsável — Terceiro',
    formularios: [],
    paineis: ['terceiro'],
    admin: false,
  },
  responsavel_agregado: {
    rotulo: 'Responsável — Agregado',
    formularios: [],
    paineis: ['agregado'],
    admin: false,
  },
  responsavel_candidato: {
    rotulo: 'Responsável — Candidato',
    formularios: [],
    paineis: ['candidato'],
    admin: false,
  },

  // ---- Solicitantes: cada um preenche SÓ o seu formulário -----------------
  terceiro: {
    rotulo: 'Terceiro',
    formularios: ['terceiro'],
    paineis: [],
    admin: false,
  },
  agregado: {
    rotulo: 'Agregado',
    formularios: ['agregado'],
    paineis: [],
    admin: false,
  },
  candidato: {
    rotulo: 'Candidato',
    formularios: ['candidato'],
    paineis: [],
    admin: false,
  },

  // ---- Legado (em uso hoje) ----------------------------------------------
  // 'solicitante' preenchia o formulário de terceiro e via "Minhas
  // solicitações". Mantido porque há usuários com este papel em produção.
  solicitante: {
    rotulo: 'Solicitante (legado)',
    formularios: ['terceiro'],
    paineis: [],
    admin: false,
    legado: true,
  },
};

/** Todos os nomes de papel — usado no CHECK da tabela usuarios. */
const NOMES_PAPEIS = Object.keys(PAPEIS);

/** Papéis oferecidos ao criar usuário (exclui os legados). */
const PAPEIS_ATUAIS = NOMES_PAPEIS.filter((p) => !PAPEIS[p].legado);

function definicao(papel) {
  return PAPEIS[String(papel || '').toLowerCase()] || null;
}

/** Expande '*' na lista completa de módulos. */
function expandir(valor) {
  if (valor === '*') return [...SLUGS];
  return Array.isArray(valor) ? valor : [];
}

/** Módulos cujo FORMULÁRIO o papel pode preencher. */
function formulariosDoPapel(papel) {
  const d = definicao(papel);
  return d ? expandir(d.formularios) : [];
}

/** Módulos cujo PAINEL o papel pode acompanhar. */
function paineisDoPapel(papel) {
  const d = definicao(papel);
  return d ? expandir(d.paineis) : [];
}

function podeFormulario(papel, slug) {
  return formulariosDoPapel(papel).includes(slug);
}

function podePainel(papel, slug) {
  return paineisDoPapel(papel).includes(slug);
}

function ehAdmin(papel) {
  const d = definicao(papel);
  return !!(d && d.admin);
}

/**
 * Quem pode VER e RESPONDER a pesquisa RDO.
 *
 * Era restrito a admin, e isso travava o painel: a pesquisa RDO é a PRIMEIRA
 * etapa do fluxo, e a decisão por cliente só abre depois dela. Com a restrição,
 * o responsável — que é quem analisa — via "Falta: responder RDO aprovado?" sem
 * ter como responder, e as gerenciadoras nunca liberavam.
 *
 * Quem acompanha o painel do módulo responde. O SOLICITANTE continua fora: para
 * ele a pesquisa some (ver semRdo em server.js), porque é conferência interna
 * sobre ele mesmo.
 *
 * @param slug  módulo; sem ele, basta acompanhar ALGUM painel (usado na tela
 *              de "minhas solicitações", que junta os módulos numa lista só).
 */
function podeRdo(papel, slug) {
  if (ehAdmin(papel)) return true;
  return slug ? podePainel(papel, slug) : paineisDoPapel(papel).length > 0;
}

/** Rótulo legível do papel (para telas e listagens). */
function rotuloDoPapel(papel) {
  const d = definicao(papel);
  return d ? d.rotulo : String(papel || '—');
}

module.exports = {
  PAPEIS,
  NOMES_PAPEIS,
  PAPEIS_ATUAIS,
  definicao,
  formulariosDoPapel,
  paineisDoPapel,
  podeFormulario,
  podePainel,
  ehAdmin,
  podeRdo,
  rotuloDoPapel,
};
