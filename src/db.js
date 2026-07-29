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

  -- ======================================================================
  -- CADASTRO ESTRUTURADO (formulário nativo do Portal)
  --
  -- As tabelas abaixo são ADITIVAS: a tabela "solicitacoes" continua sendo o
  -- registro central que o painel do responsável lê, e o webhook do Forms
  -- continua gravando nela do jeito antigo. O formulário nativo grava nas
  -- duas formas — estruturada (aqui) e legada (assunto/detalhes em texto) —
  -- para o painel funcionar sem alteração durante a transição.
  --
  -- O ganho da forma estruturada é poder consultar de verdade: "quais CNHs
  -- vencem em 30 dias?" é uma query, não um parsing de string.
  -- ======================================================================

  CREATE TABLE IF NOT EXISTS condutores (
    id             integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    cpf            text NOT NULL UNIQUE,          -- só dígitos
    nome           text NOT NULL,
    email          text,
    telefone       text,                          -- só dígitos
    cnh_numero     text,
    cnh_categoria  text,
    cnh_validade   text,                          -- AAAA-MM-DD
    criado_em      text NOT NULL DEFAULT ${AGORA_SQL},
    atualizado_em  text NOT NULL DEFAULT ${AGORA_SQL}
  );

  CREATE TABLE IF NOT EXISTS proprietarios (
    id             integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    documento      text UNIQUE,                   -- CPF ou CNPJ, só dígitos
    nome           text NOT NULL,
    telefone       text,
    criado_em      text NOT NULL DEFAULT ${AGORA_SQL},
    atualizado_em  text NOT NULL DEFAULT ${AGORA_SQL}
  );

  CREATE TABLE IF NOT EXISTS veiculos (
    id             integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    placa          text NOT NULL UNIQUE,          -- normalizada, sem hífen
    tipo           text NOT NULL DEFAULT 'indefinido'
                        CHECK (tipo IN ('cavalo', 'carreta', 'indefinido')),
    criado_em      text NOT NULL DEFAULT ${AGORA_SQL}
  );

  -- Dados do cadastro, 1 por solicitação. ON DELETE CASCADE para a exclusão
  -- pelo admin continuar funcionando com um só DELETE em solicitacoes.
  CREATE TABLE IF NOT EXISTS solicitacao_cadastro (
    solicitacao_id   integer PRIMARY KEY REFERENCES solicitacoes(id) ON DELETE CASCADE,
    condutor_id      integer REFERENCES condutores(id),
    proprietario_id  integer REFERENCES proprietarios(id),
    placa_cavalo     text,
    placa_carreta    text,
    tag              text,
    rastreador_id    text,
    obs              text,
    criado_em        text NOT NULL DEFAULT ${AGORA_SQL}
  );

  -- Documentos no SharePoint. Guardamos drive_id + item_id (estáveis a
  -- renomear/mover), NUNCA a URL — que quebra na primeira reorganização de
  -- pasta. A URL de exibição é obtida na hora, via Graph.
  CREATE TABLE IF NOT EXISTS documentos (
    id              integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    solicitacao_id  integer NOT NULL REFERENCES solicitacoes(id) ON DELETE CASCADE,
    tipo            text NOT NULL,                -- CNH, ANTT, CRLV-CAVALO, ...
    nome_arquivo    text NOT NULL,
    drive_id        text,
    item_id         text,
    tamanho         bigint,
    content_type    text,
    validade        text,                         -- AAAA-MM-DD, quando aplicável
    enviado_em      text NOT NULL DEFAULT ${AGORA_SQL}
  );

  CREATE INDEX IF NOT EXISTS idx_documentos_solicitacao
    ON documentos (solicitacao_id);

  -- ======================================================================
  -- CONFIGURAÇÃO DO FORMULÁRIO (editável pelo admin, sem deploy)
  --
  -- Antes, a lista de operações e a matriz "que documento cada cliente exige"
  -- viviam como constantes em src/validacao.js — mudar uma exigência pedia um
  -- deploy. Agora vivem aqui, e o admin edita pela tela.
  --
  -- Os valores iniciais são semeados a partir das constantes (ver
  -- src/config-formulario.js), então o comportamento no primeiro dia é
  -- idêntico ao que já existia.
  -- ======================================================================

  CREATE TABLE IF NOT EXISTS cfg_operacoes (
    id         integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    nome       text    NOT NULL UNIQUE,
    ordem      integer NOT NULL DEFAULT 0,
    ativo      smallint NOT NULL DEFAULT 1,
    criado_em  text    NOT NULL DEFAULT ${AGORA_SQL}
  );

  CREATE TABLE IF NOT EXISTS cfg_documentos (
    id               integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    codigo           text    NOT NULL UNIQUE,   -- CNH, ANTT, CRLV_CAVALO...
    rotulo           text    NOT NULL,
    ordem            integer NOT NULL DEFAULT 0,
    tem_validade     smallint NOT NULL DEFAULT 0,
    ativo            smallint NOT NULL DEFAULT 1,
    -- 1 = exigido por TODAS as operações (as linhas de cfg_documento_operacao
    -- são ignoradas). 0 = exigido só pelas operações vinculadas.
    todas_operacoes  smallint NOT NULL DEFAULT 1,
    criado_em        text    NOT NULL DEFAULT ${AGORA_SQL}
  );

  -- Matriz documento x operação. Chave composta impede vínculo duplicado, e o
  -- CASCADE limpa os vínculos quando um documento ou operação é excluído.
  CREATE TABLE IF NOT EXISTS cfg_documento_operacao (
    documento_id  integer NOT NULL REFERENCES cfg_documentos(id) ON DELETE CASCADE,
    operacao_id   integer NOT NULL REFERENCES cfg_operacoes(id)  ON DELETE CASCADE,
    PRIMARY KEY (documento_id, operacao_id)
  );
  CREATE INDEX IF NOT EXISTS idx_condutores_cnh_validade
    ON condutores (cnh_validade);
  CREATE INDEX IF NOT EXISTS idx_solic_cadastro_condutor
    ON solicitacao_cadastro (condutor_id);
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

/**
 * Executa várias consultas numa TRANSAÇÃO, na mesma conexão.
 *
 *   const id = await transacao(async (q) => {
 *     const r = await q('INSERT INTO ... RETURNING id', [a, b]);
 *     await q('INSERT INTO outra ...', [r.rows[0].id]);
 *     return r.rows[0].id;
 *   });
 *
 * COMMIT ao terminar sem erro, ROLLBACK em qualquer exceção. A função "q"
 * recebe SQL no estilo antigo (com "?") e o traduz, igual ao prepare().
 *
 * Necessário porque o cadastro grava em 5 tabelas: se uma falhar, não pode
 * sobrar solicitação órfã sem condutor nem documento.
 */
async function transacao(fn) {
  await ensureReady();
  const cliente = await pool.connect();

  const q = (sql, args = []) => cliente.query(traduzir(sql), args);

  try {
    await cliente.query('BEGIN');
    const resultado = await fn(q);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

/** Encerra o pool (usado pelos scripts de linha de comando). */
async function fechar() {
  await pool.end();
}

module.exports = { prepare, ensureReady, transacao, pool, fechar, AGORA_SQL, traduzir };
