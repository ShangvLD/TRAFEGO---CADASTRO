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
    ajuda: 'Enviado. Ninguém assumiu ainda.',
  },
  em_andamento: {
    rotulo: 'Em andamento',
    cor: 'andamento',
    ajuda: 'Alguém assumiu e está conduzindo o cadastro.',
  },
  pendente_shopee: {
    rotulo: 'Pendente Shopee',
    cor: 'externo',
    ajuda: 'Aguardando aprovação da Shopee. Sem cadastro prévio, o retorno pode levar até 24 horas.',
  },
  pendente_amazon: {
    rotulo: 'Pendente Amazon',
    cor: 'externo',
    ajuda: 'Aguardando retorno da Amazon.',
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
function situacaoDe({ rdoAprovado, clientes = [], decisoes = {}, assumido = false }) {
  // ---- Etapa 0: ninguém pegou ainda ----
  //
  // Vem ANTES do RDO de propósito. "Aguardando RDO" descreve uma pesquisa que
  // alguém precisa fazer — dito de um cadastro que ninguém assumiu, sugere que
  // o trabalho está em curso quando ele nem saiu da fila. Quem envia precisa
  // enxergar essa diferença: um está parado esperando gente, o outro já tem
  // dono e espera uma ação dele.
  if (!assumido) {
    return montar('em_analise', {
      finalizado: false,
      podeDecidirClientes: false,
      falta: ['Alguém assumir o atendimento'],
    });
  }

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
    return montar(assumido ? 'em_andamento' : 'em_analise', {
      finalizado: false,
      podeDecidirClientes: true,
      falta: ['Nenhum cliente informado neste cadastro'],
    });
  }
  if (semDecisao.length) {
    // Falta SÓ um cliente externo? Então a espera não é nossa, e dizer isso
    // muda o que a pessoa faz: cobrar internamente não adianta. Só vale
    // quando ele é o ÚNICO pendente — com outros em aberto, o gargalo é aqui.
    const pendencia = pendenciaExterna(semDecisao);
    if (pendencia) {
      return montar(pendencia, {
        finalizado: false,
        podeDecidirClientes: true,
        falta: semDecisao.map((c) => `Decidir ${c}`),
      });
    }
    return montar(assumido ? 'em_andamento' : 'em_analise', {
      finalizado: false,
      podeDecidirClientes: true,
      falta: semDecisao.map((c) => `Decidir ${c}`),
    });
  }

  const aprov = clientes.filter((c) => decisoes[c].status === 'aprovado').length;
  const chave = aprov === clientes.length ? 'aprovado' : aprov === 0 ? 'reprovado' : 'aprovado_em_parte';

  return montar(chave, { finalizado: true, podeDecidirClientes: true, falta: [] });
}

/**
 * O que sobrou para decidir é só um cliente de retorno externo?
 *
 * SHOPEE e AMAZON dependem de terceiros, e o cadastro fica parado esperando
 * gente de fora. Separar isso de "em andamento" evita cobrar o time interno
 * por algo que ele não controla — e é a informação que o solicitante quer.
 */
const EXTERNOS = { SHOPEE: 'pendente_shopee', AMAZON: 'pendente_amazon' };

function pendenciaExterna(semDecisao) {
  if (!semDecisao.length) return null;
  const chaves = [...new Set(semDecisao.map((c) => String(c).trim().toUpperCase()))];
  if (chaves.length !== 1) return null; // mais de um pendente: o gargalo não é claro
  return EXTERNOS[chaves[0]] || null;
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

/* ===========================================================================
   Previsão de conclusão

   Tempo interno medido pela operação, sem depender de terceiros:

     base            60 min   RDO (30) + Opentech/BRK/Shopee (30)
     item adicional  10 min   cada veículo, placa ou implemento

   O cadastro no Rodopar NÃO entra na conta: acontece em paralelo, enquanto o
   RDO está em análise, então não empurra o total.

   Pendência externa (Shopee sem cadastro prévio, Amazon) fica SEPARADA. Somar
   as 24h ao total faria uma previsão de 25 horas para um trabalho de uma hora
   — e esconderia que o atraso não é interno. A previsão interna continua
   valendo; o que muda é o status.
   =========================================================================== */

const MINUTOS_BASE = 60;
const MINUTOS_POR_ITEM = 10;
const HORAS_ESPERA_EXTERNA = 24;

/** "1 h 20 min", "50 min", "2 h" */
function emTexto(minutos) {
  const m = Math.max(0, Math.round(minutos));
  const h = Math.floor(m / 60);
  const resto = m % 60;
  if (!h) return resto + ' min';
  if (!resto) return h + ' h';
  return h + ' h ' + resto + ' min';
}

/**
 * @param itensAdicionais  quantos veículos/placas/implementos além do motorista
 * @param clientes         para saber se há dependência externa
 */
function previsaoDe({ itensAdicionais = 0, clientes = [] } = {}) {
  const minutos = MINUTOS_BASE + Math.max(0, itensAdicionais) * MINUTOS_POR_ITEM;

  const externos = clientes
    .map((c) => String(c).trim().toUpperCase())
    .filter((c) => EXTERNOS[c]);

  return {
    minutos,
    texto: emTexto(minutos),
    itensAdicionais,
    // A dependência é declarada, não somada.
    externa: externos.length
      ? { clientes: externos, horas: HORAS_ESPERA_EXTERNA,
          texto: 'até ' + HORAS_ESPERA_EXTERNA + ' h (retorno de ' + externos.join(' e ') + ')' }
      : null,
  };
}

/* ===========================================================================
   Tempos de um cadastro
   =========================================================================== */

/** Diferença em minutos entre dois carimbos do banco (UTC, "AAAA-MM-DD HH:MM:SS"). */
function minutosEntre(de, ate) {
  if (!de || !ate) return null;
  const ms = (s) => {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : null;
  };
  const a = ms(de), b = ms(ate);
  if (a == null || b == null) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

/**
 * Os tempos que o solicitante acompanha.
 *
 * "agora" entra como parâmetro em vez de ser lido aqui: assim a função é pura
 * e testável, e o servidor decide qual relógio vale.
 */
function temposDe({ criadoEm, assumidoEm, finalizadoEm, agora, previsaoMin }) {
  const fim = finalizadoEm || agora;

  const paraAssumir = minutosEntre(criadoEm, assumidoEm);
  const operacional = assumidoEm ? minutosEntre(assumidoEm, fim) : null;
  const total = minutosEntre(criadoEm, fim);
  const decorrido = minutosEntre(criadoEm, agora);

  return {
    paraAssumirMin: paraAssumir,
    paraAssumir: paraAssumir == null ? null : emTexto(paraAssumir),
    operacionalMin: operacional,
    operacional: operacional == null ? null : emTexto(operacional),
    totalMin: total,
    total: total == null ? null : emTexto(total),
    decorridoMin: decorrido,
    decorrido: decorrido == null ? null : emTexto(decorrido),
    // Restante só faz sentido enquanto não terminou.
    restanteMin: finalizadoEm || previsaoMin == null || decorrido == null
      ? null
      : Math.max(0, previsaoMin - decorrido),
    atrasado: !finalizadoEm && previsaoMin != null && decorrido != null && decorrido > previsaoMin,
  };
}

module.exports = {
  SITUACOES,
  MINUTOS_BASE,
  MINUTOS_POR_ITEM,
  emTexto,
  previsaoDe,
  minutosEntre,
  temposDe,
  DOC_RDO,
  situacaoDe,
  impedimentoParaRdo,
  statusLegadoDe,
};
