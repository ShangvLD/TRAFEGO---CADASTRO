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
// ---------------------------------------------------------------------------
// Clientes / operações e decisão por cliente
//
// O "assunto" traz vários clientes separados por "|" (um por pesquisa do
// Forms). Cada um pode ser aprovado/reprovado separadamente; guardamos isso
// na coluna "decisoes" (JSON): { "<cliente>": { status, obs, por, em } }.
// ---------------------------------------------------------------------------

/** Extrai a lista de clientes do assunto (sem vazios, sem repetir). */
function parseClientes(assunto) {
  const vistos = new Set();
  const lista = [];
  for (const parte of String(assunto || '').split('|')) {
    const nome = parte.trim();
    if (!nome) continue;
    const chave = nome.toUpperCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    lista.push(nome);
  }
  return lista;
}

/** Lê o JSON de decisões de uma linha (objeto vazio se não houver). */
function parseDecisoes(row) {
  if (!row || !row.decisoes) return {};
  try {
    const d = JSON.parse(row.decisoes);
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

/**
 * Status "geral" da solicitação a partir das decisões por cliente:
 *   pendente  -> algum cliente ainda sem decisão
 *   aprovado  -> todos aprovados
 *   reprovado -> todos reprovados
 *   parcial   -> misto (uns aprovados, outros reprovados)
 * Sem clientes ou sem nenhuma decisão, cai para o status legado da linha.
 */
function statusGeral(clientes, decisoes, statusLegado) {
  if (!clientes.length) return statusLegado || 'pendente';
  if (Object.keys(decisoes).length === 0) return statusLegado || 'pendente';

  let aprov = 0, reprov = 0, pend = 0;
  for (const c of clientes) {
    const st = decisoes[c] && decisoes[c].status;
    if (st === 'aprovado') aprov++;
    else if (st === 'reprovado') reprov++;
    else pend++;
  }
  if (pend > 0) return 'pendente';
  if (reprov === 0) return 'aprovado';
  if (aprov === 0) return 'reprovado';
  return 'parcial';
}

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
  const clientes = parseClientes(row.assunto);
  const decisoes = parseDecisoes(row);
  return {
    ...row,
    anexos: Array.isArray(anexos) ? anexos : [],
    clientes,
    decisoes,
    status_geral: statusGeral(clientes, decisoes, row.status),
  };
}

/** Lista todas as solicitações, mais recentes primeiro. */
async function listar() {
  const linhas = await db
    .prepare('SELECT * FROM solicitacoes ORDER BY datetime(criado_em) DESC, id DESC')
    .all();
  return linhas.map(hidratar);
}

/** Lista apenas as solicitações de um e-mail (área do solicitante). */
async function listarPorEmail(email) {
  const linhas = await db
    .prepare(
      `SELECT * FROM solicitacoes
       WHERE lower(solicitante_email) = lower(?)
       ORDER BY datetime(criado_em) DESC, id DESC`
    )
    .all(email);
  return linhas.map(hidratar);
}

/** Busca uma solicitação pelo id. */
async function buscarPorId(id) {
  return hidratar(await db.prepare('SELECT * FROM solicitacoes WHERE id = ?').get(id));
}

/** Busca uma solicitação pelo id da resposta do Forms (para evitar duplicar). */
async function buscarPorOrigemId(origem_id) {
  if (!origem_id) return null;
  return db.prepare('SELECT * FROM solicitacoes WHERE origem_id = ?').get(origem_id);
}

/**
 * Registra a decisão do responsável (aprovado/reprovado).
 * Retorna a solicitação atualizada, ou null se o id não existir.
 */
async function registrarDecisao(id, { status, observacao, revisadoPor }) {
  const info = await db
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
async function criar({ solicitante_nome, solicitante_email, assunto, detalhes, anexo, anexos, origem, origem_id }) {
  // Aceita "anexos" (lista/array) e/ou "anexo" (texto/link/JSON), e normaliza.
  const lista = normalizarAnexos(anexos != null ? anexos : anexo);
  const anexosJson = lista.length ? JSON.stringify(lista) : null;
  // Mantém a coluna antiga "anexo" preenchida com o 1º documento (compat).
  const anexoLegado = lista.length ? lista[0].url || lista[0].nome : anexo || null;

  const info = await db
    .prepare(
      `INSERT INTO solicitacoes
         (solicitante_nome, solicitante_email, assunto, detalhes, anexo, anexos, origem, origem_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
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
async function registrarDoForms(dados) {
  const origem_id = dados.origem_id || null;

  if (origem_id) {
    const existente = await buscarPorOrigemId(origem_id);
    if (existente) return { solicitacao: hidratar(existente), duplicada: true };
  }

  const solicitacao = await criar({ ...dados, origem: 'forms', origem_id });
  return { solicitacao, duplicada: false };
}

/**
 * Importa uma solicitação histórica (backfill de planilha do Forms), preservando
 * a data original e o status. Deduplica por origem_id (para poder rodar de novo
 * sem duplicar). Retorna { solicitacao, duplicada }.
 */
async function importar({ solicitante_nome, solicitante_email, assunto, detalhes, anexos, status, criado_em, origem_id }) {
  if (origem_id) {
    const existente = await buscarPorOrigemId(origem_id);
    if (existente) return { solicitacao: hidratar(existente), duplicada: true };
  }

  const lista = normalizarAnexos(anexos);
  const anexosJson = lista.length ? JSON.stringify(lista) : null;
  const anexoLegado = lista.length ? lista[0].url || lista[0].nome : null;
  const st = ['pendente', 'aprovado', 'reprovado'].includes(status) ? status : 'pendente';

  const info = await db
    .prepare(
      `INSERT INTO solicitacoes
         (solicitante_nome, solicitante_email, assunto, detalhes, anexo, anexos, status, origem, origem_id, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'importado', ?, COALESCE(?, datetime('now', 'localtime')))
       RETURNING id`
    )
    .run(
      solicitante_nome,
      solicitante_email,
      assunto,
      detalhes || null,
      anexoLegado,
      anexosJson,
      st,
      origem_id || null,
      criado_em || null
    );
  return { solicitacao: await buscarPorId(info.lastInsertRowid), duplicada: false };
}

/** Exclui uma solicitação pelo id. Retorna true se removeu algo. */
async function excluir(id) {
  // Os anexos enviados pelo portal ficam na tabela "documentos", que perdeu a
  // chave estrangeira ao passar a servir os três módulos — a cascata é feita
  // aqui, senão os arquivos ficariam órfãos no storage.
  await require('./documentos').excluirDaSolicitacao('terceiro', id);

  const info = await db.prepare('DELETE FROM solicitacoes WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * Conta as solicitações por status GERAL (considerando a decisão por cliente).
 * Inclui "parcial" (decisões mistas). Calculado em JS porque o status geral
 * depende do JSON de decisões, não de uma única coluna.
 */
async function contarPorStatus() {
  const linhas = await db
    .prepare('SELECT status, assunto, decisoes FROM solicitacoes')
    .all();

  const resumo = { total: 0, pendente: 0, aprovado: 0, reprovado: 0, parcial: 0 };
  for (const l of linhas) {
    const clientes = parseClientes(l.assunto);
    const sg = statusGeral(clientes, parseDecisoes(l), l.status);
    if (resumo[sg] == null) resumo[sg] = 0;
    resumo[sg]++;
    resumo.total++;
  }
  return resumo;
}

/**
 * "Impressão digital" da lista, para o painel saber se algo mudou sem baixar
 * tudo de novo.
 *
 * Uma consulta agregada só, contra a lista inteira que traz as 52 linhas com
 * detalhes e anexos. O painel consulta isto a cada poucos segundos e só busca
 * a lista completa quando o valor muda.
 *
 * Os três campos cobrem as mudanças que importam:
 *   total        -> entrou ou saiu solicitação
 *   maxId        -> chegou solicitação nova
 *   maxRevisado  -> alguém aprovou/reprovou (revisado_em é reescrito a cada decisão)
 */
async function versao() {
  const r = await db
    .prepare(
      `SELECT count(*)::int              AS total,
              COALESCE(max(id), 0)       AS max_id,
              COALESCE(max(revisado_em), '') AS max_revisado
         FROM solicitacoes`
    )
    .get();
  return {
    total: r ? r.total : 0,
    maxId: r ? Number(r.max_id) : 0,
    maxRevisado: r ? r.max_revisado : '',
  };
}

/** Horário atual do banco ("AAAA-MM-DD HH:MM:SS"), p/ carimbar as decisões. */
async function agoraDoBanco() {
  const r = await db.prepare("SELECT datetime('now', 'localtime') AS agora").get();
  return r ? r.agora : null;
}

/** Grava a coluna decisoes e sincroniza o status legado com o status geral. */
async function salvarDecisoes(id, clientes, decisoes, revisadoPor, agora) {
  const sg = statusGeral(clientes, decisoes, 'pendente');
  // A coluna "status" só aceita pendente/aprovado/reprovado (CHECK). Para o
  // caso "parcial", guardamos "pendente" na coluna legada — o status geral
  // real é recalculado a partir de "decisoes" na leitura.
  const statusLegado = ['aprovado', 'reprovado'].includes(sg) ? sg : 'pendente';
  await db
    .prepare(
      `UPDATE solicitacoes
       SET decisoes = ?, status = ?, revisado_por = ?, revisado_em = ?
       WHERE id = ?`
    )
    .run(JSON.stringify(decisoes), statusLegado, revisadoPor || null, agora, id);
  return buscarPorId(id);
}

/**
 * Registra a decisão de UM cliente/operação da solicitação.
 * Retorna a solicitação atualizada, ou null se o id/cliente não existir.
 */
async function registrarDecisaoCliente(id, { cliente, status, observacao, revisadoPor }) {
  const s = await buscarPorId(id);
  if (!s) return null;
  const alvo = (s.clientes || []).find((c) => c.toUpperCase() === String(cliente || '').toUpperCase());
  if (!alvo) return null;

  const decisoes = { ...(s.decisoes || {}) };
  const agora = await agoraDoBanco();
  decisoes[alvo] = { status, obs: observacao || '', por: revisadoPor || '', em: agora };
  return salvarDecisoes(id, s.clientes, decisoes, revisadoPor, agora);
}

/**
 * Aplica a MESMA decisão a todos os clientes da solicitação (Aprovar/Reprovar
 * todos). Retorna a solicitação atualizada, ou null se o id não existir.
 */
async function registrarDecisaoTodos(id, { status, observacao, revisadoPor }) {
  const s = await buscarPorId(id);
  if (!s) return null;
  const agora = await agoraDoBanco();
  const decisoes = { ...(s.decisoes || {}) };
  for (const c of s.clientes || []) {
    decisoes[c] = { status, obs: observacao || '', por: revisadoPor || '', em: agora };
  }
  return salvarDecisoes(id, s.clientes, decisoes, revisadoPor, agora);
}

module.exports = {
  listar,
  listarPorEmail,
  buscarPorId,
  buscarPorOrigemId,
  registrarDecisao,
  registrarDecisaoCliente,
  registrarDecisaoTodos,
  criar,
  registrarDoForms,
  importar,
  excluir,
  normalizarAnexos,
  contarPorStatus,
  versao,
};
