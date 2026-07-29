/* ============================================================================
   Exporta os dados do Turso (libSQL) para um arquivo JSON.

   Passo 1 da migração para o Supabase (PostgreSQL). Roda com:

     npm run exportar-turso

   Lê TURSO_DATABASE_URL / TURSO_AUTH_TOKEN do .env e grava
   ./data/dump-turso.json com as tabelas "usuarios" e "solicitacoes".
   As sessões NÃO são exportadas (são descartáveis — todos fazem login de novo).

   Este script é somente-leitura: não altera nada no Turso.
   ========================================================================== */

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error(
    'TURSO_DATABASE_URL não está definida no .env.\n' +
      'Coloque a URL do Turso (libsql://...) e o TURSO_AUTH_TOKEN para exportar.'
  );
  process.exit(1);
}

const client = createClient({ url, authToken, intMode: 'number' });

/** Lê uma tabela inteira como array de objetos simples. */
async function lerTabela(nome) {
  const rs = await client.execute(`SELECT * FROM ${nome}`);
  return rs.rows.map((row) => {
    const obj = {};
    for (const col of rs.columns) obj[col] = row[col];
    return obj;
  });
}

async function main() {
  console.log(`Lendo do Turso: ${url}\n`);

  const usuarios = await lerTabela('usuarios');
  const solicitacoes = await lerTabela('solicitacoes');

  const dump = {
    exportado_em: new Date().toISOString(),
    origem: url,
    usuarios,
    solicitacoes,
  };

  const destino = path.join(__dirname, '..', 'data', 'dump-turso.json');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify(dump, null, 2), 'utf8');

  console.log(`  usuarios:     ${usuarios.length} registro(s)`);
  console.log(`  solicitacoes: ${solicitacoes.length} registro(s)`);
  console.log(`\nDump salvo em: ${destino}`);
  console.log('\nPróximo passo: npm run importar-supabase');
}

main().catch((err) => {
  console.error('Erro ao exportar do Turso:', err);
  process.exit(1);
});
