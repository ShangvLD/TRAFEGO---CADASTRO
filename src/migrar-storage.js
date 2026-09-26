/* ============================================================================
   Reorganiza os arquivos do Storage na estrutura nova

     npm run migrar-storage              (ensaio: mostra e não toca em nada)
     npm run migrar-storage -- --aplicar (executa)
     npm run migrar-storage -- --aplicar --manter (executa e NÃO apaga o antigo)

   DE:   CADASTROS/KAUA_JESUS_JOMEDLOG_COM_BR_SEM_CPF/RESULTADO_RDO.pdf
   PARA: terceiro/000000/000302_KAUA_JESUS_JOMEDLOG_COM_BR_SEM_CPF/RESULTADO_RDO.pdf

   POR QUE ISTO PRECISA EXISTIR: a pasta antiga era batizada com nome e CPF, e
   quase nenhum cadastro do Forms tem os dois — saía o e-mail de quem abriu o
   chamado, terminado em "_SEM_CPF", COMPARTILHADO por todas as solicitações
   daquela pessoa. Em produção, três pastas ficaram com o RDO de dois cadastros
   diferentes cada (302 e 438, 377 e 450, 426 e 435). Nenhum arquivo se perdeu
   porque as extensões diferiam — o upload usa upsert, e dois PDFs no mesmo
   caminho teriam virado um. O id na frente acaba com essa loteria.

   POR QUE NÃO É UMA MIGRATION SQL: mover arquivo exige falar com o Supabase
   Storage, e o Postgres não fala. O SQL entra aqui só no fim, para apontar o
   registro ao caminho novo.

   ORDEM DAS OPERAÇÕES, e ela é o ponto todo:

     copia -> confere -> atualiza o banco -> só então apaga o original

   Em qualquer outra ordem uma falha no meio deixa o registro apontando para
   um arquivo que não existe mais — documento perdido, e ninguém descobre até
   alguém precisar dele. Nesta ordem, uma falha no meio deixa uma cópia a mais
   no bucket, que é lixo, não perda. Com --manter, nem isso é apagado.

   Roda quantas vezes quiser: o que já está no formato novo é ignorado.
   ========================================================================== */

require('dotenv').config();

const db = require('./db');
const armazenamento = require('./storage');
const tiposDocumento = require('./tipos-documento');

const APLICAR = process.argv.includes('--aplicar');
const MANTER = process.argv.includes('--manter');

/**
 * Caminho novo a partir do antigo.
 *
 * O nome e o CPF saem da PRÓPRIA pasta antiga, não de uma nova consulta ao
 * cadastro. É de propósito: reabrir o cadastro para redescobrir o dono daria
 * um nome DIFERENTE do que está no arquivo hoje (o dono passou a ser buscado
 * em três lugares desde então), e o objetivo aqui é mover, não rebatizar.
 * Mover e renomear ao mesmo tempo é o tipo de coisa que, quando dá errado,
 * ninguém consegue dizer qual das duas falhou.
 *
 * O prefixo numérico antigo ("00377_"), quando existe, é descartado: o id
 * volta na frente já com seis dígitos.
 */
function caminhoNovo(doc) {
  const partes = String(doc.caminho).split('/');
  if (partes.length !== 3) return null;

  const arquivo = partes[2];
  const pastaAntiga = partes[1].replace(/^\d{4,6}_/, '');

  const pasta = armazenamento.pastaDaSolicitacao(doc.modulo, doc.solicitacao_id, {
    // pastaDaSolicitacao junta nome e CPF com "_"; aqui os dois já vêm
    // juntos e higienizados, então entram inteiros como "nome".
    nome: pastaAntiga,
  });

  // O nome do arquivo passa pelo canônico junto: "RESULTADO RDO" nunca
  // chegou a virar arquivo com espaço, mas um tipo novo poderia.
  const ext = armazenamento.extensaoDe(arquivo);
  const base = tiposDocumento.canonico(arquivo.replace(/\.[^.]+$/, ''));

  return `${pasta}/${base}${ext ? '.' + ext : ''}`;
}

const CHAVE = process.env.SUPABASE_SERVICE_KEY;

function cabecalhos() {
  return {
    Authorization: `Bearer ${CHAVE}`,
    apikey: CHAVE,
    'Content-Type': 'application/json',
  };
}

/**
 * Cópia no lado do servidor: o arquivo não desce até aqui e não sobe de volta.
 * Além de rápido, evita o caso em que o download funciona e o upload falha
 * pela metade — o Supabase copia inteiro ou não copia.
 */
async function copiar(de, para) {
  const r = await fetch(`${armazenamento.URL_PROJETO}/storage/v1/object/copy`, {
    method: 'POST',
    headers: cabecalhos(),
    body: JSON.stringify({
      bucketId: armazenamento.BUCKET,
      sourceKey: de,
      destinationKey: para,
    }),
  });
  if (!r.ok) {
    const corpo = await r.text().catch(() => '');
    throw new Error(`cópia falhou (HTTP ${r.status}): ${corpo.slice(0, 200)}`);
  }
}

/**
 * O arquivo chegou inteiro?
 *
 * Confere o TAMANHO, não só a existência. Um objeto de zero byte no destino
 * passaria por "existe" e seria o bastante para o script apagar o original —
 * que é exatamente a perda que esta função existe para impedir.
 */
async function conferir(caminho, tamanhoEsperado) {
  const r = await fetch(`${armazenamento.URL_PROJETO}/storage/v1/object/list/${armazenamento.BUCKET}`, {
    method: 'POST',
    headers: cabecalhos(),
    body: JSON.stringify({
      prefix: caminho.split('/').slice(0, -1).join('/') + '/',
      limit: 1000,
      offset: 0,
    }),
  });
  if (!r.ok) return { ok: false, erro: `listagem falhou (HTTP ${r.status})` };

  const nome = caminho.split('/').pop();
  const achado = (await r.json()).find((o) => o.name === nome);
  if (!achado) return { ok: false, erro: 'não apareceu no destino' };

  const tam = achado.metadata && achado.metadata.size;
  // Só compara quando o banco sabe o tamanho: linha antiga pode ter tamanho
  // nulo, e recusar a migração por isso seria travar sem motivo.
  if (tamanhoEsperado && tam && Number(tam) !== Number(tamanhoEsperado)) {
    return { ok: false, erro: `tamanho diferente: ${tam} != ${tamanhoEsperado}` };
  }
  return { ok: true, tamanho: tam };
}

async function remover(caminho) {
  const r = await fetch(
    `${armazenamento.URL_PROJETO}/storage/v1/object/${armazenamento.BUCKET}/${encodeURI(caminho)}`,
    { method: 'DELETE', headers: cabecalhos() }
  );
  if (!r.ok) throw new Error(`remoção falhou (HTTP ${r.status})`);
}

async function principal() {
  if (!armazenamento.PROVEDORES.supabase.disponivel()) {
    console.error(
      '\nO Supabase Storage não está configurado neste ambiente.\n' +
        'Faltam SUPABASE_SERVICE_KEY e/ou a URL do projeto (deduzida de DATABASE_URL).\n'
    );
    process.exit(1);
  }

  const docs = await db
    .prepare(
      `SELECT id, modulo, solicitacao_id, tipo, caminho, provedor, tamanho
         FROM documentos
        WHERE caminho IS NOT NULL AND provedor = 'supabase'
        ORDER BY id`
    )
    .all();

  const pendentes = docs.filter((d) => armazenamento.caminhoLegado(d.caminho));

  console.log(`\nBucket: ${armazenamento.BUCKET}`);
  console.log(`Documentos no Supabase: ${docs.length}`);
  console.log(`No formato antigo: ${pendentes.length}`);
  if (!APLICAR) console.log('\n*** ENSAIO — nada será alterado. Use --aplicar para executar. ***');
  console.log('');

  if (!pendentes.length) {
    console.log('Nada a migrar.\n');
    return;
  }

  // Destinos repetidos parariam a migração no meio, depois de já ter mexido em
  // parte dos arquivos. Conferir ANTES custa uma passada e evita isso.
  const destinos = new Map();
  for (const d of pendentes) {
    const novo = caminhoNovo(d);
    if (!novo) continue;
    if (destinos.has(novo)) {
      console.error(
        `ABORTADO: os documentos ${destinos.get(novo)} e ${d.id} iriam para o mesmo caminho:\n  ${novo}\n`
      );
      process.exit(1);
    }
    destinos.set(novo, d.id);
  }

  let migrados = 0;
  let falhas = 0;

  for (const d of pendentes) {
    const novo = caminhoNovo(d);
    if (!novo) {
      console.error(`  ! ${d.id}: caminho fora do formato esperado — ${d.caminho}`);
      falhas++;
      continue;
    }

    console.log(`  ${d.id}  ${d.caminho}`);
    console.log(`   -> ${novo}`);

    if (!APLICAR) continue;

    try {
      await copiar(d.caminho, novo);

      const c = await conferir(novo, d.tamanho);
      if (!c.ok) throw new Error(c.erro);

      // O banco só é atualizado depois da conferência. Até esta linha, o
      // registro continua apontando para o arquivo original, que continua lá:
      // uma falha aqui não tira nenhum documento do ar.
      await db
        .prepare(
          `UPDATE documentos
              SET caminho = ?, bucket = ?, tipo = ?,
                  atualizado_em = datetime('now', 'localtime')
            WHERE id = ?`
        )
        .run(novo, armazenamento.BUCKET, tiposDocumento.canonico(d.tipo), d.id);

      if (!MANTER) {
        await remover(d.caminho);
        console.log('      ok (original apagado)');
      } else {
        console.log('      ok (original mantido)');
      }
      migrados++;
    } catch (e) {
      console.error(`      ! ${e.message}`);
      falhas++;
    }
  }

  console.log(`\n${migrados} migrado(s), ${falhas} falha(s).`);

  if (APLICAR && MANTER) {
    console.log(
      '\nOs originais continuam no bucket, em CADASTROS/. Depois de conferir que\n' +
        'os documentos abrem no portal, apague a pasta pelo painel do Supabase.'
    );
  }
  console.log('');
}

principal()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nFalhou:', e.message, '\n');
    process.exit(1);
  });
