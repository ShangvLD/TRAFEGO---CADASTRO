/* ============================================================================
   Gerador de ZIP no navegador — mínimo, sem biblioteca externa

   POR QUE NO NAVEGADOR: montar o ZIP no servidor exigiria baixar dezenas de
   arquivos e compactá-los dentro de uma função serverless, que tem limite de
   tempo e de memória. No navegador não há esse teto, e o servidor não paga nada.

   POR QUE SEM COMPRESSÃO (modo "store"): os arquivos são PDF, JPG e PNG — todos
   JÁ comprimidos. Recompactar renderia quase nada e exigiria uma biblioteca de
   deflate. Em modo store o ZIP é só um empacotamento, e escrever isso à mão são
   ~120 linhas, sem dependência nem CDN.

   LIMITES: até 65.535 arquivos e 4 GB por arquivo (formato ZIP clássico, sem
   ZIP64). Para o uso aqui — dezenas de documentos de alguns MB — sobra folga.

   Uso:
     const zip = new ZipSimples();
     zip.adicionar('PASTA/CNH.pdf', uint8array);
     const blob = zip.gerar();
   ========================================================================== */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // CRC-32 — o ZIP exige a soma de verificação de cada arquivo.
  // A tabela é montada uma vez; sem ela, o cálculo bit a bit fica lento.
  // --------------------------------------------------------------------------
  const TABELA_CRC = (function () {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Data/hora no formato MS-DOS, que é o que o ZIP guarda. */
  function dataDos(d) {
    const data = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { data, hora };
  }

  const codificador = new TextEncoder();

  function escritor(tamanho) {
    const buf = new Uint8Array(tamanho);
    const dv = new DataView(buf.buffer);
    let pos = 0;
    return {
      buf,
      u16(v) { dv.setUint16(pos, v, true); pos += 2; },
      u32(v) { dv.setUint32(pos, v, true); pos += 4; },
      bytes(b) { buf.set(b, pos); pos += b.length; },
      get pos() { return pos; },
    };
  }

  class ZipSimples {
    constructor() {
      this.entradas = [];
    }

    /**
     * @param caminho  caminho dentro do ZIP, com "/" para subpasta
     * @param dados    Uint8Array | ArrayBuffer
     */
    adicionar(caminho, dados) {
      const bytes = dados instanceof Uint8Array ? dados : new Uint8Array(dados);
      // Barra invertida quebra a estrutura de pastas em alguns extratores.
      const nome = String(caminho).replace(/\\/g, '/').replace(/^\/+/, '');
      this.entradas.push({ nome: codificador.encode(nome), bytes, crc: crc32(bytes) });
      return this;
    }

    get quantidade() {
      return this.entradas.length;
    }

    /** Monta o arquivo final. Devolve um Blob pronto para download. */
    gerar() {
      if (this.entradas.length > 0xffff) {
        throw new Error('ZIP com mais de 65.535 arquivos exige ZIP64.');
      }

      const { data, hora } = dataDos(new Date());
      const CABECALHO_LOCAL = 30;
      const ENTRADA_CENTRAL = 46;
      const FIM_CENTRAL = 22;

      let tamanhoLocal = 0;
      let tamanhoCentral = 0;
      for (const e of this.entradas) {
        tamanhoLocal += CABECALHO_LOCAL + e.nome.length + e.bytes.length;
        tamanhoCentral += ENTRADA_CENTRAL + e.nome.length;
      }

      const w = escritor(tamanhoLocal + tamanhoCentral + FIM_CENTRAL);
      const deslocamentos = [];

      // ---- Cabeçalho local + conteúdo de cada arquivo ----
      for (const e of this.entradas) {
        deslocamentos.push(w.pos);
        w.u32(0x04034b50); // assinatura
        w.u16(20);         // versão necessária
        w.u16(0x0800);     // nome do arquivo em UTF-8
        w.u16(0);          // método: 0 = armazenado, sem compressão
        w.u16(hora);
        w.u16(data);
        w.u32(e.crc);
        w.u32(e.bytes.length); // tamanho comprimido = original (modo store)
        w.u32(e.bytes.length);
        w.u16(e.nome.length);
        w.u16(0);          // campo extra
        w.bytes(e.nome);
        w.bytes(e.bytes);
      }

      // ---- Diretório central ----
      const inicioCentral = w.pos;
      this.entradas.forEach((e, i) => {
        w.u32(0x02014b50);
        w.u16(20);         // versão de quem criou
        w.u16(20);         // versão necessária
        w.u16(0x0800);
        w.u16(0);
        w.u16(hora);
        w.u16(data);
        w.u32(e.crc);
        w.u32(e.bytes.length);
        w.u32(e.bytes.length);
        w.u16(e.nome.length);
        w.u16(0);          // extra
        w.u16(0);          // comentário
        w.u16(0);          // disco
        w.u16(0);          // atributos internos
        w.u32(0);          // atributos externos
        w.u32(deslocamentos[i]);
        w.bytes(e.nome);
      });

      // O tamanho do diretório central tem que ser medido AQUI, antes de
      // escrever o rodapé — depois, w.pos já andou e a conta sai errada.
      const tamanhoDoCentral = w.pos - inicioCentral;

      // ---- Fim do diretório central ----
      w.u32(0x06054b50);
      w.u16(0);                        // número do disco
      w.u16(0);                        // disco onde começa o diretório
      w.u16(this.entradas.length);     // entradas neste disco
      w.u16(this.entradas.length);     // entradas no total
      w.u32(tamanhoDoCentral);
      w.u32(inicioCentral);
      w.u16(0);                        // comentário

      return new Blob([w.buf], { type: 'application/zip' });
    }
  }

  /** Dispara o download de um Blob com o nome dado. */
  function baixarBlob(blob, nomeArquivo) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomeArquivo;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Libera a memória do Blob depois que o navegador iniciou o download.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  window.ZipSimples = ZipSimples;
  window.baixarBlob = baixarBlob;
})();
