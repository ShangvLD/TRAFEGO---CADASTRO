/* ============================================================================
   Teste prático de direção — a ficha, no navegador

   Três coisas, usadas pelo painel do módulo:

     icone(teste)                 o botão da linha da listagem
     resumo(teste)                o bloco dentro do detalhe do cadastro
     abrir(modulo, sol, opcoes)   o modal com a ficha inteira

   A FICHA NÃO ESTÁ ESCRITA AQUI. Critérios, conceitos e resultados chegam do
   servidor (/api/modulos/<slug>/solicitacoes/<id>/teste) porque é o servidor
   que COBRA o preenchimento: uma segunda lista aqui envelheceria separada da
   validação, e o sintoma seria um formulário que aceita e uma rota que recusa
   sem dizer o quê.

   O modal é criado sob demanda e destruído ao fechar, em vez de viver no HTML
   de todas as telas: só um painel usa a ficha, e ela só existe para o módulo
   que aplica teste.
   ========================================================================== */

(function () {
    'use strict';

    function esc(t) {
        return String(t == null ? '' : t).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    function quando(valor) {
        if (!valor) return '';
        if (window.dataHoraPorExtenso) return window.dataHoraPorExtenso(valor);
        if (window.dataHoraBR) return window.dataHoraBR(valor);
        return String(valor);
    }

    /** Hoje em AAAA-MM-DD, no fuso de quem preenche (input[type=date] usa isso). */
    function hojeISO() {
        const d = new Date();
        return (
            d.getFullYear() +
            '-' + String(d.getMonth() + 1).padStart(2, '0') +
            '-' + String(d.getDate()).padStart(2, '0')
        );
    }

    /**
     * Estado do teste em forma de selo. O servidor já manda isto pronto
     * (src/teste-pratico.js: estadoDe); o padrão aqui cobre a linha que ainda
     * não tem teste nenhum, em que não há objeto para carregar o estado.
     */
    function estadoDe(teste) {
        if (teste && teste.estado && teste.estado.rotulo) return teste.estado;
        return {
            estado: 'nao_realizado',
            rotulo: 'Teste prático',
            curto: 'Não realizado',
            cor: 'is-warning',
            icone: 'assignment',
            ajuda: 'Teste prático ainda não aplicado.',
        };
    }

    // -----------------------------------------------------------------------
    // O botão da linha
    // -----------------------------------------------------------------------

    /**
     * O ícone é sempre o mesmo (volante); o que muda com o estado é a COR e o
     * tooltip. Trocar o desenho a cada estado faria a coluna de ações parecer
     * cinco botões diferentes, e quem varre a tabela procura sempre o mesmo.
     */
    function icone(teste, id) {
        const e = estadoDe(teste);
        const classeCor = e.estado === 'nao_realizado' ? '' : ' ' + e.cor;
        return (
            '<button class="btn-acao teste' + classeCor + '" data-teste="' + esc(id) + '"' +
            ' title="' + esc(e.rotulo + ' — ' + e.ajuda) + '"' +
            ' aria-label="' + esc(e.rotulo) + '">' +
            '<span class="material-symbols-rounded">assignment_turned_in</span></button>'
        );
    }

    /** Bloco do teste dentro do modal de detalhe do cadastro. */
    function resumo(teste, id) {
        const e = estadoDe(teste);
        const d = teste && teste.desempenho;
        const assinatura = teste && teste.avaliador_nome
            ? '<span class="tp-resumo__texto">por ' + esc(teste.avaliador_nome) +
              (teste.finalizado_em || teste.atualizado_em
                  ? ' · ' + esc(quando(teste.finalizado_em || teste.atualizado_em))
                  : '') + '</span>'
            : '';

        return (
            '<div class="tp-resumo">' +
            '<span class="badge ' + esc(e.cor) + '">' +
            '<span class="material-symbols-rounded" style="font-size:16px">' + esc(e.icone) + '</span> ' +
            esc(e.rotulo) + '</span>' +
            (d ? '<span class="tp-resumo__texto">Desempenho: ' + esc(d.texto) + '</span>' : '') +
            assinatura +
            '<button type="button" class="btn-modal" data-abrir-teste="' + esc(id) + '">' +
            '<span class="material-symbols-rounded">assignment_turned_in</span> ' +
            (teste ? 'Abrir teste prático' : 'Aplicar teste prático') +
            '</button>' +
            '</div>'
        );
    }

    // -----------------------------------------------------------------------
    // Identificação — vem da solicitação, ninguém redigita
    // -----------------------------------------------------------------------

    /**
     * Os campos do candidato saem do JSON "dados" do próprio cadastro, com o
     * texto "detalhes" como reserva para os registros anteriores ao formulário
     * nativo. Campo que não existe FICA DE FORA: um rótulo com traço ao lado
     * parece dado perdido, e aqui é "este formulário não pergunta isso".
     */
    function identificacao(solicitacao, teste) {
        const d = (solicitacao && solicitacao.dados) || {};
        const doTexto = {};
        for (const parte of String((solicitacao && solicitacao.detalhes) || '').split('|')) {
            const i = parte.indexOf(':');
            if (i < 0) continue;
            doTexto[parte.slice(0, i).trim().toUpperCase()] = parte.slice(i + 1).trim();
        }

        const itens = [
            ['Candidato', d.condutor_nome || doTexto['NOME DO CONDUTOR'] || solicitacao.solicitante_nome],
            ['CPF', d.cpf || doTexto['CPF']],
            ['Telefone', d.telefone || doTexto['NÚMERO DE TELEFONE']],
            ['Tipo de motorista', d.tipo_motorista || doTexto['TIPO DE MOTORISTA']],
            ['Localidade', d.localidade || doTexto['LOCALIDADE']],
            ['Solicitação', '#' + solicitacao.id],
            ['Tentativa', teste && teste.tentativa ? teste.tentativa + 'ª' : '1ª'],
        ].filter((p) => p[1] != null && String(p[1]).trim() !== '');

        return (
            '<div class="tp-ident">' +
            itens
                .map(
                    (p) =>
                        '<div class="tp-ident__item"><span class="tp-ident__rot">' +
                        esc(p[0]) + '</span><span class="tp-ident__val">' + esc(p[1]) + '</span></div>'
                )
                .join('') +
            '</div>'
        );
    }

    // -----------------------------------------------------------------------
    // A ficha
    // -----------------------------------------------------------------------

    function criterioHtml(criterio, conceitos, marcado, bloqueado) {
        const opcoes = conceitos
            .map((c) => {
                const id = 'tp-' + criterio.id + '-' + c.id;
                return (
                    '<input type="radio" id="' + id + '" name="crit-' + esc(criterio.id) + '"' +
                    ' value="' + esc(c.id) + '"' + (marcado === c.id ? ' checked' : '') +
                    (bloqueado ? ' disabled' : '') + '>' +
                    '<label class="tp-conceito ' + esc(c.cor) + '" for="' + id + '">' + esc(c.rotulo) + '</label>'
                );
            })
            .join('');

        return (
            '<div class="tp-criterio" data-criterio="' + esc(criterio.id) + '">' +
            '<span class="tp-criterio__rot">' + esc(criterio.rotulo) + '</span>' +
            '<div class="tp-regua">' + opcoes + '</div>' +
            '</div>'
        );
    }

    function fichaHtml(config, teste, bloqueado) {
        const avaliacoes = (teste && teste.avaliacoes) || {};

        const secoes = config.secoes
            .map(
                (s) =>
                    '<div class="tp-secao"><h4 class="tp-secao__titulo">' +
                    '<span class="material-symbols-rounded">' + esc(s.icone) + '</span> ' +
                    esc(s.titulo) + '</h4>' +
                    s.criterios
                        .map((c) => criterioHtml(c, config.conceitos, avaliacoes[c.id], bloqueado))
                        .join('') +
                    '</div>'
            )
            .join('');

        const resultados = config.resultados
            .map((r) => {
                const id = 'tp-res-' + r.id;
                return (
                    '<input type="radio" id="' + id + '" name="tp-resultado" value="' + esc(r.id) + '"' +
                    (teste && teste.resultado === r.id ? ' checked' : '') +
                    (bloqueado ? ' disabled' : '') + '>' +
                    '<label class="tp-resultado ' + esc(r.cor) + '" for="' + id + '">' +
                    '<span class="material-symbols-rounded">' + esc(r.icone) + '</span>' + esc(r.rotulo) +
                    '</label>'
                );
            })
            .join('');

        // Justificativa é exigida em dois dos três resultados; o asterisco
        // aparece e some conforme a escolha, em vez de um "*" fixo que mentiria
        // metade das vezes.
        const exigeJust = config.resultados.some(
            (r) => r.exigeJustificativa && teste && teste.resultado === r.id
        );

        return (
            '<div class="tp-form' + (bloqueado ? ' somente-leitura' : '') + '" id="tp-form">' +
            secoes +
            '<div class="tp-secao">' +
            '<h4 class="tp-secao__titulo"><span class="material-symbols-rounded">edit_note</span> ' +
            'Observações do avaliador</h4>' +
            '<textarea id="tp-observacoes" rows="3" ' + (bloqueado ? 'disabled ' : '') +
            'placeholder="O que foi observado durante o teste.">' +
            esc((teste && teste.observacoes) || '') + '</textarea>' +
            '</div>' +
            '<div class="tp-secao">' +
            '<h4 class="tp-secao__titulo"><span class="material-symbols-rounded">gavel</span> ' +
            'Resultado do teste</h4>' +
            '<div class="tp-resultados">' + resultados + '</div>' +
            '<label class="tp-campo" for="tp-justificativa">Justificativa do resultado ' +
            '<span class="tp-req" id="tp-just-req"' + (exigeJust ? '' : ' hidden') + '>*</span></label>' +
            '<textarea id="tp-justificativa" rows="2" ' + (bloqueado ? 'disabled ' : '') +
            'placeholder="Por que este resultado.">' +
            esc((teste && teste.justificativa) || '') + '</textarea>' +
            '</div>' +
            '<div id="tp-pendencias"></div>' +
            '<div class="tp-estado" id="tp-estado" hidden></div>' +
            '</div>'
        );
    }

    /** Cabeçalho do que já foi decidido, quando o teste está finalizado. */
    function blocoFinalizado(teste) {
        if (!teste || teste.status !== 'finalizado') return '';
        const e = estadoDe(teste);
        const classe =
            teste.resultado === 'aprovado' ? ' tp-bloco--aprovado'
            : teste.resultado === 'reprovado' ? ' tp-bloco--reprovado'
            : ' tp-bloco--ressalvas';

        return (
            '<div class="tp-bloco' + classe + '">' +
            '<div class="tp-titulo"><span class="material-symbols-rounded">' + esc(e.icone) + '</span> ' +
            esc(e.rotulo) + '</div>' +
            '<p class="tp-ajuda">Finalizado por ' + esc(teste.avaliador_nome || '—') +
            (teste.finalizado_em ? ' · ' + esc(quando(teste.finalizado_em)) : '') +
            (teste.desempenho ? ' · desempenho ' + esc(teste.desempenho.texto) : '') +
            '. Alterar o que está abaixo e finalizar de novo substitui esta decisão.</p>' +
            '</div>'
        );
    }

    // -----------------------------------------------------------------------
    // O modal
    // -----------------------------------------------------------------------

    /**
     * Abre a ficha da solicitação.
     *
     * @param opcoes.podeEditar  false = só leitura (ninguém hoje, mas a ficha
     *                           já sabe se desenhar assim quando houver um
     *                           papel que consulta sem avaliar).
     * @param opcoes.aoSalvar    chamado depois de gravar, com o teste atual —
     *                           é como o painel atualiza a linha sem recarregar.
     */
    async function abrir(modulo, solicitacao, opcoes) {
        const op = opcoes || {};
        const podeEditar = op.podeEditar !== false;
        const url = '/api/modulos/' + modulo + '/solicitacoes/' + solicitacao.id + '/teste';

        const ov = document.createElement('div');
        ov.className = 'modal-overlay';
        ov.innerHTML =
            '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="tp-titulo">' +
            '<div class="modal-header"><h3 id="tp-titulo">' +
            '<span class="material-symbols-rounded" style="color:var(--primary);vertical-align:-5px">assignment_turned_in</span> ' +
            'Teste Prático — Solicitação #' + esc(solicitacao.id) + '</h3>' +
            '<button class="modal-close" type="button" aria-label="Fechar">' +
            '<span class="material-symbols-rounded">close</span></button></div>' +
            '<div class="modal-body"><p class="modal-vazio">Carregando a ficha...</p></div>' +
            '<div class="modal-footer"></div></div>';

        document.body.appendChild(ov);
        document.body.style.overflow = 'hidden';

        const corpo = ov.querySelector('.modal-body');
        const rodape = ov.querySelector('.modal-footer');

        function fechar() {
            document.removeEventListener('keydown', aoTeclar);
            ov.remove();
            document.body.style.overflow = '';
        }
        function aoTeclar(e) {
            if (e.key === 'Escape') fechar();
        }
        document.addEventListener('keydown', aoTeclar);
        ov.querySelector('.modal-close').addEventListener('click', fechar);
        ov.addEventListener('click', (e) => { if (e.target === ov) fechar(); });

        let pacote;
        try {
            const r = await fetch(url);
            if (r.status === 401) { window.location.href = '/login'; return; }
            pacote = await r.json();
            if (!pacote.ok) throw new Error(pacote.erro || 'Não foi possível carregar o teste.');
        } catch (e) {
            corpo.innerHTML = '<p class="modal-vazio">' + esc(e.message) + '</p>';
            return;
        }

        const config = pacote.config;
        let teste = pacote.teste;

        corpo.innerHTML =
            blocoFinalizado(teste) +
            identificacao(solicitacao, teste) +
            camposDoTeste(teste, podeEditar) +
            fichaHtml(config, teste, !podeEditar);

        if (podeEditar) {
            rodape.innerHTML =
                '<button class="btn-modal" type="button" data-acao="rascunho">' +
                '<span class="material-symbols-rounded">save</span> Salvar rascunho</button>' +
                '<button class="btn-modal aprovar" type="button" data-acao="finalizar">' +
                '<span class="material-symbols-rounded">task_alt</span> Finalizar teste</button>';
        } else {
            rodape.innerHTML =
                '<button class="btn-modal" type="button" data-acao="fechar">Fechar</button>';
        }

        const elEstado = () => corpo.querySelector('#tp-estado');
        const elPend = () => corpo.querySelector('#tp-pendencias');

        // O asterisco da justificativa acompanha o resultado escolhido.
        corpo.addEventListener('change', (e) => {
            if (e.target.name !== 'tp-resultado') return;
            const r = config.resultados.find((x) => x.id === e.target.value);
            const req = corpo.querySelector('#tp-just-req');
            if (req) req.hidden = !(r && r.exigeJustificativa);
        });

        /** O que a tela tem preenchido agora. */
        function lerFicha() {
            const avaliacoes = {};
            for (const s of config.secoes) {
                for (const c of s.criterios) {
                    const m = corpo.querySelector('input[name="crit-' + c.id + '"]:checked');
                    if (m) avaliacoes[c.id] = m.value;
                }
            }
            const res = corpo.querySelector('input[name="tp-resultado"]:checked');
            const campo = (id) => {
                const el = corpo.querySelector('#' + id);
                return el ? el.value : '';
            };
            return {
                avaliacoes,
                observacoes: campo('tp-observacoes'),
                justificativa: campo('tp-justificativa'),
                veiculo: campo('tp-veiculo'),
                data_teste: campo('tp-data'),
                resultado: res ? res.value : null,
            };
        }

        /**
         * Aponta o que falta NO LUGAR onde falta, além de listar.
         *
         * Uma ficha de oito critérios rolada até o fim esconde o que ficou em
         * branco; a lista diz o quê, a marca no critério diz onde.
         */
        function mostrarPendencias(pendencias) {
            for (const el of corpo.querySelectorAll('.tp-criterio.pendente')) {
                el.classList.remove('pendente');
            }
            if (!pendencias || !pendencias.length) {
                elPend().innerHTML = '';
                return;
            }
            for (const p of pendencias) {
                const el = corpo.querySelector('.tp-criterio[data-criterio="' + p.campo + '"]');
                if (el) el.classList.add('pendente');
            }
            elPend().innerHTML =
                '<div class="tp-pendencias"><strong>Falta preencher para finalizar:</strong><ul>' +
                pendencias.map((p) => '<li>' + esc(p.rotulo) + '</li>').join('') +
                '</ul></div>';
            elPend().scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        async function salvar(finalizar) {
            const botoes = rodape.querySelectorAll('.btn-modal');
            for (const b of botoes) b.disabled = true;

            const estado = elEstado();
            estado.hidden = false;
            estado.className = 'tp-estado';
            estado.textContent = finalizar ? 'Finalizando...' : 'Salvando rascunho...';

            let j;
            try {
                const r = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ...lerFicha(), finalizar }),
                });
                if (r.status === 401) { window.location.href = '/login'; return; }
                j = await r.json();
            } catch (e) {
                j = { ok: false, erro: 'Não foi possível falar com o servidor.' };
            }

            for (const b of botoes) b.disabled = false;

            if (!j.ok) {
                estado.className = 'tp-estado erro';
                estado.textContent = j.erro || 'Não foi possível salvar.';
                mostrarPendencias(j.pendencias);
                return;
            }

            mostrarPendencias([]);
            teste = j.teste;
            estado.className = 'tp-estado ok';
            estado.textContent = finalizar
                ? 'Teste finalizado e vinculado à solicitação.'
                : 'Rascunho salvo. O teste continua disponível para concluir depois.';

            if (typeof op.aoSalvar === 'function') op.aoSalvar(teste);
            if (finalizar) setTimeout(fechar, 900);
        }

        rodape.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-modal');
            if (!btn) return;
            const acao = btn.dataset.acao;
            if (acao === 'fechar') { fechar(); return; }
            salvar(acao === 'finalizar');
        });
    }

    /** Data do teste e veículo utilizado: os dois campos que o avaliador digita. */
    function camposDoTeste(teste, podeEditar) {
        const dataAtual = (teste && teste.data_teste) || hojeISO();
        const bloq = podeEditar ? '' : ' disabled';
        return (
            '<div class="tp-form">' +
            '<div class="tp-secao">' +
            '<h4 class="tp-secao__titulo"><span class="material-symbols-rounded">event</span> ' +
            'Dados do teste</h4>' +
            '<label class="tp-campo" for="tp-data">Data do teste</label>' +
            '<input type="date" id="tp-data" value="' + esc(dataAtual) + '"' + bloq + '>' +
            '<label class="tp-campo" for="tp-veiculo">Veículo utilizado</label>' +
            '<input type="text" id="tp-veiculo" maxlength="200" value="' +
            esc((teste && teste.veiculo) || '') + '"' + bloq +
            ' placeholder="Placa ou descrição do veículo do teste">' +
            '</div></div>'
        );
    }

    window.TestePratico = { icone, resumo, abrir, estadoDe };
})();
