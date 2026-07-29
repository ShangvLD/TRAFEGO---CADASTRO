/* ============================================================================
   Importa o dump do Turso para o Supabase (PostgreSQL).

   Passo 2 da migração. Roda com:

     npm run importar-supabase              (só importa se as tabelas estiverem vazias)
     npm run importar-supabase -- --limpar  (apaga o que houver e importa de novo)

   Lê ./data/dump-turso.json (gerado por "npm run exportar-turso") e grava em
   DATABASE_URL, PRESERVANDO os ids e as datas originais. Tudo dentro de uma
   transação: se algo falhar no meio, nada é gravado.

   Ao final, reposiciona as sequências de id para os próximos INSERTs do app
   continuarem de onde o Turso parou.
   ========================================================================== */

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');

const LIMPAR = process.argv.includes('--limpar');

const COLUNAS_USUARIOS = ['id', 'nome', 'email', 'senha_hash', 'papel', 'ativo', 'criado_em'];

const COLUNAS_SOLICITACOES = [
  'id',
  'solicitante_nome',
  'solicitante_email',
  'assunto',
  'detalhes',
  'anexo',
  'status',
  'observacao',
  'revisado_por',
  'revisado_em',
  'criado_em',
  'origem',
  'origem_id',
  'anexos',
  'decisoes',
];

/** Monta "INSERT INTO tabela (a, b) VALUES ($1, $2)" para as colunas dadas. */
function sqlInsert(tabela, colunas) {
  const marcadores = colunas.map((_, i) => `$${i + 1}`).join(', ');
  return `INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES (${marcadores})`;
}

/** Valores da linha na ordem das colunas (ausente = null). */
function valores(linha, colunas) {
  return colunas.map((c) => (linha[c] === undefined ? null : linha[c]));
}

async function contar(cliente, tabela) {
  const r = await cliente.query(`SELECT count(*)::int AS n FROM ${tabela}`);
  return r.rows[0].n;
}

async function main() {
  const arquivo = path.join(__dirname, '..', 'data', 'dump-turso.json');

  if (!fs.existsSync(arquivo)) {
    console.error(
      `Dump não encontrado: ${arquivo}\n` + 'Rode primeiro:  npm run exportar-turso'
    );
    process.exit(1);
  }

  const dump = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const usuarios = dump.usuarios || [];
  const solicitacoes = dump.solicitacoes || [];

  console.log(`Dump de ${dump.exportado_em}`);
  console.log(`  origem: ${dump.origem}`);
  console.log(`  usuarios:     ${usuarios.length}`);
  console.log(`  solicitacoes: ${solicitacoes.length}\n`);

  // Cria as tabelas/índices se ainda não existirem.
  await db.ensureReady();
  console.log('Schema verificado/criado no Supabase.\n');

  const cliente = await db.pool.connect();

  try {
    const jaUsuarios = await contar(cliente, 'usuarios');
    const jaSolicitacoes = await contar(cliente, 'solicitacoes');

    if ((jaUsuarios > 0 || jaSolicitacoes > 0) && !LIMPAR) {
      console.error(
        `As tabelas de destino NÃO estão vazias ` +
          `(usuarios: ${jaUsuarios}, solicitacoes: ${jaSolicitacoes}).\n\n` +
          'Para não duplicar nada, a importação foi cancelada. Se quiser apagar\n' +
          'o conteúdo atual e importar o dump do zero, rode:\n\n' +
          '  npm run importar-supabase -- --limpar\n'
      );
      process.exitCode = 1;
      return;
    }

    await cliente.query('BEGIN');

    if (LIMPAR && (jaUsuarios > 0 || jaSolicitacoes > 0)) {
      await cliente.query('TRUNCATE usuarios, solicitacoes');
      console.log('Tabelas usuarios e solicitacoes limpas.\n');
    }

    const sqlU = sqlInsert('usuarios', COLUNAS_USUARIOS);
    for (const u of usuarios) {
      await cliente.query(sqlU, valores(u, COLUNAS_USUARIOS));
      console.log(`  ✓ usuário     #${u.id}  ${u.email} (${u.papel})`);
    }

    const sqlS = sqlInsert('solicitacoes', COLUNAS_SOLICITACOES);
    for (const s of solicitacoes) {
      await cliente.query(sqlS, valores(s, COLUNAS_SOLICITACOES));
    }
    console.log(`  ✓ ${solicitacoes.length} solicitação(ões) importada(s)`);

    // Reposiciona as sequências de id (senão o próximo INSERT do app tentaria
    // usar id = 1 e bateria na chave primária).
    for (const tabela of ['usuarios', 'solicitacoes']) {
      await cliente.query(
        `SELECT setval(
           pg_get_serial_sequence('${tabela}', 'id'),
           COALESCE((SELECT max(id) FROM ${tabela}), 0) + 1,
           false
         )`
      );
    }
    console.log('\nSequências de id reposicionadas.');

    await cliente.query('COMMIT');

    const finalU = await contar(cliente, 'usuarios');
    const finalS = await contar(cliente, 'solicitacoes');
    console.log(`\nPronto. No Supabase agora: ${finalU} usuário(s), ${finalS} solicitação(ões).`);
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

main()
  .catch((err) => {
    console.error('\nErro na importação:', err.message);
    process.exitCode = 1;
  })
  .finally(() => db.fechar());
