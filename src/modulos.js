/* ============================================================================
   Registro dos módulos de cadastro

   Cada módulo é um formulário com tabela, painel de acompanhamento, fluxo de
   aprovação e permissões PRÓPRIOS. Este arquivo é a única fonte de verdade
   sobre quais módulos existem — as rotas, o menu, os middlewares de permissão e
   a camada de dados são todos derivados daqui.

   PARA ACRESCENTAR UM MÓDULO NOVO no futuro:
     1. acrescente uma entrada nesta lista;
     2. acrescente os papéis correspondentes em src/papeis.js;
     3. pronto — rota do formulário, rota do painel, APIs, menu e permissões
        passam a existir. A tabela é criada automaticamente por src/db.js.

   Sobre "banco de dados separado": os módulos usam TABELAS separadas no mesmo
   PostgreSQL, não instâncias separadas. O isolamento que importa (dado de um
   módulo não se mistura com o de outro, permissão e fluxo independentes) é
   obtido assim, sem triplicar custo de infraestrutura e sem impedir relatório
   consolidado no futuro.
   ========================================================================== */

const MODULOS = [
  {
    slug: 'terceiro',
    rotulo: 'Cadastro Terceiro',
    rotuloCurto: 'Terceiro',
    icone: 'local_shipping',
    iconePainel: 'monitoring',
    descricao: 'Cadastro de condutores, veículos e proprietários terceirizados.',

    // Tabela JÁ EXISTENTE, com os 52 registros de produção.
    tabela: 'solicitacoes',

    // Este módulo tem tela própria (formulário completo, já construído e
    // validado). Os módulos novos usam as telas genéricas.
    viewFormulario: 'cadastro.html',
    viewPainel: 'responsavel.html',

    // Só quem tem e-mail do domínio da empresa preenche este formulário:
    // é o time interno que cadastra terceiros, não o terceiro em si.
    dominioExigido: 'jomedlog.com.br',

    // Restrito a admin enquanto o upload de documentos não estiver liberado.
    // Ao liberar, troque para false.
    somenteAdmin: true,

    // Tem API própria (POST /api/cadastros, que grava também nas tabelas
    // estruturadas: condutores, veiculos, documentos...). Por isso NÃO recebe a
    // rota genérica de criação — ela gravaria uma solicitação sem os dados
    // estruturados, contornando toda a validação do módulo.
    apiPropria: true,
  },

  {
    slug: 'agregado',
    rotulo: 'Cadastro Agregado',
    rotuloCurto: 'Agregado',
    icone: 'groups',
    iconePainel: 'query_stats',
    descricao: 'Cadastro de agregados. Campos específicos a definir.',
    tabela: 'solicitacoes_agregado',
    viewFormulario: null, // usa a tela genérica
    viewPainel: null, // usa o painel genérico
    dominioExigido: null, // agregado é externo: qualquer domínio
    somenteAdmin: false,
    apiPropria: false,
  },

  {
    slug: 'candidato',
    rotulo: 'Cadastro Candidato',
    rotuloCurto: 'Candidato',
    icone: 'person',
    iconePainel: 'leaderboard',
    descricao: 'Candidatos interessados em trabalhar na empresa.',
    tabela: 'solicitacoes_candidato',
    viewFormulario: null,
    viewPainel: null,
    dominioExigido: null, // candidato é externo
    somenteAdmin: false,
    apiPropria: false,
  },
];

/** Todos os slugs, na ordem em que aparecem no menu. */
const SLUGS = MODULOS.map((m) => m.slug);

/** Busca um módulo pelo slug. Devolve null se não existir. */
function acharModulo(slug) {
  const s = String(slug || '').toLowerCase();
  return MODULOS.find((m) => m.slug === s) || null;
}

/** Caminho da página do formulário. */
function rotaFormulario(slug) {
  return `/cadastro/${slug}`;
}

/** Caminho da página do painel de acompanhamento. */
function rotaPainel(slug) {
  return `/painel/${slug}`;
}

/**
 * Confere se o e-mail atende à restrição de domínio do módulo.
 * Módulo sem `dominioExigido` aceita qualquer e-mail.
 */
function dominioPermitido(modulo, email) {
  if (!modulo || !modulo.dominioExigido) return true;
  const e = String(email || '').trim().toLowerCase();
  return e.endsWith('@' + modulo.dominioExigido.toLowerCase());
}

module.exports = {
  MODULOS,
  SLUGS,
  acharModulo,
  rotaFormulario,
  rotaPainel,
  dominioPermitido,
};
