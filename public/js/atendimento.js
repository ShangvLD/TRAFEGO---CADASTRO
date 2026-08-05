/* ============================================================================
   Atendimento: quem está cuidando de cada cadastro

   Duas coisas, usadas pelas telas de solicitações recebidas (a do terceiro e a
   genérica dos outros módulos):

     perguntarComoParticipar(modulo, id)  modal antes de abrir o cadastro
     selo(resumo)                         o que aparece na linha da listagem

   POR QUE PERGUNTAR ANTES E NÃO DEPOIS: o objetivo é evitar duas pessoas
   trabalhando no mesmo cadastro sem saber. Registrar na saída não evita nada —
   o retrabalho já aconteceu.

   Quem já está participando não vê o modal de novo: reabrir a tela não é uma
   decisão nova.
   ========================================================================== */

(function () {
    'use strict';

    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    /** "04/08/2026 às 14:35", já no fuso de quem lê (o banco grava em UTC). */
    function quando(valor) {
        if (!valor) return '';
        if (window.dataHoraPorExtenso) return window.dataHoraPorExtenso(valor);
        return String(valor);
    }

    function primeiroNome(nome) {
        return String(nome || '').trim().split(/\s+/).slice(0, 2).join(' ');
    }

    // -----------------------------------------------------------------------
    // Selo da listagem
    // -----------------------------------------------------------------------

    /**
     * HTML do estado de atendimento de uma linha.
     * Sem ninguém participando devolve um traço, e não uma célula vazia — em
     * tabela, célula vazia parece dado faltando em vez de "ninguém pegou".
     */
    function selo(resumo) {
        if (!resumo || !resumo.emAtendimento) {
            return '<span class="at-livre">livre</span>';
        }

        const r = resumo.responsavel;
        const n = (resumo.colaboradores || []).length;

        const partes = [
            `<span class="at-badge"><span class="material-symbols-rounded">headset_mic</span>Em atendimento</span>`,
        ];
        partes.push(
            r
                ? `<span class="at-linha"><strong>${esc(primeiroNome(r.nome))}</strong></span>`
                : `<span class="at-linha at-sem-dono">sem responsável</span>`
        );
        if (n) {
            partes.push(`<span class="at-linha">+ ${n} colaborador${n > 1 ? 'es' : ''}</span>`);
        }
        if (resumo.atualizadoEm) {
            partes.push(`<span class="at-linha at-quando">${esc(quando(resumo.atualizadoEm))}</span>`);
        }
        return `<div class="at-cel">${partes.join('')}</div>`;
    }

    // -----------------------------------------------------------------------
    // Modal
    // -----------------------------------------------------------------------
    let overlayEl = null;

    function garantirOverlay() {
        if (overlayEl) return overlayEl;
        overlayEl = document.createElement('div');
        overlayEl.className = 'at-overlay';
        overlayEl.hidden = true;
        overlayEl.innerHTML = `
            <div class="at-modal" role="dialog" aria-modal="true" aria-labelledby="at-titulo">
                <h3 id="at-titulo">Como você deseja participar deste cadastro?</h3>
                <div class="at-estado" id="at-estado"></div>
                <div class="at-opcoes">
                    <button type="button" class="at-op at-op--principal" data-papel="responsavel">
                        <span class="material-symbols-rounded">assignment_ind</span>
                        <span>
                            <strong>Assumir atendimento</strong>
                            <small>Você passa a ser o responsável principal.</small>
                        </span>
                    </button>
                    <button type="button" class="at-op" data-papel="colaborador">
                        <span class="material-symbols-rounded">group_add</span>
                        <span>
                            <strong>Participar como colaborador</strong>
                            <small>Acompanha e ajuda, sem substituir o responsável.</small>
                        </span>
                    </button>
                </div>
                <div class="at-erro" id="at-erro" hidden></div>
                <div class="at-rodape">
                    <button type="button" class="at-cancelar" data-papel="">Cancelar</button>
                </div>
            </div>`;
        document.body.appendChild(overlayEl);
        return overlayEl;
    }

    /**
     * Mostra o modal e devolve o papel escolhido, ou null se cancelou.
     *
     * @param opcoes.ehAdmin  habilita assumir um cadastro que já tem dono
     * @returns {Promise<'responsavel'|'colaborador'|null>}
     */
    async function perguntarComoParticipar(modulo, id, opcoes) {
        const cfg = opcoes || {};
        const base = `/api/modulos/${modulo}/solicitacoes/${id}/atendimento`;

        // Já participa? Então não há decisão a tomar — segue direto.
        let estado = {};
        try {
            const r = await fetch(base);
            estado = await r.json();
            if (estado.ok && estado.minhaParticipacao) return estado.minhaParticipacao.papel;
        } catch (e) {
            // Sem resposta do servidor, não trava a abertura do cadastro: a
            // pessoa precisa trabalhar, e o registro é o secundário aqui.
            return null;
        }

        const ov = garantirOverlay();
        const elEstado = ov.querySelector('#at-estado');
        const elErro = ov.querySelector('#at-erro');
        const btnAssumir = ov.querySelector('[data-papel="responsavel"]');

        elErro.hidden = true;
        elEstado.innerHTML = estado.emAtendimento
            ? `<div class="at-ja">${selo(estado)}</div>`
            : '<div class="at-ja at-ja--livre">Ninguém está cuidando deste cadastro ainda.</div>';

        // Cadastro com dono: "assumir" vira transferência, e só o admin pode.
        const temOutroDono = !!(estado.responsavel && estado.responsavel.id !== cfg.usuarioId);
        btnAssumir.querySelector('strong').textContent = temOutroDono
            ? 'Assumir o atendimento (transferir)'
            : 'Assumir atendimento';
        btnAssumir.disabled = temOutroDono && !cfg.ehAdmin;
        btnAssumir.title = btnAssumir.disabled
            ? `${estado.responsavel.nome} já assumiu. Peça a um administrador para transferir.`
            : '';

        ov.hidden = false;
        document.body.style.overflow = 'hidden';

        return new Promise((resolve) => {
            function encerrar(valor) {
                ov.hidden = true;
                document.body.style.overflow = '';
                ov.removeEventListener('click', aoClicar);
                document.removeEventListener('keydown', aoTeclar);
                resolve(valor);
            }

            async function aoClicar(ev) {
                if (ev.target === ov) return encerrar(null);
                const btn = ev.target.closest('[data-papel]');
                if (!btn) return;

                const papel = btn.dataset.papel;
                if (!papel) return encerrar(null); // Cancelar

                btn.disabled = true;
                try {
                    const r = await fetch(base, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ papel, forcar: papel === 'responsavel' && temOutroDono }),
                    });
                    const j = await r.json();
                    if (!j.ok) {
                        elErro.textContent = j.erro || 'Não foi possível registrar.';
                        elErro.hidden = false;
                        btn.disabled = false;
                        return;
                    }
                    if (cfg.aoEntrar) cfg.aoEntrar(j);
                    encerrar(papel);
                } catch (e) {
                    elErro.textContent = 'Falha de conexão.';
                    elErro.hidden = false;
                    btn.disabled = false;
                }
            }

            function aoTeclar(ev) {
                if (ev.key === 'Escape') encerrar(null);
            }

            ov.addEventListener('click', aoClicar);
            document.addEventListener('keydown', aoTeclar);
        });
    }

    /** Sai do atendimento. */
    async function sair(modulo, id) {
        const r = await fetch(`/api/modulos/${modulo}/solicitacoes/${id}/atendimento`, { method: 'DELETE' });
        return r.json().catch(() => ({ ok: false }));
    }

    /** Bloco de detalhe, para o modal do cadastro. */
    function detalhe(resumo) {
        if (!resumo || !resumo.emAtendimento) return '';
        const r = resumo.responsavel;
        const cols = resumo.colaboradores || [];
        return `<div class="at-detalhe">
            <div class="at-detalhe__titulo">
                <span class="material-symbols-rounded">headset_mic</span> Em atendimento
            </div>
            <div>Responsável: <strong>${r ? esc(r.nome) : '—'}</strong>${r ? ` <small>desde ${esc(quando(r.desde))}</small>` : ''}</div>
            ${cols.length ? `<div>Colaboradores: ${cols.map((c) => esc(primeiroNome(c.nome))).join(', ')}</div>` : ''}
            <div><small>Última atualização: ${esc(quando(resumo.atualizadoEm))}</small></div>
        </div>`;
    }

    window.Atendimento = { perguntarComoParticipar, selo, detalhe, sair, quando };
})();
