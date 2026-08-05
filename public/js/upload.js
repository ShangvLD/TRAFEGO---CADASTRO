/* ============================================================================
   Envio de documentos — componente compartilhado

   O arquivo NÃO passa pelo servidor do portal. São três passos:

     1. o portal devolve uma URL assinada e o caminho final do arquivo;
     2. o navegador envia o arquivo DIRETO ao armazenamento, por essa URL;
     3. o portal registra que o arquivo chegou.

   Motivo: a função serverless do Vercel tem limite de ~4,5 MB no corpo da
   requisição — um CRLV escaneado passa disso. Enviando direto, o limite deixa
   de existir e o servidor não gasta tempo de execução com transferência.

   O passo 2 usa XMLHttpRequest em vez de fetch porque só ele reporta
   progresso de envio, que é o que permite mostrar a barra.

   Uso:
     montarUpload(elemento, { modulo, solicitacaoId, documentos, aoMudar });
   ========================================================================== */

(function () {
  'use strict';

  function esc(t) {
    const d = document.createElement('div');
    d.textContent = t == null ? '' : String(t);
    return d.innerHTML;
  }

  function formatarTamanho(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /**
   * Envia o arquivo, reportando o progresso.
   *
   * O destino vem do /preparar: URL assinada do storage (Supabase) ou uma rota
   * do próprio portal (quando o arquivo tem que passar pelo servidor). Os
   * cabeçalhos extras também vêm de lá — cada storage pede os seus.
   */
  function enviarArquivo(url, metodo, arquivo, extras, aoProgredir) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(metodo || 'PUT', url, true);
      xhr.setRequestHeader('Content-Type', arquivo.type || 'application/octet-stream');
      for (const [k, v] of Object.entries(extras || {})) xhr.setRequestHeader(k, v);

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && aoProgredir) aoProgredir(Math.round((ev.loaded / ev.total) * 100));
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`Falha no envio (HTTP ${xhr.status})`));
      xhr.onerror = () => reject(new Error('Falha de conexão durante o envio.'));
      xhr.send(arquivo);
    });
  }

  /**
   * @param el          contêiner onde a lista é desenhada
   * @param opcoes.modulo         slug do módulo
   * @param opcoes.solicitacaoId  id da solicitação já criada
   * @param opcoes.documentos     [{ codigo, rotulo, obrigatorio, condicionadoA }]
   * @param opcoes.aoMudar        chamado após cada envio/exclusão
   */
  function montarUpload(el, opcoes) {
    const { modulo, solicitacaoId, documentos } = opcoes;
    const base = `/api/modulos/${modulo}/solicitacoes/${solicitacaoId}/documentos`;
    let enviados = [];

    async function carregar() {
      try {
        const r = await fetch(base);
        const j = await r.json();
        enviados = j.ok ? j.documentos : [];
      } catch (e) {
        enviados = [];
      }
      desenhar();
      if (opcoes.aoMudar) opcoes.aoMudar(enviados);
    }

    function enviadosDoTipo(codigo) {
      return enviados.filter((d) => d.tipo === codigo);
    }

    function desenhar() {
      el.innerHTML = documentos
        .map((d) => {
          const arquivos = enviadosDoTipo(d.codigo);
          const completo = arquivos.length > 0;

          const listaArquivos = arquivos
            .map(
              (a) => `<div class="up-arquivo">
                  <span class="material-symbols-rounded">description</span>
                  <a href="#" class="up-abrir" data-doc="${a.id}">${esc(a.nome_arquivo)}</a>
                  <span class="up-tam">${formatarTamanho(a.tamanho)}</span>
                  <button type="button" class="up-remover" data-doc="${a.id}" title="Remover">
                    <span class="material-symbols-rounded">close</span>
                  </button>
                </div>`
            )
            .join('');

          return `<div class="up-item${completo ? ' up-ok' : ''}" data-tipo="${esc(d.codigo)}">
              <div class="up-cabeca">
                <span class="material-symbols-rounded up-icone">${completo ? 'check_circle' : 'upload_file'}</span>
                <span class="up-rotulo">${esc(d.rotulo)}</span>
                ${d.obrigatorio ? '<span class="doc-tag" style="background:var(--danger-soft);color:var(--danger)">obrigatório</span>' : '<span class="doc-tag">opcional</span>'}
                <label class="btn btn--secundario up-escolher">
                  <span class="material-symbols-rounded">attach_file</span>
                  ${completo ? 'Enviar outro' : 'Escolher arquivo'}
                  <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" hidden>
                </label>
              </div>
              ${listaArquivos}
              <div class="up-barra" hidden><div class="up-barra__preenchida"></div></div>
              <div class="up-erro" hidden></div>
            </div>`;
        })
        .join('');
    }

    async function subir(item, tipo, arquivo) {
      const barra = item.querySelector('.up-barra');
      const preenchida = item.querySelector('.up-barra__preenchida');
      const erroEl = item.querySelector('.up-erro');

      erroEl.hidden = true;
      barra.hidden = false;
      preenchida.style.width = '0%';

      try {
        // 1) pedir a URL assinada
        const rPrep = await fetch(`${base}/preparar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tipo,
            nomeArquivo: arquivo.name,
            contentType: arquivo.type,
            tamanho: arquivo.size,
          }),
        });
        const prep = await rPrep.json();
        if (!rPrep.ok || !prep.ok) throw new Error(prep.erro || 'Não foi possível preparar o envio.');

        // 2) enviar direto ao armazenamento
        await enviarArquivo(prep.url, prep.metodo, arquivo, prep.cabecalhos, (pct) => {
          preenchida.style.width = pct + '%';
        });

        // 3) registrar no portal
        const rReg = await fetch(`${base}/registrar`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tipo,
            caminho: prep.caminho,
            nomeOriginal: arquivo.name,
            contentType: arquivo.type,
            tamanho: arquivo.size,
            provedor: prep.provedor,
          }),
        });
        const reg = await rReg.json();
        if (!rReg.ok || !reg.ok) throw new Error(reg.erro || 'Arquivo enviado, mas não registrado.');

        await carregar();
      } catch (e) {
        erroEl.textContent = e.message;
        erroEl.hidden = false;
        barra.hidden = true;
      }
    }

    // ---- Eventos (delegados: a lista é redesenhada a cada mudança) ----
    el.addEventListener('change', (ev) => {
      const input = ev.target;
      if (input.type !== 'file' || !input.files || !input.files[0]) return;
      const item = input.closest('.up-item');
      subir(item, item.dataset.tipo, input.files[0]);
      input.value = ''; // permite escolher o mesmo arquivo de novo
    });

    el.addEventListener('click', async (ev) => {
      const abrir = ev.target.closest('.up-abrir');
      if (abrir) {
        ev.preventDefault();
        const r = await fetch(`${base}/${abrir.dataset.doc}/url`);
        const j = await r.json();
        if (j.ok) window.open(j.url, '_blank', 'noopener');
        return;
      }

      const remover = ev.target.closest('.up-remover');
      if (remover) {
        if (!confirm('Remover este arquivo?')) return;
        await fetch(`${base}/${remover.dataset.doc}`, { method: 'DELETE' });
        await carregar();
      }
    });

    carregar();

    return {
      recarregar: carregar,
      /** Documentos obrigatórios ainda sem arquivo. */
      pendentes() {
        return documentos
          .filter((d) => d.obrigatorio && !enviadosDoTipo(d.codigo).length)
          .map((d) => d.rotulo);
      },
    };
  }

  window.montarUpload = montarUpload;
})();
