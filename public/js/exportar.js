/* ============================================================================
   Exportação de documentos em ZIP

   Pede ao portal o manifesto (lista de arquivos com URL temporária de cada um),
   baixa os arquivos no navegador e empacota tudo com o ZipSimples.

   POR QUE NO NAVEGADOR: baixar dezenas de arquivos e compactá-los dentro de uma
   função serverless estouraria o limite de tempo e de memória do Vercel. Aqui
   não há esse teto — e o servidor só devolve uma lista de URLs, o que é barato.

   O nome de cada arquivo e a pasta vêm do CAMINHO já gravado no envio, não são
   remontados: assim o ZIP reflete exatamente como os documentos estão guardados.

   Depende de /js/zip.js.
   ========================================================================== */

(function () {
  'use strict';

  /** Baixa um arquivo pela URL assinada. */
  async function baixar(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  function dataDeHoje() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}_${p(d.getMonth() + 1)}_${d.getFullYear()}`;
  }

  /**
   * @param modulo   slug do módulo
   * @param ids      ids das solicitações a exportar
   * @param aoAndar  (feitos, total, mensagem) — para mostrar o progresso
   * @returns { ok, arquivos, falhas } ou { ok:false, erro }
   */
  async function exportarDocumentos(modulo, ids, aoAndar) {
    const avisar = (feitos, total, msg) => aoAndar && aoAndar(feitos, total, msg);

    avisar(0, 0, 'Consultando documentos...');
    const r = await fetch(`/api/modulos/${modulo}/exportar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) return { ok: false, erro: j.erro || 'Não foi possível listar os documentos.' };

    const legados = j.legados || [];
    const indisponiveis = j.indisponiveis || [];

    // Nada enviado pelo portal E nada no Forms: aí realmente não há o que levar.
    if (!j.itens.length && !legados.length && !indisponiveis.length) {
      return { ok: false, erro: 'Os cadastros selecionados não têm nenhum documento.' };
    }

    if (!j.itens.length && indisponiveis.length && !legados.length) {
      return { ok: false, erro: indisponiveis[0].motivo };
    }

    const zip = new window.ZipSimples();
    const falhas = [];
    let feitos = 0;

    // ---- Anexos antigos do Forms: vão como lista de links ----
    //
    // Não dá para baixá-los aqui: estão no SharePoint, exigem login M365 e a
    // requisição do navegador bateria em CORS. Um arquivo de texto com os links
    // é o que a exportação pode entregar de útil para os cadastros antigos.
    if (legados.length) {
      const linhas = [
        'ANEXOS NO MICROSOFT FORMS / SHAREPOINT',
        '',
        'Estes arquivos NÃO estão no portal: foram enviados pelo Microsoft Forms',
        'e ficam no SharePoint. Não é possível baixá-los automaticamente porque',
        'exigem login no Microsoft 365 — abra os links abaixo já autenticado.',
        '',
        '='.repeat(72),
        '',
      ];

      for (const c of legados) {
        linhas.push(`SOLICITAÇÃO #${c.solicitacaoId}   ${c.criadoEm || ''}`);
        linhas.push(`Solicitante: ${c.solicitante || '—'}`);
        // Texto limpo: o assunto cru traz os "| | |" das colunas vazias do Forms.
        const clientes = window.clientesTexto ? window.clientesTexto(c.assunto) : c.assunto;
        if (clientes) linhas.push(`Assunto: ${clientes}`);
        linhas.push(`Arquivos: ${c.arquivos.length}`);
        linhas.push('');
        c.arquivos.forEach((a, i) => {
          linhas.push(`  ${i + 1}. ${a.nome}`);
          linhas.push(`     ${a.url}`);
        });
        linhas.push('');
        linhas.push('-'.repeat(72));
        linhas.push('');
      }

      zip.adicionar('ANEXOS_NO_FORMS_SHAREPOINT.txt', new TextEncoder().encode(linhas.join('\r\n')));
    }

    // ---- Documentos que este ambiente não alcança ----
    //
    // Existem, mas estão num armazenamento fora do alcance de quem está
    // exportando (na pasta do canal, com o portal rodando no Vercel). Omitir
    // faria o ZIP parecer completo sem ser.
    if (indisponiveis.length) {
      const linhas = [
        'DOCUMENTOS NÃO INCLUÍDOS NESTE ZIP',
        '',
        `${indisponiveis.length} arquivo(s) estão cadastrados mas não puderam ser baixados:`,
        '',
        '='.repeat(72),
        '',
      ];
      for (const d of indisponiveis) {
        linhas.push(`${d.pasta}/${d.nome}`);
        linhas.push(`   ${d.motivo}`);
        linhas.push('');
      }
      zip.adicionar('DOCUMENTOS_NAO_EXPORTADOS.txt', new TextEncoder().encode(linhas.join('\r\n')));
    }

    for (const item of j.itens) {
      avisar(feitos, j.itens.length, `Baixando ${item.nome}...`);
      try {
        zip.adicionar(`${item.pasta}/${item.nome}`, await baixar(item.url));
      } catch (e) {
        // Um arquivo com problema não deve impedir a exportação dos outros —
        // mas precisa ser reportado, senão o ZIP sai incompleto em silêncio.
        falhas.push(`${item.pasta}/${item.nome}`);
      }
      feitos++;
    }

    if (!zip.quantidade) {
      return { ok: false, erro: 'Nenhum arquivo pôde ser baixado.' };
    }

    avisar(feitos, j.itens.length, 'Montando o arquivo ZIP...');
    const nome =
      ids.length === 1 && j.itens.length
        ? `${j.itens[0].pasta}.zip`
        : `cadastros_${dataDeHoje()}.zip`;

    window.baixarBlob(zip.gerar(), nome);
    return {
      ok: true,
      arquivos: j.itens.length,          // baixados do portal
      legados: j.totalLegados || 0,      // apenas listados (estão no SharePoint)
      indisponiveis: indisponiveis.length, // fora do alcance deste ambiente
      falhas,
      nome,
    };
  }

  window.exportarDocumentos = exportarDocumentos;
})();
