/* ============================================================================
   Consulta rápida ao banco pela linha de comando.

   Uso:
     npm run consultar -- "SELECT * FROM usuarios"
     npm run consultar -- "SELECT id, assunto, status FROM solicitacoes"

   Sem argumento, mostra um resumo geral do banco.
   ========================================================================== */

const db = require('./db');

const sql = process.argv.slice(2).join(' ').trim();

(async () => {
  // Sem consulta: mostra um panorama do banco.
  if (!sql) {
    console.log('\n=== USUÁRIOS ===');
    console.table(await db.prepare('SELECT id, nome, email, papel, ativo FROM usuarios').all());

    console.log('\n=== SOLICITAÇÕES ===');
    console.table(
      await db.prepare('SELECT id, assunto, status, revisado_por FROM solicitacoes').all()
    );

    console.log('\nDica: passe sua própria consulta, ex.:');
    console.log('  npm run consultar -- "SELECT * FROM solicitacoes WHERE status = \'aprovado\'"\n');
    process.exit(0);
  }

  // Com consulta: executa e mostra o resultado.
  try {
    const stmt = db.prepare(sql);
    const ehLeitura = /^\s*(select|pragma|with)/i.test(sql);

    if (ehLeitura) {
      const linhas = await stmt.all();
      if (linhas.length === 0) {
        console.log('(nenhum resultado)');
      } else {
        console.table(linhas);
        console.log(`${linhas.length} linha(s).`);
      }
    } else {
      const info = await stmt.run();
      console.log(`OK. Linhas afetadas: ${info.changes}`);
    }
  } catch (erro) {
    console.error('Erro na consulta:', erro.message);
    process.exit(1);
  }
})();
