/* ============================================================================
   Teste prático de direção do candidato

   O que é: durante a seleção, alguém do time coloca o candidato para dirigir e
   avalia direção e manobra. Hoje isso vive em papel e em conversa — o
   resultado chega ao analista como "o Fulano foi bem", sem critério e sem
   quem disse.

   POR QUE SÓ CANDIDATO: terceiro e agregado chegam com o motorista já
   contratado por outra empresa. Avaliar a direção deles não é etapa do
   cadastro, é etapa da CONTRATAÇÃO — e é por isso que a regra não é "esconder
   o botão": não existe teste para eles, nem para criar, nem para consultar.

   A permissão de ter teste é lida de src/modulos.js (temTestePratico), e não
   de uma lista aqui. Assim ligar o teste em outro módulo é uma chave, e a
   rota, o botão e a validação passam a existir juntos — em vez de três
   lugares que podem discordar.

   ESCALAR DAQUI:
     critério novo   uma entrada em SECOES. O formulário, a validação e o
                     cálculo do desempenho acompanham sozinhos, porque todos
                     leem esta mesma lista.
     reteste         a coluna "tentativa" já existe. Hoje o sistema mexe
                     sempre na mais alta; abrir uma nova é um INSERT com
                     tentativa + 1, e historico() já devolve todas.
   ========================================================================== */

const db = require('./db');
const { acharModulo } = require('./modulos');

// ---------------------------------------------------------------------------
// A ficha de avaliação
// ---------------------------------------------------------------------------

/**
 * Os quatro conceitos. A "nota" não é mostrada ao avaliador: serve para
 * resumir o desempenho numa frase ("3,5 de 4") sem obrigar quem lê o painel a
 * abrir os oito critérios um a um.
 */
const CONCEITOS = [
  { id: 'excelente', rotulo: 'Excelente', nota: 4, cor: 'is-success' },
  { id: 'bom', rotulo: 'Bom', nota: 3, cor: 'is-info' },
  { id: 'regular', rotulo: 'Regular', nota: 2, cor: 'is-warning' },
  { id: 'insatisfatorio', rotulo: 'Insatisfatório', nota: 1, cor: 'is-danger' },
];

const SECOES = [
  {
    id: 'direcao',
    titulo: 'Avaliação de direção',
    icone: 'directions_car',
    criterios: [
      { id: 'conducao_veiculo', rotulo: 'Condução do veículo' },
      { id: 'controle_veiculo', rotulo: 'Controle do veículo' },
      { id: 'regras_transito', rotulo: 'Respeito às regras de trânsito' },
      { id: 'conducao_defensiva', rotulo: 'Condução defensiva' },
    ],
  },
  {
    id: 'manobra',
    titulo: 'Avaliação de manobra',
    icone: 'sync_alt',
    criterios: [
      { id: 'controle_manobras', rotulo: 'Controle em manobras' },
      { id: 'baliza_re', rotulo: 'Baliza / manobra de ré' },
      { id: 'percepcao_espaco', rotulo: 'Percepção de espaço' },
      { id: 'controle_durante_manobras', rotulo: 'Controle do veículo durante manobras' },
    ],
  },
];

/**
 * Os três resultados possíveis.
 *
 * "Aprovado com ressalvas" e "Reprovado" exigem justificativa porque são os
 * dois que alguém vai questionar depois — e a resposta "não lembro por quê" é
 * o que faz o registro não valer nada.
 */
const RESULTADOS = [
  { id: 'aprovado', rotulo: 'Aprovado', cor: 'is-success', icone: 'check_circle', exigeJustificativa: false },
  {
    id: 'aprovado_ressalvas',
    rotulo: 'Aprovado com ressalvas',
    cor: 'is-parcial',
    icone: 'error',
    exigeJustificativa: true,
  },
  { id: 'reprovado', rotulo: 'Reprovado', cor: 'is-danger', icone: 'cancel', exigeJustificativa: true },
];

/** Todos os critérios, achatados, na ordem em que aparecem na ficha. */
const TODOS_CRITERIOS = SECOES.flatMap((s) =>
  s.criterios.map((c) => ({ ...c, secao: s.id, secaoTitulo: s.titulo }))
);

const acharConceito = (id) => CONCEITOS.find((c) => c.id === id) || null;
const acharResultado = (id) => RESULTADOS.find((r) => r.id === id) || null;
const acharCriterio = (id) => TODOS_CRITERIOS.find((c) => c.id === id) || null;

/** A ficha inteira, para a tela se desenhar sem repetir a lista de critérios. */
function configuracao() {
  return { conceitos: CONCEITOS, secoes: SECOES, resultados: RESULTADOS };
}

// ---------------------------------------------------------------------------
// Quem tem teste
// ---------------------------------------------------------------------------

/**
 * Este módulo aplica teste prático?
 *
 * Chamada nas rotas, na gravação e na leitura — as três. Barrar só na tela
 * deixaria o POST aberto a quem monta a requisição na mão, e gravar teste de
 * agregado é exatamente o dado que ninguém saberia interpretar depois.
 */
function permite(slug) {
  const m = acharModulo(slug);
  return !!(m && m.temTestePratico);
}

/** Erro padrão de módulo sem teste, para as rotas responderem igual. */
const ERRO_SEM_TESTE = 'Este formulário não tem teste prático.';

// ---------------------------------------------------------------------------
// Estado do teste (o que o ícone e o selo mostram)
// ---------------------------------------------------------------------------

/**
 * Em que ponto está o teste, em uma forma que a tela só exibe.
 *
 * Os cinco estados do pedido viram quatro aqui porque "preenchido" e
 * "aprovado/reprovado" são a mesma coisa: finalizado sem resultado não pode
 * existir (a validação impede), então um selo "preenchido" mostraria um
 * estado que o sistema nunca produz.
 */
function estadoDe(teste) {
  if (!teste) {
    return {
      estado: 'nao_realizado',
      rotulo: 'Teste prático',
      curto: 'Não realizado',
      cor: 'is-warning',
      icone: 'assignment',
      ajuda: 'Teste prático ainda não aplicado.',
    };
  }
  if (teste.status !== 'finalizado') {
    return {
      estado: 'rascunho',
      rotulo: 'Teste em andamento',
      curto: 'Em andamento',
      cor: 'is-info',
      icone: 'edit_note',
      ajuda: 'Rascunho salvo. Falta finalizar.',
    };
  }
  const r = acharResultado(teste.resultado);
  return {
    estado: teste.resultado,
    rotulo: r ? 'Teste ' + r.rotulo.toLowerCase() : 'Teste realizado',
    curto: r ? r.rotulo : 'Realizado',
    cor: r ? r.cor : 'is-success',
    icone: r ? r.icone : 'task_alt',
    ajuda: r ? `Teste finalizado: ${r.rotulo}.` : 'Teste finalizado.',
  };
}

/**
 * Média dos conceitos dados, de 1 a 4.
 *
 * Critério ainda em branco fica FORA da conta, em vez de valer zero: um
 * rascunho pela metade mostraria um desempenho péssimo que ninguém avaliou.
 */
function desempenhoDe(avaliacoes) {
  const notas = Object.entries(avaliacoes || {})
    .filter(([id]) => acharCriterio(id))
    .map(([, v]) => acharConceito(v))
    .filter(Boolean)
    .map((c) => c.nota);

  if (!notas.length) return null;
  const media = notas.reduce((a, b) => a + b, 0) / notas.length;
  return {
    media: Math.round(media * 100) / 100,
    maximo: 4,
    respondidos: notas.length,
    total: TODOS_CRITERIOS.length,
    texto: `${media.toFixed(1).replace('.', ',')} de 4`,
  };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

function lerJson(texto, padrao) {
  if (!texto) return padrao;
  try {
    const v = JSON.parse(texto);
    return v && typeof v === 'object' ? v : padrao;
  } catch {
    return padrao;
  }
}

/** Acrescenta à linha o que as telas consomem: avaliações, estado, desempenho. */
function hidratar(linha) {
  if (!linha) return null;
  const avaliacoes = lerJson(linha.avaliacoes, {});
  return {
    ...linha,
    avaliacoes,
    estado: estadoDe(linha),
    desempenho: desempenhoDe(avaliacoes),
    // O que falta para finalizar, já resolvido aqui: a tela mostra a lista sem
    // reimplementar a regra, e o que ela mostra é o mesmo que o servidor cobra.
    pendencias: pendenciasDe({
      avaliacoes,
      resultado: linha.resultado,
      justificativa: linha.justificativa,
    }),
  };
}

/** O teste ATUAL de uma solicitação (a tentativa mais alta), ou null. */
async function atual(modulo, solicitacaoId) {
  if (!permite(modulo)) return null;
  const linha = await db
    .prepare(
      `SELECT * FROM testes_praticos
        WHERE modulo = ? AND solicitacao_id = ?
        ORDER BY tentativa DESC
        LIMIT 1`
    )
    .get(modulo, solicitacaoId);
  return hidratar(linha);
}

/** Todas as tentativas, da mais antiga para a mais recente. */
async function historico(modulo, solicitacaoId) {
  if (!permite(modulo)) return [];
  const linhas = await db
    .prepare(
      `SELECT * FROM testes_praticos
        WHERE modulo = ? AND solicitacao_id = ?
        ORDER BY tentativa`
    )
    .all(modulo, solicitacaoId);
  return linhas.map(hidratar);
}

/**
 * Estado do teste de VÁRIAS solicitações, para a listagem do painel.
 *
 * Uma consulta só, como em atendimentos.resumoDeVarias: o painel desenha
 * dezenas de linhas e se atualiza sozinho, e uma consulta por linha seria
 * dezenas de idas ao banco a cada verificação.
 *
 * DISTINCT ON traz a tentativa mais alta de cada solicitação — é a que o
 * ícone representa; as anteriores são histórico.
 */
async function resumoDeVarias(modulo, ids) {
  if (!permite(modulo)) return {};
  const lista = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!lista.length) return {};

  const linhas = await db
    .prepare(
      `SELECT DISTINCT ON (solicitacao_id)
              solicitacao_id, tentativa, status, resultado, avaliacoes,
              avaliador_nome, atualizado_em, finalizado_em
         FROM testes_praticos
        WHERE modulo = ? AND solicitacao_id = ANY(?)
        ORDER BY solicitacao_id, tentativa DESC`
    )
    .all(modulo, lista);

  const mapa = {};
  for (const l of linhas) {
    mapa[l.solicitacao_id] = {
      tentativa: l.tentativa,
      status: l.status,
      resultado: l.resultado,
      avaliador: l.avaliador_nome,
      em: l.finalizado_em || l.atualizado_em,
      estado: estadoDe(l),
      desempenho: desempenhoDe(lerJson(l.avaliacoes, {})),
    };
  }
  return mapa;
}

// ---------------------------------------------------------------------------
// Validação
// ---------------------------------------------------------------------------

/** Texto limpo, ou null. */
function texto(v, max) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return null;
  return max && t.length > max ? t.slice(0, max) : t;
}

/**
 * Só as notas que existem na ficha e com conceito válido.
 *
 * Filtrar em vez de recusar é de propósito: um critério que deixou de existir
 * não deve travar a gravação de um rascunho antigo — ele simplesmente não faz
 * mais parte da avaliação.
 */
function limparAvaliacoes(entrada) {
  const limpas = {};
  for (const [id, valor] of Object.entries(entrada || {})) {
    if (!acharCriterio(id)) continue;
    if (!acharConceito(valor)) continue;
    limpas[id] = valor;
  }
  return limpas;
}

/**
 * O que falta para FINALIZAR. Lista vazia = pode finalizar.
 *
 * Devolve a pendência por critério, com o rótulo que o avaliador vê na tela —
 * "preencha os campos obrigatórios" não diz qual dos oito ficou em branco.
 */
function pendenciasDe({ avaliacoes, resultado, justificativa }) {
  const faltas = [];

  for (const c of TODOS_CRITERIOS) {
    if (!acharConceito((avaliacoes || {})[c.id])) {
      faltas.push({ campo: c.id, rotulo: c.rotulo, secao: c.secaoTitulo });
    }
  }

  const r = acharResultado(resultado);
  if (!r) {
    faltas.push({ campo: 'resultado', rotulo: 'Resultado do teste', secao: 'Resultado' });
  } else if (r.exigeJustificativa && !texto(justificativa)) {
    faltas.push({
      campo: 'justificativa',
      rotulo: `Justificativa (obrigatória para "${r.rotulo}")`,
      secao: 'Resultado',
    });
  }

  return faltas;
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

/**
 * Salva o teste da solicitação — rascunho ou finalizado.
 *
 * Mexe sempre na tentativa mais alta: clicar de novo no ícone reabre o mesmo
 * teste em vez de criar outro. Um teste finalizado continua editável por quem
 * acompanha o painel (corrigir engano sem mexer no banco), e a correção fica
 * registrada em avaliador/atualizado_em.
 *
 * @param opcoes.finalizar  true = cobra a ficha completa; false = rascunho.
 * @returns { ok, teste } | { ok: false, erro, pendencias }
 */
async function salvar(modulo, solicitacaoId, entrada = {}, usuario = {}) {
  if (!permite(modulo)) return { ok: false, erro: ERRO_SEM_TESTE };

  const avaliacoes = limparAvaliacoes(entrada.avaliacoes);
  const resultado = acharResultado(entrada.resultado) ? entrada.resultado : null;
  const justificativa = texto(entrada.justificativa, 2000);
  const observacoes = texto(entrada.observacoes, 4000);
  const veiculo = texto(entrada.veiculo, 200);
  const dataTeste = texto(entrada.data_teste || entrada.dataTeste, 10);
  const finalizar = !!entrada.finalizar;

  if (dataTeste && !/^\d{4}-\d{2}-\d{2}$/.test(dataTeste)) {
    return { ok: false, erro: 'Data do teste inválida.' };
  }

  if (finalizar) {
    const pendencias = pendenciasDe({ avaliacoes, resultado, justificativa });
    if (pendencias.length) {
      return {
        ok: false,
        erro: 'O teste está incompleto e não pode ser finalizado.',
        pendencias,
      };
    }
  }

  const existente = await db
    .prepare(
      `SELECT id, tentativa FROM testes_praticos
        WHERE modulo = ? AND solicitacao_id = ?
        ORDER BY tentativa DESC
        LIMIT 1`
    )
    .get(modulo, solicitacaoId);

  const status = finalizar ? 'finalizado' : 'rascunho';
  const avaliacoesJson = Object.keys(avaliacoes).length ? JSON.stringify(avaliacoes) : null;

  if (existente) {
    await db
      .prepare(
        `UPDATE testes_praticos
            SET status = ?, avaliacoes = ?, observacoes = ?, resultado = ?,
                justificativa = ?, veiculo = ?, data_teste = ?,
                avaliador_id = ?, avaliador_nome = ?, avaliador_email = ?,
                atualizado_em = datetime('now', 'localtime'),
                -- Um teste que volta a rascunho perde a data de finalização:
                -- mantê-la diria que foi concluído em um dia em que não foi.
                finalizado_em = CASE WHEN ? = 'finalizado'
                                     THEN COALESCE(finalizado_em, datetime('now', 'localtime'))
                                     ELSE NULL END
          WHERE id = ?`
      )
      .run(
        status,
        avaliacoesJson,
        observacoes,
        resultado,
        justificativa,
        veiculo,
        dataTeste,
        usuario.id || null,
        usuario.nome || null,
        usuario.email || null,
        status,
        existente.id
      );
  } else {
    await db
      .prepare(
        `INSERT INTO testes_praticos
           (modulo, solicitacao_id, tentativa, status, avaliacoes, observacoes,
            resultado, justificativa, veiculo, data_teste,
            avaliador_id, avaliador_nome, avaliador_email, finalizado_em)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 CASE WHEN ? = 'finalizado' THEN datetime('now', 'localtime') ELSE NULL END)`
      )
      .run(
        modulo,
        solicitacaoId,
        status,
        avaliacoesJson,
        observacoes,
        resultado,
        justificativa,
        veiculo,
        dataTeste,
        usuario.id || null,
        usuario.nome || null,
        usuario.email || null,
        status
      );
  }

  return { ok: true, teste: await atual(modulo, solicitacaoId) };
}

/**
 * Apaga os testes de uma solicitação excluída.
 *
 * Chamado pela cascata em código (a tabela não tem FK, porque ela teria de
 * apontar para três tabelas diferentes). Sem isto, excluir um candidato
 * deixaria a avaliação dele órfã — e ela guarda nome e julgamento de pessoa.
 */
async function excluirDaSolicitacao(modulo, solicitacaoId) {
  const info = await db
    .prepare('DELETE FROM testes_praticos WHERE modulo = ? AND solicitacao_id = ?')
    .run(modulo, solicitacaoId);
  return info.changes || 0;
}

module.exports = {
  CONCEITOS,
  SECOES,
  RESULTADOS,
  TODOS_CRITERIOS,
  ERRO_SEM_TESTE,
  configuracao,
  permite,
  estadoDe,
  desempenhoDe,
  pendenciasDe,
  atual,
  historico,
  resumoDeVarias,
  salvar,
  excluirDaSolicitacao,
};
