/* ============================================================================
   Camada de dados genérica de um módulo de cadastro

   Uma fábrica: `criarCamada('solicitacoes_agregado')` devolve o conjunto de
   funções de acesso àquela tabela. Como todas as tabelas de módulo têm a mesma
   forma (ver tabelaDeModulo em src/db.js), o mesmo código serve a agregado,
   candidato e aos módulos futuros — acrescentar um módulo não exige escrever
   camada de dados nova.

   O nome da tabela NUNCA vem de requisição: é sempre lido de src/modulos.js,
   que é código. Se viesse do usuário, seria injeção de SQL, porque nome de
   tabela não pode ser parametrizado (só valores podem).

   NOTA SOBRE O MÓDULO TERCEIRO: ele continua em src/solicitacoes.js, que tem
   lógica específica (operações por cliente, decisão individual, anexos do
   Forms). Migrá-lo para esta fábrica é possível e desejável, mas seria mexer no
   único fluxo em produção — fica para depois de os módulos novos estarem
   validados.
   ========================================================================== */

const db = require('./db');

/** Nome de tabela válido: só letras minúsculas, números e "_". */
function validarNomeDeTabela(tabela) {
  if (!/^[a-z_][a-z0-9_]*$/.test(String(tabela || ''))) {
    throw new Error(`Nome de tabela inválido: "${tabela}"`);
  }
  return tabela;
}

/**
 * Lê o JSON de uma coluna de texto. Devolve o padrão quando vazio ou inválido —
 * dado malformado não deve derrubar a listagem inteira.
 */
function lerJson(texto, padrao) {
  if (!texto) return padrao;
  try {
    const v = JSON.parse(texto);
    return v == null ? padrao : v;
  } catch {
    return padrao;
  }
}

/**
 * Acrescenta à linha os campos derivados que o front espera:
 *   anexos  -> array  (da coluna JSON)
 *   dados   -> objeto (campos específicos do módulo, definidos depois)
 *   decisoes-> objeto
 */
function hidratar(linha) {
  if (!linha) return linha;
  return {
    ...linha,
    anexos: lerJson(linha.anexos, []),
    dados: lerJson(linha.dados, {}),
    decisoes: lerJson(linha.decisoes, {}),
  };
}

function criarCamada(tabelaBruta) {
  const tabela = validarNomeDeTabela(tabelaBruta);

  /** Lista tudo, mais recente primeiro. */
  async function listar() {
    const linhas = await db
      .prepare(`SELECT * FROM ${tabela} ORDER BY criado_em DESC, id DESC`)
      .all();
    return linhas.map(hidratar);
  }

  /** Lista as solicitações de um e-mail (acompanhamento do próprio usuário). */
  async function listarPorEmail(email) {
    const linhas = await db
      .prepare(
        `SELECT * FROM ${tabela}
          WHERE lower(solicitante_email) = lower(?)
          ORDER BY criado_em DESC, id DESC`
      )
      .all(email);
    return linhas.map(hidratar);
  }

  async function buscarPorId(id) {
    return hidratar(await db.prepare(`SELECT * FROM ${tabela} WHERE id = ?`).get(id));
  }

  async function buscarPorOrigemId(origemId) {
    if (!origemId) return null;
    return hidratar(await db.prepare(`SELECT * FROM ${tabela} WHERE origem_id = ?`).get(origemId));
  }

  /**
   * Cria uma solicitação.
   *
   * `assunto` é o resumo que aparece na lista do painel; `dados` guarda os
   * campos específicos do módulo (a definir). Enquanto os campos não existirem,
   * um cadastro mínimo já entra e já pode ser aprovado — que é o que a
   * estrutura base precisa oferecer.
   */
  async function criar({
    solicitante_nome,
    solicitante_email,
    assunto,
    detalhes,
    anexos,
    dados,
    origem,
    origem_id,
  }) {
    const info = await db
      .prepare(
        `INSERT INTO ${tabela}
           (solicitante_nome, solicitante_email, assunto, detalhes, anexos, dados, origem, origem_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`
      )
      .run(
        solicitante_nome,
        solicitante_email,
        assunto,
        detalhes || null,
        anexos && anexos.length ? JSON.stringify(anexos) : null,
        dados && Object.keys(dados).length ? JSON.stringify(dados) : null,
        origem || 'portal',
        origem_id || null
      );
    return buscarPorId(info.lastInsertRowid);
  }

  /** Registra a decisão do responsável. Devolve null se o id não existir. */
  async function registrarDecisao(id, { status, observacao, revisadoPor }) {
    if (!['aprovado', 'reprovado', 'pendente'].includes(status)) {
      throw new Error(`Status inválido: "${status}"`);
    }
    const info = await db
      .prepare(
        `UPDATE ${tabela}
            SET status = ?, observacao = ?, revisado_por = ?,
                revisado_em = datetime('now', 'localtime')
          WHERE id = ?`
      )
      .run(status, observacao || null, revisadoPor || null, id);

    if (info.changes === 0) return null;
    return buscarPorId(id);
  }

  async function excluir(id) {
    const info = await db.prepare(`DELETE FROM ${tabela} WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  /** Contagem por status, para os indicadores do painel. */
  async function contarPorStatus() {
    const linhas = await db
      .prepare(`SELECT status, count(*)::int AS n FROM ${tabela} GROUP BY status`)
      .all();

    const resumo = { total: 0, pendente: 0, aprovado: 0, reprovado: 0 };
    for (const l of linhas) {
      resumo[l.status] = l.n;
      resumo.total += l.n;
    }
    return resumo;
  }

  /**
   * "Impressão digital" da lista, para o painel se atualizar sozinho sem
   * baixar tudo a cada verificação (mesma técnica do módulo terceiro).
   */
  async function versao() {
    const r = await db
      .prepare(
        `SELECT count(*)::int              AS total,
                COALESCE(max(id), 0)       AS max_id,
                COALESCE(max(revisado_em), '') AS max_revisado
           FROM ${tabela}`
      )
      .get();
    return {
      total: r ? r.total : 0,
      maxId: r ? Number(r.max_id) : 0,
      maxRevisado: r ? r.max_revisado : '',
    };
  }

  return {
    tabela,
    listar,
    listarPorEmail,
    buscarPorId,
    buscarPorOrigemId,
    criar,
    registrarDecisao,
    excluir,
    contarPorStatus,
    versao,
  };
}

module.exports = { criarCamada, hidratar };
