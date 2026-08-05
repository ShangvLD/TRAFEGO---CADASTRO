/* ============================================================================
   O fluxo de análise de um cadastro, em um lugar só

   O caminho real do trabalho tem duas etapas, nesta ordem:

     1. PESQUISA RDO   consulta interna, feita antes de acionar ninguém.
                       Reprovou? O cadastro morre aqui — não vai às
                       gerenciadoras, e o comprovante da reprovação é exigido.
     2. GERENCIADORAS  decisão por cliente (Mercado Livre, Shopee, ...).

   POR QUE UM MÓDULO SÓ: a regra "aprovado depende de todos" já vivia em
   solicitacoes.js, e o RDO acrescenta uma condição ANTES dela. Espalhar isso
   entre a rota, a tela e a camada de dados é como esse tipo de regra vira
   três versões que discordam. Aqui é uma função pura: recebe o estado,
   devolve em que ponto o cadastro está e o que falta para seguir.

   ESCALAR DAQUI: uma etapa nova é uma entrada em ETAPAS e um caso em
   situacaoDe(). Nem a tela nem as rotas precisam saber quantas etapas existem
   — elas perguntam "e agora?" e recebem a resposta.
   ========================================================================== */

/**
 * Estados possíveis de um cadastro. O rótulo fica junto do código para a tela
 * não manter uma segunda tabela de nomes que envelhece separada.
 */
const SITUACOES = {
  aguardando_rdo: {
    rotulo: 'Aguardando RDO',
    cor: 'espera',
    ajuda: 'Faça a pesquisa no RDO antes de acionar as gerenciadoras.',
  },
  reprovado_rdo: {
    rotulo: 'Reprovado no RDO',
    cor: 'reprovado',
    ajuda: 'Reprovado na pesquisa interna. Não segue para as gerenciadoras.',
  },
  em_analise: {
    rotulo: 'Em análise',
    cor: 'espera',
    ajuda: 'RDO liberado. Falta decidir os clientes.',
  },
  aprovado: {
    rotulo: 'Aprovado',
    cor: 'aprovado',
    ajuda: 'Aprovado em todos os clientes.',
  },
  reprovado: {
    rotulo: 'Reprovado',
    cor: 'reprovado',
    ajuda: 'Reprovado em todos os clientes.',
  },
  aprovado_em_parte: {
    rotulo: 'Aprovado em parte',
    cor: 'meio-termo',
    ajuda: 'Aprovado em alguns clientes e reprovado em outros.',
  },
};

/** Tipo do documento que comprova a reprovação no RDO. */
const DOC_RDO = 'RESULTADO RDO';

/**
 * Em que ponto o cadastro está.
 *
 * @param rdoAprovado  null = não pesquisado, true/false = resultado
 * @param clientes     lista de clientes da solicitação
 * @param decisoes     { cliente: { status } }
 * @returns { situacao, rotulo, finalizado, podeDecidirClientes, falta }
 */
function situacaoDe({ rdoAprovado, clientes = [], decisoes = {} }) {
  // ---- Etapa 1: RDO ----
  if (rdoAprovado === null || rdoAprovado === undefined) {
    return montar('aguardando_rdo', {
      finalizado: false,
      podeDecidirClientes: false,
      falta: ['Responder "RDO aprovado?"'],
    });
  }

  if (rdoAprovado === false) {
    // Reprovado no RDO é decisão final: as gerenciadoras não são acionadas, e
    // qualquer decisão por cliente que já existisse deixa de valer.
    return montar('reprovado_rdo', {
      finalizado: true,
      podeDecidirClientes: false,
      falta: [],
    });
  }

  // ---- Etapa 2: gerenciadoras ----
  const semDecisao = clientes.filter((c) => !decisoes[c] || !decisoes[c].status);
  if (!clientes.length) {
    return montar('em_analise', {
      finalizado: false,
      podeDecidirClientes: true,
      falta: ['Nenhum cliente informado neste cadastro'],
    });
  }
  if (semDecisao.length) {
    return montar('em_analise', {
      finalizado: false,
      podeDecidirClientes: true,
      falta: semDecisao.map((c) => `Decidir ${c}`),
    });
  }

  const aprov = clientes.filter((c) => decisoes[c].status === 'aprovado').length;
  const chave = aprov === clientes.length ? 'aprovado' : aprov === 0 ? 'reprovado' : 'aprovado_em_parte';

  return montar(chave, { finalizado: true, podeDecidirClientes: true, falta: [] });
}

function montar(situacao, extra) {
  const s = SITUACOES[situacao];
  return { situacao, rotulo: s.rotulo, cor: s.cor, ajuda: s.ajuda, ...extra };
}

/**
 * O que impede de registrar o resultado do RDO.
 *
 * A reprovação exige o comprovante ANEXADO ANTES: gravar primeiro e cobrar o
 * anexo depois deixaria cadastros reprovados sem prova, e é exatamente esse
 * registro que uma auditoria vai procurar.
 *
 * @param temComprovante  já existe documento do tipo DOC_RDO?
 * @returns null quando pode gravar, ou a mensagem do impedimento
 */
function impedimentoParaRdo({ aprovado, temComprovante }) {
  if (aprovado !== true && aprovado !== false) {
    return 'Responda se o RDO foi aprovado.';
  }
  if (aprovado === false && !temComprovante) {
    return `Anexe o resultado do RDO ("${DOC_RDO}") antes de reprovar.`;
  }
  return null;
}

/**
 * Status legado (a coluna "status", que só aceita três valores) a partir da
 * situação. Existe porque a coluna tem CHECK e outras telas ainda a leem.
 */
function statusLegadoDe(situacao) {
  if (situacao === 'aprovado') return 'aprovado';
  if (situacao === 'reprovado' || situacao === 'reprovado_rdo') return 'reprovado';
  return 'pendente';
}

module.exports = {
  SITUACOES,
  DOC_RDO,
  situacaoDe,
  impedimentoParaRdo,
  statusLegadoDe,
};
