/* ============================================================================
   Banco de dados (libSQL / Turso)

   Usa o cliente "@libsql/client", que fala tanto com um arquivo SQLite LOCAL
   (desenvolvimento) quanto com o Turso na NUVEM (produção/Vercel) — a mesma
   API, mudando só a URL.

     • Desenvolvimento (padrão): arquivo local em ./data/trafego.db
         -> não precisa de internet nem consome cota do Turso.
     • Produção (Vercel): defina TURSO_DATABASE_URL (libsql://...) e
       TURSO_AUTH_TOKEN nas variáveis de ambiente. Aí o app grava no Turso,
       que é persistente (o disco do Vercel é efêmero e não serve p/ banco).

   IMPORTANTE: o cliente é ASSÍNCRONO. As funções da camada de dados
   (usuarios.js / solicitacoes.js) usam await. Este módulo expõe um pequeno
   wrapper "prepare(sql).get/all/run" para manter o código de consulta parecido
   com o antigo (node:sqlite), só que retornando Promises.
   ========================================================================== */

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@libsql/client');

// --------------------------------------------------------------------------
// Escolha da conexão
// --------------------------------------------------------------------------
// Se TURSO_DATABASE_URL estiver definida, conecta no Turso (produção).
// Caso contrário, cai para um arquivo SQLite local (desenvolvimento).
let url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  url = `file:${path.join(dataDir, 'trafego.db')}`;
}

const client = createClient({
  url,
  authToken, // ignorado no modo "file:"
  intMode: 'number', // retorna inteiros como Number (evita BigInt em COUNT/rowid)
});

// --------------------------------------------------------------------------
// Inicialização do schema (idempotente)
//
// Como as chamadas são assíncronas, não dá para criar as tabelas no topo do
// módulo (como era com node:sqlite). Em vez disso, memorizamos uma Promise de
// "banco pronto" e cada consulta espera por ela na 1ª vez. As instruções são
// todas "IF NOT EXISTS" / ALTER condicional, então rodar de novo é seguro.
// --------------------------------------------------------------------------
let readyPromise = null;

function ensureReady() {
  if (!readyPromise) readyPromise = init();
  return readyPromise;
}

async function init() {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      nome        TEXT    NOT NULL,
      email       TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      senha_hash  TEXT    NOT NULL,
      papel       TEXT    NOT NULL CHECK (papel IN ('solicitante', 'responsavel', 'admin')),
      ativo       INTEGER NOT NULL DEFAULT 1,
      criado_em   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      sid        TEXT PRIMARY KEY,
      dados      TEXT NOT NULL,
      expira_em  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS solicitacoes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      solicitante_nome  TEXT    NOT NULL,
      solicitante_email TEXT    NOT NULL COLLATE NOCASE,
      assunto           TEXT    NOT NULL,
      detalhes          TEXT,
      anexo             TEXT,
      status            TEXT    NOT NULL DEFAULT 'pendente'
                                CHECK (status IN ('pendente', 'aprovado', 'reprovado')),
      observacao        TEXT,
      revisado_por      TEXT,
      revisado_em       TEXT,
      criado_em         TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
  `);

  // Migração leve — colunas de origem (integração com Microsoft Forms).
  const colunas = (await client.execute('PRAGMA table_info(solicitacoes)')).rows.map((c) => c.name);

  if (!colunas.includes('origem')) {
    await client.execute('ALTER TABLE solicitacoes ADD COLUMN origem TEXT');
  }
  if (!colunas.includes('origem_id')) {
    await client.execute('ALTER TABLE solicitacoes ADD COLUMN origem_id TEXT');
  }
  if (!colunas.includes('anexos')) {
    await client.execute('ALTER TABLE solicitacoes ADD COLUMN anexos TEXT');
  }

  // Índice único parcial: cada resposta do Forms entra uma só vez.
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_solic_origem_id
       ON solicitacoes(origem_id) WHERE origem_id IS NOT NULL`
  );
}

// --------------------------------------------------------------------------
// Wrapper estilo "prepared statement", porém assíncrono.
//
//   await prepare(sql).get(a, b)   -> primeira linha (objeto) ou undefined
//   await prepare(sql).all(a, b)   -> array de linhas (objetos)
//   await prepare(sql).run(a, b)   -> { changes, lastInsertRowid }
//
// As linhas são convertidas para objetos simples (só as colunas nomeadas),
// para o restante do código poder fazer { ...row } com segurança.
// --------------------------------------------------------------------------
function linhaParaObjeto(row, columns) {
  const obj = {};
  for (const nome of columns) obj[nome] = row[nome];
  return obj;
}

function prepare(sql) {
  return {
    async get(...args) {
      await ensureReady();
      const rs = await client.execute({ sql, args });
      return rs.rows.length ? linhaParaObjeto(rs.rows[0], rs.columns) : undefined;
    },
    async all(...args) {
      await ensureReady();
      const rs = await client.execute({ sql, args });
      return rs.rows.map((r) => linhaParaObjeto(r, rs.columns));
    },
    async run(...args) {
      await ensureReady();
      const rs = await client.execute({ sql, args });
      return {
        changes: rs.rowsAffected,
        lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid),
      };
    },
  };
}

module.exports = { prepare, ensureReady, client };
