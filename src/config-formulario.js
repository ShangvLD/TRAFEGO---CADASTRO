/* ============================================================================
   Configuração dos formulários — operações e documentos, POR MÓDULO

   Move para o BANCO o que seria constante no código:

     · quais operações (clientes) existem e estão ativas
     · qual documento cada módulo exige, e em quais operações

   Por que: mudar a exigência de um cliente é decisão de negócio, não de
   código. Antes exigia um deploy; agora o admin edita em /admin/formulario.

   Cada MÓDULO tem a sua lista de documentos — agregado pede curso de acidente
   em rodovia, candidato pede MOPP, terceiro pede ANTT. As operações são
   compartilhadas (o mesmo cliente atende vários módulos), mas cada módulo pode
   restringir quais oferece (ver operacoesPermitidas em src/modulos.js).

   A semente inicial vem do código (TIPOS_DOCUMENTO para terceiro,
   documentosIniciais para os demais), então o comportamento no primeiro dia é o
   especificado. Depois, o banco manda.
   ========================================================================== */

const db = require('./db');
const { OPERACOES, TIPOS_DOCUMENTO, limparTexto, vazio } = require('./validacao');
const { MODULOS, acharModulo } = require('./modulos');
const campos = require('./campos');

// ---------------------------------------------------------------------------
// Semeadura
// ---------------------------------------------------------------------------
let semeadoPromise = null;

function garantirSemeado() {
  if (!semeadoPromise) {
    semeadoPromise = semear().catch((err) => {
      semeadoPromise = null; // não memoriza falha: a próxima chamada tenta de novo
      throw err;
    });
  }
  return semeadoPromise;
}

/** Documentos que um módulo deve ter na primeira inicialização. */
function documentosIniciaisDe(modulo) {
  if (modulo.documentosIniciais) return modulo.documentosIniciais;

  // O módulo terceiro tem a lista em src/validacao.js, junto das evidências que
  // a originaram (foi reconstruída dos 51 registros históricos).
  if (modulo.slug === 'terceiro') {
    return TIPOS_DOCUMENTO.map((t) => ({
      codigo: t.id,
      rotulo: t.rotulo,
      temValidade: t.temValidade,
      obrigatorio: true,
      operacoes: t.operacoes || null,
    }));
  }
  return [];
}

async function semear() {
  await db.ensureReady();

  return db.transacao(async (q) => {
    // ---- Operações (compartilhadas), na ordem do formulário do Forms ----
    for (let i = 0; i < OPERACOES.length; i++) {
      await q(
        `INSERT INTO cfg_operacoes (nome, ordem, ativo) VALUES (?, ?, 1)
         ON CONFLICT (nome) DO NOTHING`,
        [OPERACOES[i], i + 1]
      );
    }

    // ---- Perguntas, a partir da especificação em src/campos.js ----
    // O código continua sendo a origem: o que muda é que agora ele é apenas a
    // SEMENTE. Depois da primeira inicialização, a tela de configuração manda.
    for (const modulo of MODULOS) {
      let ordem = 0;
      for (const secao of campos.secoesDe(modulo.slug)) {
        for (const c of secao.campos) {
          ordem += 1;
          await q(
            `INSERT INTO cfg_campos
               (modulo, campo_id, rotulo, tipo, secao, icone, obrigatorio, ativo,
                ordem, largura, dica, placeholder, opcoes, max_tamanho, sistema)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (modulo, campo_id) DO NOTHING`,
            [
              modulo.slug,
              c.id,
              c.rotulo,
              c.tipo,
              secao.secao,
              secao.icone || null,
              c.obrigatorio ? 1 : 0,
              ordem,
              c.largura || null,
              c.dica || null,
              c.placeholder || null,
              c.opcoes ? JSON.stringify(c.opcoes) : null,
              c.max || null,
              c.sistema ? 1 : 0,
            ]
          );
        }
      }
    }

    // ---- Documentos, por módulo ----
    for (const modulo of MODULOS) {
      const iniciais = documentosIniciaisDe(modulo);

      for (let i = 0; i < iniciais.length; i++) {
        const d = iniciais[i];
        const todas = d.operacoes ? 0 : 1;

        const r = await q(
          `INSERT INTO cfg_documentos
             (modulo, codigo, rotulo, ordem, tem_validade, ativo, todas_operacoes, obrigatorio, condicionado_a)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (modulo, codigo) DO NOTHING
           RETURNING id`,
          [
            modulo.slug,
            d.codigo,
            d.rotulo,
            i + 1,
            d.temValidade ? 1 : 0,
            todas,
            d.obrigatorio === false ? 0 : 1,
            d.condicionadoA || null,
          ]
        );
        if (!r.rows.length) continue; // já existia

        if (d.operacoes) {
          for (const nome of d.operacoes) {
            await q(
              `INSERT INTO cfg_documento_operacao (documento_id, operacao_id)
               SELECT ?, id FROM cfg_operacoes WHERE nome = ?
               ON CONFLICT DO NOTHING`,
              [r.rows[0].id, nome]
            );
          }
        }
      }
    }

    return { semeado: true };
  });
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/** Operações ativas, na ordem configurada. */
async function operacoesAtivas() {
  await garantirSemeado();
  return db
    .prepare('SELECT id, nome, ordem FROM cfg_operacoes WHERE ativo = 1 ORDER BY ordem, nome')
    .all();
}

/** Todas as operações, ativas ou não (tela de admin). */
async function todasAsOperacoes() {
  await garantirSemeado();
  return db
    .prepare('SELECT id, nome, ordem, ativo FROM cfg_operacoes ORDER BY ordem, nome')
    .all();
}

/**
 * Operações que um MÓDULO oferece: as ativas, filtradas por
 * operacoesPermitidas do módulo (null = todas).
 */
async function operacoesDoModulo(slug) {
  const modulo = acharModulo(slug);
  const ativas = await operacoesAtivas();
  if (!modulo || modulo.operacoesPermitidas === null) return ativas;

  const permitidas = modulo.operacoesPermitidas.map((o) => o.toUpperCase());
  return ativas.filter((o) => permitidas.includes(o.nome.toUpperCase()));
}

/** Documentos de um módulo, com as operações vinculadas. */
async function documentos(slug, { apenasAtivos = true } = {}) {
  await garantirSemeado();

  const linhas = await db
    .prepare(
      `SELECT d.id, d.codigo, d.rotulo, d.ordem, d.tem_validade, d.ativo,
              d.todas_operacoes, d.obrigatorio, d.condicionado_a,
              COALESCE(
                (SELECT string_agg(o.nome, '|' ORDER BY o.ordem)
                   FROM cfg_documento_operacao vo
                   JOIN cfg_operacoes o ON o.id = vo.operacao_id
                  WHERE vo.documento_id = d.id),
                ''
              ) AS operacoes_txt
         FROM cfg_documentos d
        WHERE d.modulo = ?
          ${apenasAtivos ? 'AND d.ativo = 1' : ''}
        ORDER BY d.ordem, d.rotulo`
    )
    .all(slug);

  return linhas.map((l) => ({
    id: l.id,
    codigo: l.codigo,
    rotulo: l.rotulo,
    ordem: l.ordem,
    temValidade: l.tem_validade === 1,
    ativo: l.ativo === 1,
    obrigatorio: l.obrigatorio === 1,
    condicionadoA: l.condicionado_a || null,
    todasOperacoes: l.todas_operacoes === 1,
    operacoes: l.operacoes_txt ? l.operacoes_txt.split('|') : [],
  }));
}

/** O que o formulário de um módulo precisa saber. */
async function paraFormulario(slug) {
  const modulo = acharModulo(slug);
  const [ops, docs, secoes] = await Promise.all([
    operacoesDoModulo(slug),
    documentos(slug, { apenasAtivos: true }),
    secoesDoModulo(slug),
  ]);

  return {
    modulo: slug,
    secoes,
    operacoes: ops.map((o) => o.nome),
    operacoesObrigatorias: modulo ? modulo.operacoesObrigatorias !== false : true,
    documentos: docs.map((d) => ({
      codigo: d.codigo,
      rotulo: d.rotulo,
      temValidade: d.temValidade,
      obrigatorio: d.obrigatorio,
      condicionadoA: d.condicionadoA,
      // null = vale para todas as operações
      operacoes: d.todasOperacoes ? null : d.operacoes,
    })),
  };
}

/**
 * A matriz de um módulo, para a tela de admin.
 *
 * Devolve DUAS listas de operação, de propósito:
 *   operacoes          todas (a gestão de clientes é global — ativar/criar)
 *   operacoesDoModulo  só as que este módulo oferece: são as colunas da matriz.
 *                      O agregado atende 3 clientes; mostrar as 9 colunas
 *                      sugeriria que ele pode ser vinculado a qualquer um.
 */
async function paraAdmin(slug) {
  const [todas, doModulo, docs, perg] = await Promise.all([
    todasAsOperacoes(),
    operacoesDoModulo(slug),
    documentos(slug, { apenasAtivos: false }),
    perguntas(slug, { apenasAtivas: false }),
  ]);

  return {
    modulo: slug,
    operacoes: todas,
    operacoesDoModulo: doModulo,
    documentos: docs,
    perguntas: perg,
    tiposDeCampo: TIPOS_DE_CAMPO,
    // Seções já usadas neste formulário, para o admin escolher em vez de
    // digitar — digitando, "Condutor" e "condutor " viram duas seções, e a
    // pergunta nova aparece num grupo solto no formulário.
    secoesExistentes: [...new Set(perg.map((p) => p.secao).filter(Boolean))].sort(),
    modulos: MODULOS.map((m) => ({ slug: m.slug, rotulo: m.rotulo })),
  };
}

// ---------------------------------------------------------------------------
// Perguntas (campos)
// ---------------------------------------------------------------------------

/** Perguntas de um módulo, em ordem. */
async function perguntas(slug, { apenasAtivas = true } = {}) {
  await garantirSemeado();

  const linhas = await db
    .prepare(
      `SELECT id, campo_id, rotulo, tipo, secao, icone, obrigatorio, ativo,
              ordem, largura, dica, placeholder, opcoes, max_tamanho, sistema
         FROM cfg_campos
        WHERE modulo = ?
          ${apenasAtivas ? 'AND ativo = 1' : ''}
        ORDER BY ordem, id`
    )
    .all(slug);

  return linhas.map((l) => ({
    id: l.id,
    campoId: l.campo_id,
    rotulo: l.rotulo,
    tipo: l.tipo,
    secao: l.secao,
    icone: l.icone,
    obrigatorio: l.obrigatorio === 1,
    ativo: l.ativo === 1,
    ordem: l.ordem,
    largura: l.largura,
    dica: l.dica,
    placeholder: l.placeholder,
    opcoes: l.opcoes ? JSON.parse(l.opcoes) : null,
    max: l.max_tamanho,
    // Campo do qual outra coisa depende: editavel, mas nao excluivel.
    sistema: l.sistema === 1,
  }));
}

/**
 * As perguntas no formato que a tela e o validador consomem — agrupadas em
 * seções, preservando a ordem em que aparecem.
 */
async function secoesDoModulo(slug) {
  const lista = await perguntas(slug, { apenasAtivas: true });
  const porSecao = new Map();

  for (const p of lista) {
    if (!porSecao.has(p.secao)) {
      porSecao.set(p.secao, { secao: p.secao, icone: p.icone || 'edit_note', campos: [] });
    }
    porSecao.get(p.secao).campos.push({
      id: p.campoId,
      rotulo: p.rotulo,
      tipo: p.tipo,
      obrigatorio: p.obrigatorio,
      largura: p.largura || undefined,
      dica: p.dica || undefined,
      placeholder: p.placeholder || undefined,
      opcoes: p.opcoes || undefined,
      max: p.max || undefined,
    });
  }

  return [...porSecao.values()];
}

/* ---------------------------------------------------------------------------
   Tipos de pergunta

   Cada tipo declara O QUE ele precisa configurar. A tela do admin lê daqui e
   mostra só os campos pertinentes — perguntar "máximo de caracteres" numa data
   ou "quantas opções" num número é ruído que faz a pessoa duvidar da escolha.

   "config" é o contrato com a tela:
     limite   pede um máximo de caracteres/dígitos (com padrão e teto)
     opcoes   pede a lista de escolhas

   ACRESCENTAR UM TIPO é acrescentar uma entrada aqui. A tela, a validação e a
   gravação leem desta lista — nenhuma delas tem a própria cópia.

   Os tipos com VALIDAÇÃO DE NEGÓCIO (CPF, placa, telefone) continuam
   existindo, mas fora do construtor: eles conferem dígito verificador e
   formato, e alimentam as tabelas estruturadas. Quem monta formulário escolhe
   entre os tipos genéricos; os validados são do desenho do sistema.
   ------------------------------------------------------------------------- */

const TIPOS_DE_CAMPO = [
  {
    valor: 'data', rotulo: 'Data', icone: 'event',
    ajuda: 'Campo de data, com o seletor do navegador.',
    config: [],
  },
  {
    valor: 'selecao', rotulo: 'Lista suspensa', icone: 'arrow_drop_down_circle',
    ajuda: 'Quem preenche escolhe uma das opções que você definir.',
    config: ['opcoes'],
  },
  {
    valor: 'texto', rotulo: 'Texto curto', icone: 'short_text',
    ajuda: 'Uma linha. Bom para nome, código, referência.',
    config: ['limite'],
    limitePadrao: 100, limiteMax: 255,
  },
  {
    valor: 'texto_longo', rotulo: 'Texto longo', icone: 'notes',
    ajuda: 'Várias linhas. Bom para observação e descrição.',
    config: ['limite'],
    limitePadrao: 500, limiteMax: 4000,
  },
  {
    valor: 'numero', rotulo: 'Número', icone: 'pin',
    ajuda: 'Só dígitos. Letra e símbolo são recusados.',
    config: ['limite'],
    limitePadrao: 10, limiteMax: 30,
  },
  {
    valor: 'anexo', rotulo: 'Anexo (arquivo)', icone: 'attach_file',
    ajuda: 'Pede um arquivo: PDF, JPG ou PNG.',
    config: [],
  },
  // Tipos com validação própria, mantidos para as perguntas que já existem e
  // para quem precisar de conferência de verdade.
  { valor: 'nome', rotulo: 'Nome completo', icone: 'badge', ajuda: 'Exige nome e sobrenome.', config: [], avancado: true },
  { valor: 'cpf', rotulo: 'CPF (com validação)', icone: 'fingerprint', ajuda: 'Confere o dígito verificador.', config: [], avancado: true },
  { valor: 'cpf_cnpj', rotulo: 'CPF ou CNPJ (com validação)', icone: 'business', ajuda: 'Aceita os dois, conferindo o dígito.', config: [], avancado: true },
  { valor: 'telefone', rotulo: 'Telefone (com validação)', icone: 'call', ajuda: 'Confere DDD e quantidade de dígitos.', config: [], avancado: true },
  { valor: 'email', rotulo: 'E-mail (com validação)', icone: 'mail', ajuda: 'Confere o formato.', config: [], avancado: true },
  { valor: 'placa', rotulo: 'Placa (com validação)', icone: 'directions_car', ajuda: 'Aceita o formato antigo e o Mercosul.', config: [], avancado: true },
];

function acharTipo(valor) {
  return TIPOS_DE_CAMPO.find((t) => t.valor === valor) || null;
}

/** O tipo pede este item de configuração? */
function tipoPede(valor, item) {
  const t = acharTipo(valor);
  return !!(t && t.config.includes(item));
}

/** Transforma o rótulo em identificador técnico (mesma regra dos documentos). */
function idTecnico(texto) {
  return limparTexto(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Cria uma pergunta em um módulo. */
async function criarPergunta({ modulo, rotulo, tipo = 'texto', secao, obrigatorio = false, opcoes = null, maxTamanho = null }) {
  await garantirSemeado();

  if (!acharModulo(modulo)) return { ok: false, erro: 'Módulo inválido.' };

  const espec = acharTipo(tipo);
  if (!espec) return { ok: false, erro: 'Tipo de campo inválido.' };

  const rot = limparTexto(rotulo);
  if (!rot) return { ok: false, erro: 'Informe o texto da pergunta.' };

  const campoId = idTecnico(rot);
  if (!campoId) return { ok: false, erro: 'O texto da pergunta precisa ter letras ou números.' };

  // ---- Opções: só para quem pede, e sem opção repetida ----
  let opcoesLimpas = null;
  if (tipoPede(tipo, 'opcoes')) {
    const lista = (Array.isArray(opcoes) ? opcoes : String(opcoes || '').split(','))
      .map((o) => limparTexto(o).toUpperCase())
      .filter(Boolean);
    if (lista.length < 2) {
      // Uma opção só não é escolha: se o valor é fixo, não precisa perguntar.
      return { ok: false, erro: 'A lista precisa de pelo menos 2 opções.' };
    }
    opcoesLimpas = JSON.stringify([...new Set(lista)]);
  }

  // ---- Limite de caracteres: só para quem pede, dentro do teto do tipo ----
  let limite = null;
  if (tipoPede(tipo, 'limite')) {
    const n = Number(maxTamanho);
    limite = Number.isInteger(n) && n > 0 ? n : espec.limitePadrao;
    if (limite > espec.limiteMax) {
      return { ok: false, erro: `O máximo para "${espec.rotulo}" é ${espec.limiteMax}.` };
    }
  }

  const existente = await db
    .prepare('SELECT id FROM cfg_campos WHERE modulo = ? AND campo_id = ?')
    .get(modulo, campoId);
  if (existente) return { ok: false, erro: `Este formulário já tem a pergunta "${rot}".` };

  const ordem = (
    await db.prepare('SELECT COALESCE(max(ordem), 0) + 1 AS n FROM cfg_campos WHERE modulo = ?').get(modulo)
  ).n;

  const r = await db
    .prepare(
      `INSERT INTO cfg_campos
         (modulo, campo_id, rotulo, tipo, secao, obrigatorio, ativo, ordem, opcoes, max_tamanho)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?) RETURNING id`
    )
    .run(modulo, campoId, rot, tipo, limparTexto(secao) || 'Dados', obrigatorio ? 1 : 0, ordem, opcoesLimpas, limite);

  return { ok: true, id: r.lastInsertRowid, campoId, rotulo: rot };
}

/** Atualiza uma pergunta: rótulo, obrigatoriedade ou estado. */
async function atualizarPergunta(id, { rotulo, obrigatorio, ativo }) {
  await garantirSemeado();
  let mexeu = false;

  if (typeof rotulo === 'string') {
    const rot = limparTexto(rotulo);
    if (rot) {
      // O campo_id NÃO muda junto: ele é a chave dos dados já gravados, e
      // renomear a chave desligaria as respostas antigas da pergunta.
      const r = await db.prepare('UPDATE cfg_campos SET rotulo = ? WHERE id = ?').run(rot, id);
      mexeu = r.changes > 0 || mexeu;
    }
  }
  if (typeof obrigatorio === 'boolean') {
    const r = await db.prepare('UPDATE cfg_campos SET obrigatorio = ? WHERE id = ?').run(obrigatorio ? 1 : 0, id);
    mexeu = r.changes > 0 || mexeu;
  }
  if (typeof ativo === 'boolean') {
    const r = await db.prepare('UPDATE cfg_campos SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
    mexeu = r.changes > 0 || mexeu;
  }
  return mexeu;
}

// ---------------------------------------------------------------------------
// Exclusões
//
// Excluir é diferente de desativar: desativar tira do formulário e é
// reversível com um clique; excluir apaga a configuração para sempre.
//
// Em nenhum dos três casos as solicitações já enviadas são alteradas — os
// dados ficam gravados no histórico. O que se perde é a configuração.
// ---------------------------------------------------------------------------

/**
 * Exclui um cliente. Os vínculos com documentos saem junto (ON DELETE CASCADE).
 * As solicitações antigas que o citam continuam intactas: o nome do cliente
 * está gravado como texto nelas, não como referência.
 */
async function excluirOperacao(id) {
  await garantirSemeado();
  const alvo = await db.prepare('SELECT nome FROM cfg_operacoes WHERE id = ?').get(id);
  if (!alvo) return { ok: false, erro: 'Cliente não encontrado.' };

  const r = await db.prepare('DELETE FROM cfg_operacoes WHERE id = ?').run(id);
  return { ok: r.changes > 0, nome: alvo.nome };
}

/**
 * Exclui um tipo de documento da configuração. Arquivos já enviados NÃO são
 * apagados — a tabela "documentos" guarda o tipo como texto.
 */
async function excluirDocumento(id) {
  await garantirSemeado();
  const alvo = await db.prepare('SELECT rotulo FROM cfg_documentos WHERE id = ?').get(id);
  if (!alvo) return { ok: false, erro: 'Documento não encontrado.' };

  const r = await db.prepare('DELETE FROM cfg_documentos WHERE id = ?').run(id);
  return { ok: r.changes > 0, rotulo: alvo.rotulo };
}

/**
 * Exclui uma pergunta. As respostas já enviadas continuam gravadas na coluna
 * "dados" das solicitações, mas deixam de ser exibidas — sem a pergunta na
 * configuração, não há rótulo para mostrá-las.
 */
async function excluirPergunta(id) {
  await garantirSemeado();
  const alvo = await db.prepare('SELECT rotulo, sistema FROM cfg_campos WHERE id = ?').get(id);
  if (!alvo) return { ok: false, erro: 'Pergunta não encontrada.' };

  // Campo do sistema não sai. Ele alimenta tabela estruturada, nomeia pasta de
  // anexo ou entra numa regra de negócio — apagar não daria erro na hora,
  // daria dado faltando semanas depois, sem ninguém ligar uma coisa à outra.
  // Desativar continua permitido: tira do formulário sem sumir do sistema.
  if (alvo.sistema === 1) {
    return {
      ok: false,
      erro: `"${alvo.rotulo}" é um campo do sistema e não pode ser excluído. ` +
            'Você pode desativá-lo para que ele não apareça no formulário.',
    };
  }

  const r = await db.prepare('DELETE FROM cfg_campos WHERE id = ?').run(id);
  return { ok: r.changes > 0, rotulo: alvo.rotulo };
}

/** Documentos aplicáveis às operações escolhidas. */
async function documentosPara(slug, operacoes) {
  const marcadas = (Array.isArray(operacoes) ? operacoes : [operacoes])
    .filter((o) => !vazio(o))
    .map((o) => limparTexto(o).toUpperCase());

  const docs = await documentos(slug, { apenasAtivos: true });
  return docs.filter((d) => d.todasOperacoes || d.operacoes.some((op) => marcadas.includes(op)));
}

// ---------------------------------------------------------------------------
// Escrita (somente admin)
// ---------------------------------------------------------------------------

async function definirOperacaoAtiva(id, ativo) {
  await garantirSemeado();
  const r = await db
    .prepare('UPDATE cfg_operacoes SET ativo = ? WHERE id = ?')
    .run(ativo ? 1 : 0, id);
  return r.changes > 0;
}

async function criarOperacao(nome) {
  await garantirSemeado();
  const limpo = limparTexto(nome).toUpperCase();
  if (!limpo) return { ok: false, erro: 'Informe o nome da operação.' };
  if (limpo.includes('|')) {
    // O "|" é o separador do campo "assunto" — deixar passar quebraria a
    // leitura dos clientes no painel.
    return { ok: false, erro: 'O nome não pode conter o caractere "|".' };
  }

  const existente = await db.prepare('SELECT id FROM cfg_operacoes WHERE nome = ?').get(limpo);
  if (existente) return { ok: false, erro: `A operação "${limpo}" já existe.` };

  const ordem = (await db.prepare('SELECT COALESCE(max(ordem), 0) + 1 AS n FROM cfg_operacoes').get()).n;
  const r = await db
    .prepare('INSERT INTO cfg_operacoes (nome, ordem, ativo) VALUES (?, ?, 1) RETURNING id')
    .run(limpo, ordem);
  return { ok: true, id: r.lastInsertRowid, nome: limpo };
}

async function definirDocumentoAtivo(id, ativo) {
  await garantirSemeado();
  const r = await db
    .prepare('UPDATE cfg_documentos SET ativo = ? WHERE id = ?')
    .run(ativo ? 1 : 0, id);
  return r.changes > 0;
}

async function definirDocumentoObrigatorio(id, obrigatorio) {
  await garantirSemeado();
  const r = await db
    .prepare('UPDATE cfg_documentos SET obrigatorio = ? WHERE id = ?')
    .run(obrigatorio ? 1 : 0, id);
  return r.changes > 0;
}

/**
 * Define para quais operações um documento é exigido.
 * Numa transação: trocar o modo e regravar os vínculos precisa ser atômico,
 * senão uma falha no meio deixa o documento sem exigência nenhuma.
 */
async function definirOperacoesDoDocumento(id, { todas, operacaoIds = [] }) {
  await garantirSemeado();

  return db.transacao(async (q) => {
    const upd = await q('UPDATE cfg_documentos SET todas_operacoes = ? WHERE id = ?', [
      todas ? 1 : 0,
      id,
    ]);
    if (upd.rowCount === 0) return false;

    await q('DELETE FROM cfg_documento_operacao WHERE documento_id = ?', [id]);

    if (!todas) {
      for (const opId of operacaoIds) {
        await q(
          `INSERT INTO cfg_documento_operacao (documento_id, operacao_id)
           VALUES (?, ?) ON CONFLICT DO NOTHING`,
          [id, opId]
        );
      }
    }
    return true;
  });
}

/** Cria um tipo de documento em um módulo. */
async function criarDocumento({ modulo, codigo, rotulo, temValidade = false, obrigatorio = true }) {
  await garantirSemeado();

  if (!acharModulo(modulo)) return { ok: false, erro: 'Módulo inválido.' };

  // O código é identificador técnico (vira nome de pasta e chave no banco):
  // maiúsculas, sem acento e sem espaço. O NFD separa a letra do acento
  // ("á" -> "a" + U+0301) e o replace seguinte apaga os acentos soltos, para
  // "Currículo" e "curriculo" darem o MESMO código e a checagem de duplicado
  // pegá-los.
  const cod = limparTexto(codigo)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!cod) return { ok: false, erro: 'Informe o nome do documento.' };
  const rot = limparTexto(rotulo) || cod;

  const existente = await db
    .prepare('SELECT id FROM cfg_documentos WHERE modulo = ? AND codigo = ?')
    .get(modulo, cod);
  if (existente) return { ok: false, erro: `Este módulo já tem um documento "${cod}".` };

  const ordem = (
    await db.prepare('SELECT COALESCE(max(ordem), 0) + 1 AS n FROM cfg_documentos WHERE modulo = ?').get(modulo)
  ).n;

  const r = await db
    .prepare(
      `INSERT INTO cfg_documentos
         (modulo, codigo, rotulo, ordem, tem_validade, ativo, todas_operacoes, obrigatorio)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?) RETURNING id`
    )
    .run(modulo, cod, rot, ordem, temValidade ? 1 : 0, obrigatorio ? 1 : 0);
  return { ok: true, id: r.lastInsertRowid, codigo: cod, rotulo: rot };
}

/** Renomeia o rótulo (o código não muda — é identificador). */
async function renomearDocumento(id, rotulo) {
  await garantirSemeado();
  const rot = limparTexto(rotulo);
  if (!rot) return false;
  const r = await db.prepare('UPDATE cfg_documentos SET rotulo = ? WHERE id = ?').run(rot, id);
  return r.changes > 0;
}

module.exports = {
  acharTipo,
  tipoPede,
  garantirSemeado,
  // leitura
  operacoesAtivas,
  todasAsOperacoes,
  operacoesDoModulo,
  documentos,
  perguntas,
  secoesDoModulo,
  TIPOS_DE_CAMPO,
  documentosPara,
  paraFormulario,
  paraAdmin,
  // escrita
  criarOperacao,
  definirOperacaoAtiva,
  criarDocumento,
  renomearDocumento,
  definirDocumentoAtivo,
  definirDocumentoObrigatorio,
  definirOperacoesDoDocumento,
  criarPergunta,
  atualizarPergunta,
  // exclusões
  excluirOperacao,
  excluirDocumento,
  excluirPergunta,
};
