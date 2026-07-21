/* ============================================================================
   Importação de registros antigos do Microsoft Forms (backfill).

   Lê um CSV exportado do Forms e grava cada linha como uma solicitação
   histórica, preservando a DATA original e marcando o status como "pendente"
   (a aprovação é controlada em outra planilha). Deduplica pelo Id do Forms,
   então é seguro rodar de novo.

   Mapeamento (baseado na estrutura da planilha, sem depender de casar o nome
   exato de cada coluna):
     - Id ............................ identificador (evita duplicar)
     - Hora de conclusão ............. data da solicitação (dd/mm/aaaa HH:MM)
     - Email / Nome .................. solicitante
     - OPERAÇÃO - N .................. juntas viram o ASSUNTO
     - qualquer célula com URL ....... vira um DOCUMENTO anexado
     - demais textos ................. viram os DETALHES ("Rótulo: valor")

   Uso (na aba Console do Railway, depois de subir o CSV pelo botão Upload):
     node src/importar-csv.js <arquivo.csv>              # DRY-RUN (só mostra)
     node src/importar-csv.js <arquivo.csv> --confirmar  # grava de verdade

   Detecta automaticamente o separador (Tab, ; ou ,) e remove BOM.
   ========================================================================== */

const fs = require('node:fs');
const solicitacoes = require('./solicitacoes');

// --------------------------------------------------------------------------
// Argumentos
// --------------------------------------------------------------------------
const args = process.argv.slice(2);
const confirmar = args.includes('--confirmar');
const arquivo = args.find((a) => !a.startsWith('--'));

if (!arquivo) {
  console.error('Uso: node src/importar-csv.js <arquivo.csv> [--confirmar]');
  process.exit(1);
}
if (!fs.existsSync(arquivo)) {
  console.error(`Arquivo não encontrado: ${arquivo}`);
  process.exit(1);
}

// --------------------------------------------------------------------------
// Leitura + parsing de CSV (com aspas, separador automático)
// --------------------------------------------------------------------------
let texto = fs.readFileSync(arquivo, 'utf8');
if (texto.charCodeAt(0) === 0xfeff) texto = texto.slice(1); // remove BOM

function detectarSeparador(primeiraLinha) {
  const candidatos = ['\t', ';', ','];
  let melhor = ',';
  let max = -1;
  for (const c of candidatos) {
    const n = primeiraLinha.split(c).length - 1;
    if (n > max) { max = n; melhor = c; }
  }
  return melhor;
}

const primeiraQuebra = texto.indexOf('\n');
const sep = detectarSeparador(primeiraQuebra >= 0 ? texto.slice(0, primeiraQuebra) : texto);

// Parser simples que respeita aspas duplas e o separador detectado.
function parseCsv(str, sep) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let dentroAspas = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (dentroAspas) {
      if (ch === '"') {
        if (str[i + 1] === '"') { campo += '"'; i++; }
        else dentroAspas = false;
      } else {
        campo += ch;
      }
      continue;
    }

    if (ch === '"') { dentroAspas = true; continue; }
    if (ch === sep) { linha.push(campo); campo = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { linha.push(campo); linhas.push(linha); linha = []; campo = ''; continue; }
    campo += ch;
  }
  // Último campo/linha (se o arquivo não terminar com quebra).
  if (campo.length > 0 || linha.length > 0) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

const linhas = parseCsv(texto, sep);
if (linhas.length < 2) {
  console.error('O CSV não tem linhas de dados (só o cabeçalho, ou vazio).');
  process.exit(1);
}

const cabecalhos = linhas[0].map((h) => h.trim());
const dados = linhas.slice(1);

// --------------------------------------------------------------------------
// Helpers de mapeamento
// --------------------------------------------------------------------------
const META = ['id', 'hora de início', 'hora de inicio', 'hora de conclusão', 'hora de conclusao', 'email', 'nome'];
const LIXO = ['sdadsad', 'coluna1'];

function ehUrl(v) {
  return /^https?:\/\//i.test(String(v).trim());
}

function rotuloLimpo(h) {
  return h.replace(/[:\s]+$/g, '').trim(); // tira ":" e espaços do fim
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Converte "dd/mm/aaaa HH:MM[:SS]" ou ISO em "AAAA-MM-DD HH:MM:SS".
function parseData(s) {
  const txt = String(s || '').trim();
  if (!txt) return null;

  let m = txt.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0'] = m;
    return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se)}`;
  }

  m = txt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let [, d, mo, y, h = '0', mi = '0', se = '0'] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${pad2(mo)}-${pad2(d)} ${pad2(h)}:${pad2(mi)}:${pad2(se)}`;
  }

  return null; // formato desconhecido -> a importação cai para a data de hoje
}

// Índice de uma coluna pelo nome (trim, case-insensitive).
function idx(nome) {
  const alvo = nome.trim().toLowerCase();
  return cabecalhos.findIndex((h) => h.toLowerCase() === alvo);
}

const iId = idx('Id');
const iData = idx('Hora de conclusão') >= 0 ? idx('Hora de conclusão') : idx('Hora de conclusao');
const iEmail = idx('Email');
const iNome = idx('Nome');

// --------------------------------------------------------------------------
// Monta uma solicitação a partir de uma linha
// --------------------------------------------------------------------------
function montar(linha, numero) {
  const val = (i) => (i >= 0 && i < linha.length ? String(linha[i] ?? '').trim() : '');

  const email = val(iEmail);
  const idForms = val(iId) || `linha-${numero}`;

  const assuntoPartes = [];
  const detalhes = [];
  const anexos = [];

  cabecalhos.forEach((h, i) => {
    const nomeBaixo = h.toLowerCase();
    const valor = val(i);
    if (!valor) return;
    if (META.includes(nomeBaixo) || LIXO.includes(nomeBaixo)) return;

    if (nomeBaixo.startsWith('operação') || nomeBaixo.startsWith('operacao')) {
      assuntoPartes.push(valor);
    } else if (ehUrl(valor)) {
      anexos.push({ nome: rotuloLimpo(h), url: valor });
    } else {
      detalhes.push(`${rotuloLimpo(h)}: ${valor}`);
    }
  });

  return {
    origem_id: `import-forms-${idForms}`,
    solicitante_email: email,
    solicitante_nome: val(iNome) || (email ? email.split('@')[0] : 'Solicitante'),
    assunto: assuntoPartes.join(' | ') || 'Cadastro (importado)',
    detalhes: detalhes.join('\n'),
    anexos,
    status: 'pendente',
    criado_em: parseData(val(iData)),
  };
}

// --------------------------------------------------------------------------
// Execução
// --------------------------------------------------------------------------
console.log(`\nArquivo:    ${arquivo}`);
console.log(`Separador:  ${sep === '\t' ? 'Tab' : sep}`);
console.log(`Colunas:    ${cabecalhos.length}`);
console.log(`Linhas:     ${dados.length}`);
console.log(`Modo:       ${confirmar ? 'GRAVAR (--confirmar)' : 'DRY-RUN (nada será gravado)'}\n`);

(async () => {
  let ok = 0;
  let dup = 0;
  let semEmail = 0;

  for (let n = 0; n < dados.length; n++) {
    const linha = dados[n];

    // Ignora linhas totalmente vazias.
    if (linha.every((c) => String(c ?? '').trim() === '')) continue;

    const s = montar(linha, n + 1);

    if (!s.solicitante_email) {
      semEmail++;
      console.log(`  [linha ${n + 2}] IGNORADA — sem e-mail.`);
      continue;
    }

    if (!confirmar) {
      // Mostra as 5 primeiras como amostra, e conta o resto.
      if (ok < 5) {
        console.log(`  • ${s.criado_em || '(sem data → hoje)'} | ${s.solicitante_nome} <${s.solicitante_email}>`);
        console.log(`      assunto: ${s.assunto}`);
        console.log(`      anexos:  ${s.anexos.length}  ${s.anexos.map((a) => a.nome).join(', ')}`);
      }
      ok++;
      continue;
    }

    const { duplicada } = await solicitacoes.importar(s);
    if (duplicada) dup++;
    else ok++;
  }

  console.log('\n----------------------------------------');
  if (confirmar) {
    console.log(`  ✓ Importadas:  ${ok}`);
    console.log(`  • Já existiam: ${dup}`);
    console.log(`  • Sem e-mail:  ${semEmail}`);
    console.log('\nPronto. Confira no painel do responsável.');
  } else {
    console.log(`  Seriam importadas ~${ok} solicitações (amostra das 5 primeiras acima).`);
    console.log(`  Sem e-mail (seriam ignoradas): ${semEmail}`);
    console.log('\n  Confira as datas e o assunto acima. Se estiver certo, rode de novo com --confirmar.');
  }
  console.log('');
})();
