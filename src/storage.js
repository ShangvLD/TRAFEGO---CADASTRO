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

/**
 * Valida um caminho lógico e devolve a forma normalizada.
 *
 * Fica AQUI, e não dentro de um provedor, porque o caminho volta pelo navegador
 * na hora de gravar e de registrar — e cada provedor "confia" de um jeito. O
 * Supabase aceita qualquer chave: sem esta conferência, um caminho trocado
 * escreve na raiz do bucket. Em disco, escreve fora da pasta do canal.
 *
 * Forma aceita, e só ela: CADASTROS/<pasta do cadastro>/<arquivo>
 */
function validarCaminhoLogico(logico) {
  const limpo = String(logico == null ? '' : logico).replace(/\\/g, '/');

  if (!/^CADASTROS\/[^/]+\/[^/]+$/.test(limpo)) {
    throw new Error(`Caminho inválido: "${logico}"`);
  }
  // ".." nunca aparece num caminho que nós geramos (higienizar() remove ponto
  // das pontas), então a presença dele significa caminho adulterado.
  if (limpo.split('/').some((p) => p === '.' || p === '..')) {
    throw new Error(`Caminho inválido: "${logico}"`);
  }
  return limpo;
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

  /**
   * Garante que o bucket existe. Idempotente; roda uma vez por processo.
   *
   * Consulta ANTES de criar porque o Supabase responde "já existe" com HTTP
   * 400 (e "statusCode":"409" no corpo), não com 409 no status — conferir só o
   * status trataria o caso normal como erro.
   */
  async prepararBucket() {
    if (this._pronto) return;

    const existe = await fetch(`${URL_BASE}/storage/v1/bucket/${BUCKET}`, {
      headers: cabecalhos(),
    });
    if (existe.ok) {
      this._pronto = true;
      return;
    }

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

    if (!r.ok) {
      // Corrida entre duas instâncias criando ao mesmo tempo: se o motivo for
      // "já existe", o objetivo foi alcançado de qualquer forma.
      const corpo = await r.text().catch(() => '');
      if (!/already exists|Duplicate|"409"/i.test(corpo)) {
        throw new Error(`Criar bucket falhou (HTTP ${r.status}): ${corpo.slice(0, 300)}`);
      }
    }
    this._pronto = true;
  },

  /**
   * URL assinada para o NAVEGADOR enviar direto ao storage.
   *
   * Por que direto: a função do Vercel tem limite de ~4,5 MB no corpo da
   * requisição. Passando o arquivo por ela, um PDF grande falharia — e ainda
   * gastaria tempo de execução à toa.
   *
   * upsert: sem isso o Supabase recusa com 409 quando a chave já existe, e o
   * envio quebra para sempre naquele caminho. Acontece com objeto órfão (o
   * registro do banco sumiu e o arquivo ficou), e aí a tela mostra "Erro
   * interno" sem que ninguém consiga consertar pelo portal. Sobrescrever é o
   * comportamento certo: chegar no mesmo caminho significa reenviar o mesmo
   * documento — envio de um tipo repetido já ganha sufixo antes de chegar aqui.
   */
  async urlDeUpload(caminho) {
    await this.prepararBucket();
    const r = await conferir(
      await fetch(`${URL_BASE}/storage/v1/object/upload/sign/${BUCKET}/${encodeURI(caminho)}`, {
        method: 'POST',
        // O upsert vai no CABEÇALHO; no corpo o Supabase ignora e responde 409.
        headers: cabecalhos({ 'Content-Type': 'application/json', 'x-upsert': 'true' }),
        body: JSON.stringify({ expiresIn: 60 * 10 }),
      }),
      'Assinar upload'
    );
    const j = await r.json();
    // O token traz o upsert, mas o PUT também precisa do cabeçalho.
    return { url: `${URL_BASE}/storage/v1${j.url}`, metodo: 'PUT', cabecalhos: { 'x-upsert': 'true' } };
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
// Provedor: PASTA — grava numa pasta do disco (canal do Teams via OneDrive)
//
// Para que serve: gravar direto na pasta do canal sincronizada pelo OneDrive.
// O arquivo aparece no Teams sem passar por serviço nenhum e sem depender do
// consentimento do SharePoint.
//
// LIMITAÇÃO INCONTORNÁVEL: só funciona com o app rodando na MÁQUINA que tem a
// pasta. Em produção (Vercel) o app roda num datacenter e não alcança disco de
// ninguém — lá o provedor se declara indisponível.
//
// Diferença de fluxo: no Supabase o navegador envia direto ao storage por URL
// assinada. Aqui não existe URL para gravar em disco, então o arquivo PASSA
// PELO SERVIDOR (uploadDireto = false). Rodando local isso não é problema; o
// limite de 4,5 MB no corpo da requisição é do Vercel, que não está no caminho.
// ---------------------------------------------------------------------------
const fs = require('node:fs');
const caminhoDeSistema = require('node:path');

const PASTA_BASE = process.env.PASTA_CANAL || '';

/**
 * Converte o caminho lógico ("CADASTROS/JOAO_.../CNH.pdf") em caminho de disco.
 *
 * O prefixo "CADASTROS/" é descartado: a pasta configurada JÁ é a raiz dos
 * cadastros, e repetir criaria ".../CADASTROS/CADASTROS/...".
 *
 * Valida contra travessia de diretório: o caminho volta do navegador na hora de
 * registrar o arquivo, então ".." ou caminho absoluto poderia escrever fora da
 * pasta. O resultado é conferido para estar DENTRO da base.
 */
function caminhoEmDisco(logico) {
  const limpo = validarCaminhoLogico(logico);
  const relativo = limpo.replace(/^CADASTROS\//, '');
  const destino = caminhoDeSistema.resolve(PASTA_BASE, ...relativo.split('/'));
  const base = caminhoDeSistema.resolve(PASTA_BASE);
  if (destino !== base && !destino.startsWith(base + caminhoDeSistema.sep)) {
    throw new Error(`Caminho fora da pasta permitida: "${logico}"`);
  }
  return destino;
}

const pasta = {
  nome: 'pasta',
  uploadDireto: false, // o arquivo passa pelo servidor

  disponivel() {
    if (!PASTA_BASE) return false;
    try {
      return fs.statSync(PASTA_BASE).isDirectory();
    } catch {
      return false;
    }
  },

  /** Não há URL para gravar em disco: o servidor recebe e grava. */
  async urlDeUpload() {
    return { url: null, metodo: 'POST', direto: false };
  },

  async enviar(logico, buffer, _contentType) {
    const destino = caminhoEmDisco(logico);
    fs.mkdirSync(caminhoDeSistema.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, buffer);
    return { caminho: logico };
  },

  async baixar(logico) {
    return fs.readFileSync(caminhoEmDisco(logico));
  },

  /** Sem URL pública: quem lê é o próprio servidor, pela rota de download. */
  async urlDeLeitura() {
    return null;
  },

  async remover(logico) {
    const destino = caminhoEmDisco(logico);
    try {
      fs.unlinkSync(destino);
      // Remove a pasta do cadastro se ficou vazia, para não acumular pasta
      // órfã no canal a cada exclusão.
      const dir = caminhoDeSistema.dirname(destino);
      if (fs.readdirSync(dir).filter((n) => n !== 'desktop.ini').length === 0) {
        fs.rmdirSync(dir);
      }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
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

const PROVEDORES = { supabase, pasta, memoria };

/**
 * Provedor em uso.
 *
 * STORAGE_PROVEDOR manda, quando definido — mas só se estiver DISPONÍVEL: pedir
 * "pasta" em produção não faria o upload gravar em lugar nenhum.
 *
 * Na dúvida, Supabase. É o único que o site alcança rodando no Vercel; gravar
 * na pasta por engano deixaria o documento sem abrir em produção, e isso só
 * aparece depois, quando alguém precisa do arquivo.
 */
function provedor() {
  const escolhido = process.env.STORAGE_PROVEDOR;
  if (escolhido && PROVEDORES[escolhido] && PROVEDORES[escolhido].disponivel()) {
    return PROVEDORES[escolhido];
  }
  if (supabase.disponivel()) return supabase;
  if (pasta.disponivel()) return pasta;

  // Nunca cair em "memoria" sozinho. Memória aceita o arquivo e o perde no
  // reinício — em produção isso seria upload que parece funcionar e some, e
  // ninguém descobre até precisarem do documento. Devolvendo o Supabase
  // indisponível, prepararEnvio() recusa com "armazenamento não configurado",
  // que é a verdade. Para teste automatizado, peça memoria explicitamente.
  return supabase;
}

/**
 * Provedor pelo NOME gravado junto com o documento.
 *
 * O mesmo banco atende dois ambientes: a máquina local (que grava na pasta do
 * canal) e o Vercel (que grava no Supabase). Um arquivo que está na pasta não
 * está no Supabase. Ler sempre pelo provedor atual devolveria link assinado
 * para um objeto inexistente — erro sem explicação, do tipo que faz perder
 * tempo procurando.
 *
 * Devolve null quando aquele provedor não existe neste ambiente; quem chama
 * transforma isso numa mensagem que diz o que houve.
 */
function provedorDe(nome) {
  if (!nome) return provedor(); // registro antigo, sem provedor gravado
  const p = PROVEDORES[nome];
  return p && p.disponivel() ? p : null;
}

/** O upload passa pelo servidor (true) ou vai direto ao storage (false)? */
function uploadPassaPeloServidor() {
  return provedor().uploadDireto === false;
}

module.exports = {
  provedor,
  provedorDe,
  uploadPassaPeloServidor,
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
  validarCaminhoLogico,
  validarArquivo,
};
