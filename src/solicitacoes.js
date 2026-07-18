/* ============================================================================
   Camada de acesso às solicitações de cadastro

   Concentra as consultas da tabela "solicitacoes". Enquanto a integração com
   o Microsoft Forms (Fase 4) não existe, os dados vêm do seed de exemplo.
   ========================================================================== */

const db = require('./db');

/** Lista todas as solicitações, mais recentes primeiro. */
function listar() {
  return db
    .prepare('SELECT * FROM solicitacoes ORDER BY datetime(criado_em) DESC, id DESC')
    .all();
}

/** Lista apenas as solicitações de um e-mail (área do solicitante). */
function listarPorEmail(email) {
  return db
    .prepare(
      `SELECT * FROM solicitacoes
       WHERE solicitante_email = ?
       ORDER BY datetime(criado_em) DESC, id DESC`
    )
    .all(email);
}

/** Busca uma solicitação pelo id. */
function buscarPorId(id) {
  return db.prepare('SELECT * FROM solicitacoes WHERE id = ?').get(id);
}

/** Busca uma solicitação pelo id da resposta do Forms (para evitar duplicar). */
function buscarPorOrigemId(origem_id) {
  if (!origem_id) return null;
  return db.prepare('SELECT * FROM solicitacoes WHERE origem_id = ?').get(origem_id);
}

/**
 * Registra a decisão do responsável (aprovado/reprovado).
 * Retorna a solicitação atualizada, ou null se o id não existir.
 */
function registrarDecisao(id, { status, observacao, revisadoPor }) {
  const info = db
    .prepare(
      `UPDATE solicitacoes
       SET status = ?, observacao = ?, revisado_por = ?, revisado_em = datetime('now', 'localtime')
       WHERE id = ?`
    )
    .run(status, observacao || null, revisadoPor || null, id);

  if (info.changes === 0) return null;
  return buscarPorId(id);
}

/** Cria uma nova solicitação (usado pelo seed, pelo webhook do Forms e por testes). */
function criar({ solicitante_nome, solicitante_email, assunto, detalhes, anexo, origem, origem_id }) {
  const info = db
    .prepare(
      `INSERT INTO solicitacoes
         (solicitante_nome, solicitante_email, assunto, detalhes, anexo, origem, origem_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      solicitante_nome,
      solicitante_email,
      assunto,
      detalhes || null,
      anexo || null,
      origem || null,
      origem_id || null
    );
  return buscarPorId(info.lastInsertRowid);
}

/**
 * Registra uma resposta vinda do Microsoft Forms (encaminhada pelo Power
 * Automate). Se a mesma resposta chegar de novo (mesmo origem_id), não grava
 * de novo — apenas devolve a que já existe.
 *
 * Retorna { solicitacao, duplicada }.
 */
function registrarDoForms(dados) {
  const origem_id = dados.origem_id || null;

  if (origem_id) {
    const existente = buscarPorOrigemId(origem_id);
    if (existente) return { solicitacao: existente, duplicada: true };
  }

  const solicitacao = criar({ ...dados, origem: 'forms', origem_id });
  return { solicitacao, duplicada: false };
}

/** Conta quantas solicitações há em cada status (para os indicadores/KPIs). */
function contarPorStatus() {
  const linhas = db
    .prepare('SELECT status, COUNT(*) AS total FROM solicitacoes GROUP BY status')
    .all();

  const resumo = { total: 0, pendente: 0, aprovado: 0, reprovado: 0 };
  for (const l of linhas) {
    resumo[l.status] = l.total;
    resumo.total += l.total;
  }
  return resumo;
}

module.exports = {
  listar,
  listarPorEmail,
  buscarPorId,
  buscarPorOrigemId,
  registrarDecisao,
  criar,
  registrarDoForms,
  contarPorStatus,
};
