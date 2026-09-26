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
const fluxo = require('./fluxo');

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
    // rdo_aprovado é integer no banco (1/0/NULL); aqui vira o booleano que o
    // resto do código espera. Nos módulos sem RDO fica sempre null, e a tela
    // simplesmente não desenha o bloco.
    rdo: {
      aprovado:
        linha.rdo_aprovado === null || linha.rdo_aprovado === undefined
          ? null
          : Number(linha.rdo_aprovado) === 1,
      por: linha.rdo_por || null,
      em: linha.rdo_em || null,
      obs: linha.rdo_obs || null,
    },
  };
}

function criarCamada(tabelaBruta, slugDoModulo, { temRdo = false } = {}) {
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

  /**
   * Registra o resultado da pesquisa no RDO.
   *
   * Só faz sentido nos módulos que passam por essa etapa (temRdo). As
   * exigências da reprovação (motivo e comprovante) são conferidas por
   * fluxo.impedimentoParaRdo, AQUI e não só na rota: um "reprovado" gravado
   * sem prova e sem motivo é exatamente o registro que falta quando alguém
   * audita a decisão meses depois.
   */
  async function registrarRdo(id, { aprovado, observacao, por, temComprovante }) {
    if (!temRdo) return { ok: false, erro: 'Este formulário não passa por pesquisa RDO.' };

    const impedimento = fluxo.impedimentoParaRdo({ aprovado, temComprovante, observacao });
    if (impedimento) return { ok: false, erro: impedimento };

    const atual = await buscarPorId(id);
    if (!atual) return { ok: false, erro: 'Solicitação não encontrada.' };

    // Reprovar no RDO encerra o cadastro, então o status vai junto. Aprovar
    // apenas LIBERA a decisão — e devolve o status a pendente, porque a
    // decisão em si ainda não foi tomada.
    const status = aprovado === false ? 'reprovado' : 'pendente';

    await db
      .prepare(
        `UPDATE ${tabela}
            SET rdo_aprovado = ?, rdo_por = ?, rdo_em = ?, rdo_obs = ?,
                status = ?, revisado_por = ?,
                revisado_em = datetime('now', 'localtime')
          WHERE id = ?`
      )
      .run(aprovado ? 1 : 0, por || null, null, observacao || null, status, por || null, id);

    // rdo_em recebe o MESMO carimbo que revisado_em, lido de volta do banco:
    // gerar a data aqui usaria o relógio do servidor da aplicação, que no
    // Vercel não é o mesmo do Postgres.
    await db
      .prepare(`UPDATE ${tabela} SET rdo_em = revisado_em WHERE id = ?`)
      .run(id);

    return { ok: true, solicitacao: await buscarPorId(id) };
  }

  /** Registra a decisão do responsável. Devolve null se o id não existir. */
  async function registrarDecisao(id, { status, observacao, revisadoPor }) {
    if (!['aprovado', 'reprovado', 'pendente'].includes(status)) {
      throw new Error(`Status inválido: "${status}"`);
    }

    // Nos módulos com RDO, a decisão vem DEPOIS da pesquisa. Barrar aqui, e
    // não só escondendo o botão: a rota aceita POST de qualquer cliente, e é
    // a ordem das etapas que dá sentido ao registro.
    if (temRdo) {
      const atual = await buscarPorId(id);
      if (!atual) return null;
      const rdo = atual.rdo || {};
      if (rdo.aprovado === null || rdo.aprovado === undefined) {
        return { erro: 'Responda a pesquisa do RDO antes de decidir este cadastro.' };
      }
      if (rdo.aprovado === false) {
        return { erro: 'Cadastro reprovado no RDO. Não há decisão a tomar.' };
      }
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
    // Os documentos não têm mais chave estrangeira para esta tabela (a coluna
    // serve os três módulos), então a cascata é feita aqui. Sem isso, excluir
    // uma solicitação deixaria os arquivos órfãos no storage, pagos e invisíveis.
    if (slugDoModulo) {
      await require('./documentos').excluirDaSolicitacao(slugDoModulo, id);
      await require('./atendimentos').excluirDaSolicitacao(slugDoModulo, id);
      // O teste prático também não tem FK (a tabela serve os três módulos), e
      // ele guarda nome e julgamento de uma pessoa — não pode ficar órfão.
      await require('./teste-pratico').excluirDaSolicitacao(slugDoModulo, id);
    }
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
    temRdo,
    registrarRdo,
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
