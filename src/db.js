/* ============================================================================
   Banco de dados (SQLite embutido no Node — módulo "node:sqlite")

   A partir do Node 22.5+ o SQLite vem embutido no runtime, então não há
   nenhuma dependência nativa para compilar (o que evita precisar do Visual
   Studio Build Tools no Windows).

   O arquivo do banco fica em /data, fora do controle de versão (.gitignore),
   pois guarda os logins reais. O schema é criado na primeira execução.
   ========================================================================== */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// Pasta do banco. Por padrão fica em /data (desenvolvimento local), mas pode
// ser sobrescrita por DATA_DIR — usado na hospedagem (ex.: Railway) para
// apontar o banco a um disco persistente (volume), fora do sistema de
// arquivos efêmero que zera a cada deploy.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'trafego.db');
const db = new DatabaseSync(dbPath);

// Boas práticas para SQLite em aplicação web.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// --------------------------------------------------------------------------
// Schema — criado apenas se ainda não existir.
// --------------------------------------------------------------------------
db.exec(`
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

// --------------------------------------------------------------------------
// Migração leve — colunas de origem (integração com Microsoft Forms via
// Power Automate). Rodam apenas se as colunas ainda não existirem, então é
// seguro reexecutar sobre um banco já criado.
//
//   origem     -> de onde veio a solicitação ('forms', 'seed', 'manual'...)
//   origem_id  -> id da resposta no Microsoft Forms (evita gravar duplicado
//                 caso o Power Automate reenvie o mesmo evento)
// --------------------------------------------------------------------------
const colunasSolic = db
  .prepare('PRAGMA table_info(solicitacoes)')
  .all()
  .map((c) => c.name);

if (!colunasSolic.includes('origem')) {
  db.exec('ALTER TABLE solicitacoes ADD COLUMN origem TEXT');
}
if (!colunasSolic.includes('origem_id')) {
  db.exec('ALTER TABLE solicitacoes ADD COLUMN origem_id TEXT');
}

// Índice único parcial: garante que cada resposta do Forms entre uma só vez,
// mas permite vários registros sem origem_id (seed, testes manuais).
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_solic_origem_id
     ON solicitacoes(origem_id) WHERE origem_id IS NOT NULL`
);

module.exports = db;
