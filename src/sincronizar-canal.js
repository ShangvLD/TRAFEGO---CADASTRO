/* ============================================================================
   Espelha os documentos do portal na pasta sincronizada do canal do Teams

     npm run sincronizar-canal              (uma passada)
     npm run sincronizar-canal -- --observar (fica rodando)

   POR QUE UM SCRIPT E NÃO O PRÓPRIO APP: em produção o portal roda no Vercel,
   num datacenter — ele não alcança o seu disco nem o seu OneDrive. Este script
   roda NA SUA MÁQUINA: baixa do storage o que ainda não está na pasta, grava, e
   o OneDrive sobe para o canal.

   A vantagem sobre gravar direto na pasta: funciona para documento enviado por
   QUALQUER pessoa, em produção, mesmo com a sua máquina desligada na hora —
   basta rodar depois. Só depende da sua máquina para a CÓPIA, não para o envio.

   Estrutura criada, espelhando o storage:

     <PASTA_CANAL>/
       JOAO_DA_SILVA_12345678900/
         CNH.pdf
         CRLV_CAVALO.pdf

   Copia apenas os módulos de SINCRONIZAR_MODULOS (por padrão terceiro e
   agregado). Candidato é processo de RH e não pertence à pasta da operação.

   NUNCA APAGA nada da pasta. Se um documento sai do portal, o arquivo fica lá
   e é apenas reportado — apagar arquivo de uma pasta compartilhada por decisão
   automática seria arriscado demais.
   ========================================================================== */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const armazenamento = require('./storage');
const documentos = require('./documentos');

const PASTA = process.env.PASTA_CANAL || '';
const OBSERVAR = process.argv.includes('--observar');
const INTERVALO = Number(process.env.SINCRONIZAR_INTERVALO_S || 60) * 1000;

/**
 * Quais módulos vão para o canal.
 *
 * Nem tudo que o portal guarda precisa estar lá: candidato é processo de RH e
 * a pasta é da operação de frota. Copiar tudo encheria o canal de documento
 * que ninguém daquele time vai procurar — e o canal é compartilhado.
 */
const MODULOS = (process.env.SINCRONIZAR_MODULOS || 'terceiro,agregado')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function abortar(mensagem) {
  console.error('\n  ' + mensagem + '\n');
  process.exit(1);
}

function validarPasta() {
  if (!PASTA) {
    abortar(
      'PASTA_CANAL não definida no .env.\n\n' +
        '  Coloque o caminho da pasta do canal sincronizada pelo OneDrive, ex.:\n' +
        '  PASTA_CANAL=C:\\Users\\voce\\OneDrive - Empresa\\EQUIPE\\PASTA DO CANAL'
    );
  }
  if (!fs.existsSync(PASTA)) {
    abortar('A pasta não existe:\n  ' + PASTA + '\n\n  Confira o caminho no .env.');
  }
  try {
    const teste = path.join(PASTA, '.escrita-ok');
    fs.writeFileSync(teste, '');
    fs.unlinkSync(teste);
  } catch (e) {
    abortar('Sem permissão de escrita em:\n  ' + PASTA + '\n  (' + e.code + ')');
  }
}

/** Todos os documentos registrados, de todos os módulos. */
async function documentosDoPortal() {
  return db
    .prepare(
      `SELECT d.id, d.modulo, d.solicitacao_id, d.tipo, d.caminho, d.provedor, d.tamanho
         FROM documentos d
        WHERE d.caminho IS NOT NULL AND d.modulo = ANY(?)
        ORDER BY d.modulo, d.solicitacao_id, d.id`
    )
    .all(MODULOS);
}

/**
 * Caminho local de um documento.
 * O prefixo "CADASTROS/" do storage é descartado: a pasta do canal JÁ é a raiz
 * dos cadastros, e repetir criaria "…/CADASTROS/CADASTROS/…".
 */
function caminhoLocal(caminhoNoStorage) {
  const relativo = caminhoNoStorage.replace(/^CADASTROS\//, '');
  return path.join(PASTA, ...relativo.split('/'));
}

async function sincronizar() {
  const docs = await documentosDoPortal();

  if (docs.length && !armazenamento.PROVEDORES.supabase.disponivel()) {
    abortar(
      'O Supabase Storage não está configurado.\n' +
        '  Defina SUPABASE_SERVICE_KEY no .env — é de lá que os arquivos são baixados.'
    );
  }

  let novos = 0;
  let jaTinha = 0;
  let falhas = 0;

  for (const d of docs) {
    const destino = caminhoLocal(d.caminho);

    // Já existe com o mesmo tamanho: nada a fazer. Comparar o tamanho evita
    // baixar de novo a cada passada, e ainda repõe arquivo truncado.
    if (fs.existsSync(destino)) {
      const st = fs.statSync(destino);
      if (!d.tamanho || st.size === Number(d.tamanho)) {
        jaTinha++;
        continue;
      }
    }

    // Cada documento é lido do armazenamento em que foi gravado, não do
    // provedor em uso agora: um documento gravado direto na pasta não existe
    // no Supabase, e tentar baixá-lo de lá daria falha a cada passada.
    const prov = documentos.armazenamentoDe(d);
    if (!prov) {
      console.error('  ! ' + d.caminho + ' -> ' + documentos.motivoIndisponivel(d));
      falhas++;
      continue;
    }

    try {
      const buffer = await prov.baixar(d.caminho);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, buffer);
      console.log('  + ' + d.caminho.replace(/^CADASTROS\//, ''));
      novos++;
    } catch (e) {
      console.error('  ! ' + d.caminho + ' -> ' + e.message.slice(0, 120));
      falhas++;
    }
  }

  return { total: docs.length, novos, jaTinha, falhas };
}

/** Pastas na pasta do canal que não correspondem a nenhum documento do portal. */
async function orfaos() {
  const docs = await documentosDoPortal();
  const esperados = new Set(docs.map((d) => caminhoLocal(d.caminho)));
  const achados = [];

  function varrer(dir) {
    for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, nome.name);
      if (nome.isDirectory()) varrer(p);
      // desktop.ini é do próprio OneDrive (guarda o ícone da pasta sincronizada);
      // reportar como órfão a cada passada seria só ruído.
      else if (!esperados.has(p) && !nome.name.startsWith('.') && nome.name !== 'desktop.ini') {
        achados.push(p);
      }
    }
  }
  try {
    varrer(PASTA);
  } catch (e) {
    /* pasta pode estar sendo sincronizada; ignora */
  }
  return achados;
}

async function umaPassada({ mostrarOrfaos = true } = {}) {
  const r = await sincronizar();

  console.log(
    `\n  ${r.novos} copiado(s) · ${r.jaTinha} já estava(m) na pasta` +
      (r.falhas ? ` · ${r.falhas} falha(s)` : '') +
      `  (total no portal: ${r.total})`
  );

  if (mostrarOrfaos) {
    const sobrando = await orfaos();
    if (sobrando.length) {
      console.log(
        `\n  ${sobrando.length} arquivo(s) na pasta sem correspondência no portal.\n` +
          '  Nada foi apagado — confira se são anexos antigos ou arquivos colocados à mão:'
      );
      sobrando.slice(0, 10).forEach((p) => console.log('    · ' + path.relative(PASTA, p)));
      if (sobrando.length > 10) console.log(`    … e outros ${sobrando.length - 10}`);
    }
  }
  return r;
}

(async () => {
  validarPasta();

  console.log('\n  Espelhando os documentos do portal em:');
  console.log('  ' + PASTA);
  console.log('  (o OneDrive sobe para o canal do Teams sozinho)');
  console.log('  Módulos: ' + MODULOS.join(', '));

  if (!OBSERVAR) {
    await umaPassada();
    console.log('');
    return;
  }

  console.log(`\n  Modo observação: verificando a cada ${INTERVALO / 1000}s. Ctrl+C para parar.`);
  // Loop simples em vez de setInterval: garante que uma passada termina antes
  // da próxima começar, mesmo que a cópia demore mais que o intervalo.
  for (;;) {
    await umaPassada({ mostrarOrfaos: false }).catch((e) => console.error('  erro:', e.message));
    await new Promise((r) => setTimeout(r, INTERVALO));
  }
})()
  .catch((e) => {
    console.error('\n  ERRO:', e.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => {
    if (!OBSERVAR) db.fechar();
  });
