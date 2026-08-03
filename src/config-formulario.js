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
  const [ops, docs] = await Promise.all([
    operacoesDoModulo(slug),
    documentos(slug, { apenasAtivos: true }),
  ]);

  return {
    modulo: slug,
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
  const [todas, doModulo, docs] = await Promise.all([
    todasAsOperacoes(),
    operacoesDoModulo(slug),
    documentos(slug, { apenasAtivos: false }),
  ]);

  return {
    modulo: slug,
    operacoes: todas,
    operacoesDoModulo: doModulo,
    documentos: docs,
    modulos: MODULOS.map((m) => ({ slug: m.slug, rotulo: m.rotulo })),
  };
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
  // maiúsculas, sem acento e sem espaço.
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
  garantirSemeado,
  // leitura
  operacoesAtivas,
  todasAsOperacoes,
  operacoesDoModulo,
  documentos,
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
};
