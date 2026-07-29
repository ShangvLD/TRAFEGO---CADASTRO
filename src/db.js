/* ============================================================================
   Banco de dados (PostgreSQL / Supabase)

   Usa o driver "pg" (100% JavaScript, sem dependência nativa) para falar com o
   PostgreSQL do Supabase. Antes o projeto usava SQLite/Turso; a camada de
   consulta continua com a MESMA cara ("prepare(sql).get/all/run"), então
   usuarios.js, solicitacoes.js e session-store.js praticamente não mudaram.

     • A conexão é OBRIGATÓRIA (não existe mais o modo "arquivo local"):
       defina DATABASE_URL no .env (local) e nas Environment Variables do
       Vercel (produção). Pegue a string no Supabase em
       "Connect" > "Connection string" > aba ORMs/Node.js.

     • Em ambiente serverless (Vercel), use a URL do POOLER do Supabase
       (host ...pooler.supabase.com, porta 6543 — modo transaction). Cada
       instância da função abre pouquíssimas conexões e o pooler protege o
       banco de estourar o limite.

   DIFERENÇAS DE DIALETO que este módulo resolve automaticamente, para o resto
   do código continuar escrevendo SQL no estilo antigo:

     ?  ............................ vira  $1, $2, $3...
     datetime('now', 'localtime') .. vira  to_char(now() ..., 'YYYY-MM-DD HH24:MI:SS')
     datetime(coluna) .............. vira  coluna  (o texto já ordena certo)

   O cliente é ASSÍNCRONO: as funções da camada de dados usam await.
   ========================================================================== */

require('dotenv').config();

const { Pool, types } = require('pg');

// --------------------------------------------------------------------------
// Tipos: BIGINT (int8) chega como string por padrão no "pg", porque pode
// passar de 2^53. Aqui os únicos bigints são milissegundos de data
// (sessoes.expira_em), muito abaixo desse limite — então convertemos para
// Number e o código JS segue comparando número com número.
// --------------------------------------------------------------------------
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

// --------------------------------------------------------------------------
// Fuso horário dos carimbos de data/hora
//
// As datas são guardadas como TEXTO "AAAA-MM-DD HH:MM:SS" (mesmo formato do
// SQLite antigo, que o front-end já sabe exibir). O Turso rodava em UTC, então
// mantemos UTC para as linhas novas ficarem coerentes com as 51 já existentes.
// Para passar a gravar no horário de Brasília, troque 'UTC' por
// 'America/Sao_Paulo' na linha abaixo (afeta só os registros futuros).
// --------------------------------------------------------------------------
const FUSO = 'UTC';
const AGORA_SQL = `to_char(now() AT TIME ZONE '${FUSO}', 'YYYY-MM-DD HH24:MI:SS')`;

// --------------------------------------------------------------------------
// Conexão
// --------------------------------------------------------------------------
const connectionString =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL não definida.\n' +
      'Coloque a connection string do Supabase no .env (local) e nas Environment\n' +
      'Variables do Vercel (produção). Veja docs/MIGRACAO-SUPABASE.md.'
  );
}

const pool = new Pool({
  connectionString,
  // O Supabase exige TLS. Não validamos a cadeia do certificado porque o
  // pooler usa um CA próprio que não vem no bundle padrão do Node.
  ssl: { rejectUnauthorized: false },
  // Serverless: poucas conexões por instância e ocioso curto, para a função
  // não segurar conexões do pooler entre requisições.
  max: 3,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});

// Um erro em conexão ociosa não deve derrubar o processo.
pool.on('error', (err) => {
  console.error('[db] erro em conexão ociosa:', err.message);
});

// --------------------------------------------------------------------------
// Tradução do SQL estilo SQLite -> PostgreSQL
// --------------------------------------------------------------------------

/**
 * Troca os "?" por "$1, $2, ..." (numeração posicional do PostgreSQL),
 * ignorando "?" que estejam dentro de literais entre aspas simples.
 */
function numerarParametros(sql) {
  let saida = '';
  let n = 0;
  let dentroDeTexto = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];

    if (c === "'") {
      // '' dentro de um literal é um apóstrofo escapado, não o fim do texto.
      if (dentroDeTexto && sql[i + 1] === "'") {
        saida += "''";
        i++;
        continue;
      }
      dentroDeTexto = !dentroDeTexto;
      saida += c;
      continue;
    }

    if (c === '?' && !dentroDeTexto) {
      saida += `$${++n}`;
      continue;
    }

    saida += c;
  }

  return saida;
}

/** Converte as funções de data do SQLite para o equivalente no PostgreSQL. */
function traduzirDatas(sql) {
  return (
    sql
      // datetime('now', 'localtime')  ->  to_char(now() ...)
      .replace(/datetime\(\s*'now'\s*,\s*'localtime'\s*\)/gi, AGORA_SQL)
      .replace(/datetime\(\s*'now'\s*\)/gi, AGORA_SQL)
      // datetime(criado_em)  ->  criado_em
      // (o texto "AAAA-MM-DD HH:MM:SS" já ordena cronologicamente)
      .replace(/datetime\(\s*([a-z_][a-z0-9_.]*)\s*\)/gi, '$1')
  );
}

function traduzir(sql) {
  return numerarParametros(traduzirDatas(sql));
}

// --------------------------------------------------------------------------
// Inicialização do schema (idempotente)
//
// Tudo em UMA instrução de múltiplos comandos = uma só ida ao banco, o que
// importa em serverless (cada cold start passa por aqui uma vez).
// --------------------------------------------------------------------------
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS usuarios (
    id          integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    nome        text    NOT NULL,
    email       text    NOT NULL,
    senha_hash  text    NOT NULL,
    papel       text    NOT NULL CHECK (papel IN ('solicitante', 'responsavel', 'admin')),
    ativo       smallint NOT NULL DEFAULT 1,
    criado_em   text    NOT NULL DEFAULT ${AGORA_SQL}
  );

  -- E-mail único ignorando maiúsculas/minúsculas (equivale ao COLLATE NOCASE
  -- do SQLite, sem precisar da extensão citext).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email_lower
    ON usuarios (lower(email));

  CREATE TABLE IF NOT EXISTS sessoes (
    sid        text   PRIMARY KEY,
    dados      text   NOT NULL,
    expira_em  bigint NOT NULL
  );

  CREATE TABLE IF NOT EXISTS solicitacoes (
    id                integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    solicitante_nome  text NOT NULL,
    solicitante_email text NOT NULL,
    assunto           text NOT NULL,
    detalhes          text,
    anexo             text,
    status            text NOT NULL DEFAULT 'pendente'
                           CHECK (status IN ('pendente', 'aprovado', 'reprovado')),
    observacao        text,
    revisado_por      text,
    revisado_em       text,
    criado_em         text NOT NULL DEFAULT ${AGORA_SQL},
    origem            text,
    origem_id         text,
    anexos            text,
    decisoes          text
  );

  -- Colunas acrescentadas depois (bancos criados antes destas versões).
  ALTER TABLE solicitacoes ADD COLUMN IF NOT EXISTS origem    text;
  ALTER TABLE solicitacoes ADD COLUMN IF NOT EXISTS origem_id text;
  ALTER TABLE solicitacoes ADD COLUMN IF NOT EXISTS anexos    text;
  ALTER TABLE solicitacoes ADD COLUMN IF NOT EXISTS decisoes  text;

  -- Índice único parcial: cada resposta do Forms entra uma só vez.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_solic_origem_id
    ON solicitacoes (origem_id) WHERE origem_id IS NOT NULL;

  -- Busca por e-mail do solicitante (área do solicitante), sem case.
  CREATE INDEX IF NOT EXISTS idx_solic_email_lower
    ON solicitacoes (lower(solicitante_email));

  -- Limpeza de sessões expiradas por varredura, se um dia for preciso.
  CREATE INDEX IF NOT EXISTS idx_sessoes_expira_em
    ON sessoes (expira_em);
`;

let readyPromise = null;

function ensureReady() {
  if (!readyPromise) {
    readyPromise = pool.query(SCHEMA_SQL).catch((err) => {
      // Se falhar, não memoriza o erro: a próxima consulta tenta de novo.
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

// --------------------------------------------------------------------------
// Wrapper estilo "prepared statement", assíncrono.
//
//   await prepare(sql).get(a, b)   -> primeira linha (objeto) ou undefined
//   await prepare(sql).all(a, b)   -> array de linhas (objetos)
//   await prepare(sql).run(a, b)   -> { changes, lastInsertRowid }
//
// Em "run", lastInsertRowid vem do "RETURNING id" quando a consulta o pede
// (os INSERTs de usuarios/solicitacoes pedem); caso contrário é null.
// --------------------------------------------------------------------------
function prepare(sql) {
  const texto = traduzir(sql);

  async function executar(args) {
    await ensureReady();
    return pool.query(texto, args);
  }

  return {
    async get(...args) {
      const rs = await executar(args);
      return rs.rows.length ? rs.rows[0] : undefined;
    },
    async all(...args) {
      const rs = await executar(args);
      return rs.rows;
    },
    async run(...args) {
      const rs = await executar(args);
      const primeira = rs.rows && rs.rows.length ? rs.rows[0] : null;
      return {
        changes: rs.rowCount,
        lastInsertRowid: primeira && primeira.id != null ? Number(primeira.id) : null,
      };
    },
  };
}

/** Encerra o pool (usado pelos scripts de linha de comando). */
async function fechar() {
  await pool.end();
}

module.exports = { prepare, ensureReady, pool, fechar, AGORA_SQL, traduzir };
