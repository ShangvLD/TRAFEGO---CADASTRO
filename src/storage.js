/* ============================================================================
   Armazenamento de arquivos — camada trocável

   POR QUE NÃO O DISCO DO SERVIDOR: o Vercel executa o app em funções
   serverless. O diretório do projeto é somente leitura, "/tmp" é descartado a
   cada invocação e nada é compartilhado entre instâncias — arquivo gravado ali
   desaparece sozinho. Guardar arquivo exige um serviço de objetos.

   PROVEDORES
     supabase  (padrão)  Supabase Storage, que já faz parte do projeto.
     memoria             só para teste automatizado; some ao reiniciar.

   O SharePoint entra aqui como um terceiro provedor quando o consentimento do
   Sites.Selected sair: o resto do sistema fala com esta interface e não sabe
   onde o arquivo está. Trocar o destino vira configuração, não reescrita.

   INTERFACE
     urlDeUpload(caminho, contentType)  -> { url, metodo, cabecalhos }
     enviar(caminho, buffer, contentType)
     baixar(caminho)                    -> Buffer
     urlDeLeitura(caminho, segundos)    -> URL temporária
     remover(caminho)
     disponivel()                       -> false quando não está configurado
   ========================================================================== */

require('dotenv').config();

const BUCKET = process.env.SUPABASE_BUCKET || 'cadastros';

// A URL do projeto pode ser deduzida da string de conexão do banco, que já
// existe: o host do pooler carrega a referência do projeto.
function urlDoProjeto() {
  if (process.env.SUPABASE_URL) return process.env.SUPABASE_URL.replace(/\/+$/, '');

  const conn = process.env.DATABASE_URL || '';
  const m = conn.match(/postgres\.([a-z0-9]{20})/i);
  return m ? `https://${m[1]}.supabase.co` : null;
}

const URL_BASE = urlDoProjeto();
const CHAVE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ---------------------------------------------------------------------------
// Nomes de arquivo e de pasta
// ---------------------------------------------------------------------------

/** Remove acentos, espaços e tudo que não seja letra, número, "_", "-" ou ".". */
function higienizar(texto, { permitirPonto = false } = {}) {
  const permitidos = permitirPonto ? /[^A-Za-z0-9._-]+/g : /[^A-Za-z0-9_-]+/g;
  return String(texto == null ? '' : texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(permitidos, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
}

/** Extensão do arquivo, em minúsculas e sem o ponto. */
function extensaoDe(nomeArquivo) {
  const m = String(nomeArquivo || '').match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Pasta do cadastro: "CADASTROS/JOAO_DA_SILVA_12345678900".
 * Nome e CPF juntos porque nome sozinho repete (dois "João Silva") e CPF
 * sozinho não diz nada a quem abre a pasta.
 */
function pastaDoCadastro(nome, cpf) {
  const n = higienizar(nome) || 'SEM_NOME';
  const d = String(cpf || '').replace(/\D+/g, '') || 'SEM_CPF';
  return `CADASTROS/${n}_${d}`;
}

/**
 * Caminho final do arquivo. O nome vem do TIPO do documento, não do arquivo
 * original — é o que garante "CNH.pdf" em vez de
 * "WhatsApp Image 2026-07-29 at 08.13.12_Melissa Pontes.jpeg".
 *
 * @param sufixo  usado quando o mesmo tipo é enviado mais de uma vez (CNH_2)
 */
function caminhoDoArquivo(pasta, tipo, nomeOriginal, sufixo = 0) {
  const ext = extensaoDe(nomeOriginal);
  const base = higienizar(tipo) || 'DOCUMENTO';
  const numero = sufixo > 0 ? `_${sufixo + 1}` : '';
  return `${pasta}/${base}${numero}${ext ? '.' + ext : ''}`;
}

// ---------------------------------------------------------------------------
// Tipos e tamanho aceitos
// ---------------------------------------------------------------------------
const TIPOS_ACEITOS = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
};

const EXTENSOES_ACEITAS = ['pdf', 'jpg', 'jpeg', 'png'];

/** Tamanho máximo por arquivo, em MB (configurável). */
const TAMANHO_MAXIMO_MB = Number(process.env.UPLOAD_MAX_MB || 15);
const TAMANHO_MAXIMO = TAMANHO_MAXIMO_MB * 1024 * 1024;

function validarArquivo({ nome, contentType, tamanho }) {
  const ext = extensaoDe(nome);

  if (!EXTENSOES_ACEITAS.includes(ext)) {
    return { ok: false, erro: `Formato não aceito. Envie ${EXTENSOES_ACEITAS.join(', ')}.` };
  }
  // O content-type vem do navegador e é falsificável; a extensão também. Aqui
  // os dois precisam bater, o que já barra o engano comum (renomear .exe
  // para .pdf não passa, porque o navegador manda o tipo real).
  if (contentType && !TIPOS_ACEITOS[String(contentType).toLowerCase()]) {
    return { ok: false, erro: `Tipo de arquivo não aceito (${contentType}).` };
  }
  if (tamanho != null && Number(tamanho) > TAMANHO_MAXIMO) {
    return { ok: false, erro: `Arquivo maior que ${TAMANHO_MAXIMO_MB} MB.` };
  }
  if (tamanho != null && Number(tamanho) <= 0) {
    return { ok: false, erro: 'Arquivo vazio.' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Provedor: Supabase Storage (via API REST, sem dependência nova)
// ---------------------------------------------------------------------------
function cabecalhos(extra = {}) {
  return { Authorization: `Bearer ${CHAVE}`, apikey: CHAVE, ...extra };
}

async function conferir(resposta, oQue) {
  if (resposta.ok) return resposta;
  const corpo = await resposta.text().catch(() => '');
  throw new Error(`${oQue} falhou (HTTP ${resposta.status}): ${corpo.slice(0, 300)}`);
}

const supabase = {
  nome: 'supabase',

  disponivel() {
    return !!(URL_BASE && CHAVE);
  },

  /** Garante que o bucket existe. Idempotente; roda uma vez por processo. */
  async prepararBucket() {
    if (this._pronto) return;
    const r = await fetch(`${URL_BASE}/storage/v1/bucket`, {
      method: 'POST',
      headers: cabecalhos({ 'Content-Type': 'application/json' }),
      // Privado: os arquivos só são acessíveis por URL assinada, com validade.
      body: JSON.stringify({
        id: BUCKET,
        name: BUCKET,
        public: false,
        file_size_limit: TAMANHO_MAXIMO,
        allowed_mime_types: Object.keys(TIPOS_ACEITOS),
      }),
    });
    // 409 = já existe, que é o caso normal a partir da segunda vez.
    if (!r.ok && r.status !== 409) await conferir(r, 'Criar bucket');
    this._pronto = true;
  },

  /**
   * URL assinada para o NAVEGADOR enviar direto ao storage.
   *
   * Por que direto: a função do Vercel tem limite de ~4,5 MB no corpo da
   * requisição. Passando o arquivo por ela, um PDF grande falharia — e ainda
   * gastaria tempo de execução à toa.
   */
  async urlDeUpload(caminho) {
    await this.prepararBucket();
    const r = await conferir(
      await fetch(`${URL_BASE}/storage/v1/object/upload/sign/${BUCKET}/${encodeURI(caminho)}`, {
        method: 'POST',
        headers: cabecalhos({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: 60 * 10 }),
      }),
      'Assinar upload'
    );
    const j = await r.json();
    return { url: `${URL_BASE}/storage/v1${j.url}`, metodo: 'PUT' };
  },

  async enviar(caminho, buffer, contentType) {
    await this.prepararBucket();
    await conferir(
      await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${encodeURI(caminho)}`, {
        method: 'POST',
        headers: cabecalhos({ 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' }),
        body: buffer,
      }),
      'Enviar arquivo'
    );
    return { caminho };
  },

  async baixar(caminho) {
    const r = await conferir(
      await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${encodeURI(caminho)}`, {
        headers: cabecalhos(),
      }),
      'Baixar arquivo'
    );
    return Buffer.from(await r.arrayBuffer());
  },

  /** URL temporária de leitura — o navegador baixa sem passar pelo servidor. */
  async urlDeLeitura(caminho, segundos = 600) {
    const r = await conferir(
      await fetch(`${URL_BASE}/storage/v1/object/sign/${BUCKET}/${encodeURI(caminho)}`, {
        method: 'POST',
        headers: cabecalhos({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ expiresIn: segundos }),
      }),
      'Assinar leitura'
    );
    const j = await r.json();
    return `${URL_BASE}/storage/v1${j.signedURL || j.signedUrl}`;
  },

  async remover(caminho) {
    const r = await fetch(`${URL_BASE}/storage/v1/object/${BUCKET}/${encodeURI(caminho)}`, {
      method: 'DELETE',
      headers: cabecalhos(),
    });
    // 404 = já não existe; para quem chamou, o efeito é o mesmo.
    if (!r.ok && r.status !== 404) await conferir(r, 'Remover arquivo');
    return true;
  },
};

// ---------------------------------------------------------------------------
// Provedor: memória (teste automatizado)
// ---------------------------------------------------------------------------
const memoria = {
  nome: 'memoria',
  _arquivos: new Map(),
  disponivel: () => true,
  async urlDeUpload(caminho) {
    return { url: `memoria://${caminho}`, metodo: 'PUT' };
  },
  async enviar(caminho, buffer, contentType) {
    this._arquivos.set(caminho, { buffer: Buffer.from(buffer), contentType });
    return { caminho };
  },
  async baixar(caminho) {
    const a = this._arquivos.get(caminho);
    if (!a) throw new Error(`Arquivo não encontrado: ${caminho}`);
    return a.buffer;
  },
  async urlDeLeitura(caminho) {
    return `memoria://${caminho}`;
  },
  async remover(caminho) {
    this._arquivos.delete(caminho);
    return true;
  },
};

const PROVEDORES = { supabase, memoria };

/** Provedor em uso. Cai para "memoria" quando o Supabase não está configurado. */
function provedor() {
  const escolhido = process.env.STORAGE_PROVEDOR;
  if (escolhido && PROVEDORES[escolhido]) return PROVEDORES[escolhido];
  return supabase.disponivel() ? supabase : memoria;
}

module.exports = {
  provedor,
  PROVEDORES,
  BUCKET,
  TAMANHO_MAXIMO,
  TAMANHO_MAXIMO_MB,
  EXTENSOES_ACEITAS,
  TIPOS_ACEITOS,
  higienizar,
  extensaoDe,
  pastaDoCadastro,
  caminhoDoArquivo,
  validarArquivo,
};
