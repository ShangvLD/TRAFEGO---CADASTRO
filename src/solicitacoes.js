/* ============================================================================
   Camada de acesso às solicitações de cadastro

   Concentra as consultas da tabela "solicitacoes". Enquanto a integração com
   o Microsoft Forms (Fase 4) não existe, os dados vêm do seed de exemplo.
   ========================================================================== */

const db = require('./db');

// ---------------------------------------------------------------------------
// Anexos
//
// Cada solicitação pode ter vários documentos (o Microsoft Forms permite mais
// de um upload). Guardamos uma lista [{ nome, url }] em JSON na coluna "anexos".
// A entrada pode chegar de várias formas (link único, texto, ou o JSON que o
// Power Automate manda do campo de upload do Forms), então normalizamos tudo.
// ---------------------------------------------------------------------------

/** Extrai um nome de arquivo amigável de uma URL (ou "Documento"). */
function nomeDeUrl(url) {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return base || 'Documento';
  } catch {
    return 'Documento';
  }
}

/** Converte um item (string ou objeto do Forms) em { nome, url }. */
function itemParaAnexo(item) {
  if (item == null) return null;

  if (typeof item === 'string') {
    const s = item.trim();
    if (!s) return null;
    const ehUrl = /^https?:\/\//i.test(s);
    return ehUrl ? { nome: nomeDeUrl(s), url: s } : { nome: s, url: null };
  }

  if (typeof item === 'object') {
    // O Forms/Power Automate usa "name" e "link".
    const url = item.link || item.url || item.href || null;
    const nome = item.name || item.nome || item.fileName || (url ? nomeDeUrl(url) : null) || 'Documento';
    if (!url && !item.name && !item.nome && !item.fileName) return null;
    return { nome, url: url || null };
  }

  return null;
}

/** Normaliza qualquer entrada de anexo em uma lista [{ nome, url }]. */
function normalizarAnexos(entrada) {
  if (entrada == null) return [];

  if (Array.isArray(entrada)) {
    return entrada.map(itemParaAnexo).filter(Boolean);
  }

  if (typeof entrada === 'object') {
    const a = itemParaAnexo(entrada);
    return a ? [a] : [];
  }

  const txt = String(entrada).trim();
  if (!txt) return [];

  // Pode vir como JSON (o campo de upload do Forms serializa assim).
  if (txt[0] === '[' || txt[0] === '{') {
    try {
      return normalizarAnexos(JSON.parse(txt));
    } catch {
      /* não era JSON — segue como texto */
    }
  }

  // Vários links separados por quebra de linha ou ";".
  return txt
    .split(/[\n;]+/)
    .map((p) => itemParaAnexo(p))
    .filter(Boolean);
}

/**
 * Acrescenta o campo "anexos" (array) a uma linha do banco, para o front não
 * precisar interpretar. Usa a coluna nova "anexos" (JSON) e, se estiver vazia
 * (linhas antigas), cai para a coluna antiga "anexo".
 */
function hidratar(row) {
  if (!row) return row;
  let anexos = [];
  if (row.anexos) {
    try {
      anexos = JSON.parse(row.anexos);
    } catch {
      anexos = [];
    }
  }
  if ((!anexos || !anexos.length) && row.anexo) {
    anexos = normalizarAnexos(row.anexo);
  }
  return { ...row, anexos: Array.isArray(anexos) ? anexos : [] };
}

/** Lista todas as solicitações, mais recentes primeiro. */
function listar() {
  return db
    .prepare('SELECT * FROM solicitacoes ORDER BY datetime(criado_em) DESC, id DESC')
    .all()
    .map(hidratar);
}

/** Lista apenas as solicitações de um e-mail (área do solicitante). */
function listarPorEmail(email) {
  return db
    .prepare(
      `SELECT * FROM solicitacoes
       WHERE solicitante_email = ?
       ORDER BY datetime(criado_em) DESC, id DESC`
    )
    .all(email)
    .map(hidratar);
}

/** Busca uma solicitação pelo id. */
function buscarPorId(id) {
  return hidratar(db.prepare('SELECT * FROM solicitacoes WHERE id = ?').get(id));
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
function criar({ solicitante_nome, solicitante_email, assunto, detalhes, anexo, anexos, origem, origem_id }) {
  // Aceita "anexos" (lista/array) e/ou "anexo" (texto/link/JSON), e normaliza.
  const lista = normalizarAnexos(anexos != null ? anexos : anexo);
  const anexosJson = lista.length ? JSON.stringify(lista) : null;
  // Mantém a coluna antiga "anexo" preenchida com o 1º documento (compat).
  const anexoLegado = lista.length ? lista[0].url || lista[0].nome : anexo || null;

  const info = db
    .prepare(
      `INSERT INTO solicitacoes
         (solicitante_nome, solicitante_email, assunto, detalhes, anexo, anexos, origem, origem_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      solicitante_nome,
      solicitante_email,
      assunto,
      detalhes || null,
      anexoLegado,
      anexosJson,
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
  normalizarAnexos,
  contarPorStatus,
};
