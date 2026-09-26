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
                     cálculo da nota acompanham sozinhos, porque todos
                     leem a mesma lista — ver src/ficha-teste.js.
     reteste         a coluna "tentativa" já existe. Hoje o sistema mexe
                     sempre na mais alta; abrir uma nova é um INSERT com
                     tentativa + 1, e historico() já devolve todas.
   ========================================================================== */

const db = require('./db');
const { acharModulo } = require('./modulos');

// A ficha (critérios, conceitos, resultados, pontuação) vive em src/ficha-teste.js,
// que não importa nada — é o que permite o db.js lê-la para gerar a visão de
// leitura sem fechar ciclo com este arquivo. Reexportada abaixo para quem já
// consome este módulo não precisar saber de onde ela vem.
const ficha = require('./ficha-teste');

const {
  CONCEITOS,
  SECOES,
  RESULTADOS,
  TODOS_CRITERIOS,
  NOTA_MAXIMA,
  acharConceito,
  acharResultado,
  acharCriterio,
  configuracao,
  pontuacaoDe,
} = ficha;

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

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/**
 * A nota de uma ficha já gravada.
 *
 * Vale a COLUNA, não o recálculo: a nota gravada é aquela com que o candidato
 * foi julgado, e mudar o peso de um conceito amanhã não pode reescrever o que
 * se decidiu ontem. O recálculo só entra como reserva, para linha gravada
 * antes de a coluna existir.
 *
 * O Postgres devolve numeric como texto (precisão exata), daí o Number().
 */
function notaDaLinha(linha, avaliacoes) {
  const calculada = pontuacaoDe(avaliacoes);
  if (linha.pontuacao == null) return calculada;

  const nota = Number(linha.pontuacao);
  if (!Number.isFinite(nota)) return calculada;

  return {
    nota,
    maximo: NOTA_MAXIMA,
    respondidos: calculada ? calculada.respondidos : 0,
    total: TODOS_CRITERIOS.length,
    parcial: !calculada || calculada.parcial,
    texto: nota.toFixed(1).replace('.', ',') + ' de ' + NOTA_MAXIMA,
  };
}

function lerJson(texto, padrao) {
  if (!texto) return padrao;
  try {
    const v = JSON.parse(texto);
    return v && typeof v === 'object' ? v : padrao;
  } catch {
    return padrao;
  }
}

/** Acrescenta à linha o que as telas consomem: avaliações, estado, nota. */
function hidratar(linha) {
  if (!linha) return null;
  const avaliacoes = lerJson(linha.avaliacoes, {});
  return {
    ...linha,
    avaliacoes,
    estado: estadoDe(linha),
    pontuacao: notaDaLinha(linha, avaliacoes),
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
              solicitacao_id, tentativa, status, resultado, avaliacoes, pontuacao,
              candidato_nome, avaliador_nome, atualizado_em, finalizado_em
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
      candidato: l.candidato_nome,
      avaliador: l.avaliador_nome,
      em: l.finalizado_em || l.atualizado_em,
      estado: estadoDe(l),
      pontuacao: notaDaLinha(l, lerJson(l.avaliacoes, {})),
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

  // A NOTA vai gravada em coluna, e não só calculada na leitura.
  //
  // Duas razões, e a segunda é a que decide: a tabela precisa ser legível e
  // filtrável DIRETO no Supabase ("quem tirou abaixo de 6?"), e ninguém vai
  // recalcular média de JSON em SQL para responder isso. A outra é histórica:
  // se o peso de um conceito mudar amanhã, as fichas antigas mantêm a nota com
  // que foram julgadas — recalcular reescreveria o passado.
  const nota = pontuacaoDe(avaliacoes);
  const pontuacao = nota ? nota.nota : null;

  // Nome e CPF do candidato copiados para cá, de propósito.
  //
  // Normalizado, o certo seria só o solicitacao_id. Mas a tabela existe também
  // para ser LIDA no Supabase, e lá "solicitacao_id = 7" não diz de quem é a
  // avaliação — obrigaria um join a cada consulta. Copiar o identificador de
  // quem foi avaliado é o que torna a tabela legível sozinha.
  const candidatoNome = texto(entrada.candidato_nome, 200);
  const candidatoCpf = texto(entrada.candidato_cpf, 20);

  if (existente) {
    await db
      .prepare(
        `UPDATE testes_praticos
            SET status = ?, avaliacoes = ?, pontuacao = ?, observacoes = ?, resultado = ?,
                justificativa = ?, veiculo = ?, data_teste = ?,
                -- COALESCE: um salvamento que não trouxe o nome (chamada de
                -- teste, script) não apaga o que já estava gravado.
                candidato_nome = COALESCE(?, candidato_nome),
                candidato_cpf  = COALESCE(?, candidato_cpf),
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
        pontuacao,
        observacoes,
        resultado,
        justificativa,
        veiculo,
        dataTeste,
        candidatoNome,
        candidatoCpf,
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
           (modulo, solicitacao_id, tentativa, status, avaliacoes, pontuacao, observacoes,
            resultado, justificativa, veiculo, data_teste,
            candidato_nome, candidato_cpf,
            avaliador_id, avaliador_nome, avaliador_email, finalizado_em)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 CASE WHEN ? = 'finalizado' THEN datetime('now', 'localtime') ELSE NULL END)`
      )
      .run(
        modulo,
        solicitacaoId,
        status,
        avaliacoesJson,
        pontuacao,
        observacoes,
        resultado,
        justificativa,
        veiculo,
        dataTeste,
        candidatoNome,
        candidatoCpf,
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
  pontuacaoDe,
  NOTA_MAXIMA,
  pendenciasDe,
  atual,
  historico,
  resumoDeVarias,
  salvar,
  excluirDaSolicitacao,
};
