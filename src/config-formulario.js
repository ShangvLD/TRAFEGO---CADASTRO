/* ============================================================================
   Configuração do formulário — operações e matriz de documentos

   Move para o BANCO o que antes eram constantes em src/validacao.js:

     · quais operações (clientes) existem e estão ativas
     · qual documento cada operação exige

   Por que: mudar a exigência de um cliente é decisão de negócio, não de
   código. Antes exigia um deploy; agora o admin edita pela tela /admin/formulario.

   O validacao.js continua sendo a fonte das REGRAS (dígito de CPF, formato de
   placa, validade de CNH) e também a fonte da SEMENTE inicial desta
   configuração — assim o comportamento no primeiro dia é idêntico ao anterior.
   ========================================================================== */

const db = require('./db');
const { OPERACOES, TIPOS_DOCUMENTO, limparTexto, vazio } = require('./validacao');

// ---------------------------------------------------------------------------
// Semeadura
//
// Roda uma vez: se as tabelas estiverem vazias, copia as constantes para o
// banco. É idempotente — em banco já semeado, não faz nada.
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

async function semear() {
  await db.ensureReady();

  const totalOps = (await db.prepare('SELECT count(*)::int AS n FROM cfg_operacoes').get()).n;
  const totalDocs = (await db.prepare('SELECT count(*)::int AS n FROM cfg_documentos').get()).n;
  if (totalOps > 0 && totalDocs > 0) return { semeado: false };

  return db.transacao(async (q) => {
    // ---- Operações, na ordem do formulário do Forms ----
    for (let i = 0; i < OPERACOES.length; i++) {
      await q(
        `INSERT INTO cfg_operacoes (nome, ordem, ativo) VALUES (?, ?, 1)
         ON CONFLICT (nome) DO NOTHING`,
        [OPERACOES[i], i + 1]
      );
    }

    // ---- Documentos ----
    for (let i = 0; i < TIPOS_DOCUMENTO.length; i++) {
      const t = TIPOS_DOCUMENTO[i];
      const todas = t.operacoes ? 0 : 1;
      const r = await q(
        `INSERT INTO cfg_documentos (codigo, rotulo, ordem, tem_validade, ativo, todas_operacoes)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (codigo) DO NOTHING
         RETURNING id`,
        [t.id, t.rotulo, i + 1, t.temValidade ? 1 : 0, todas]
      );
      if (!r.rows.length) continue; // já existia

      // ---- Vínculos, quando o documento não vale para todas ----
      if (t.operacoes) {
        for (const nome of t.operacoes) {
          await q(
            `INSERT INTO cfg_documento_operacao (documento_id, operacao_id)
             SELECT ?, id FROM cfg_operacoes WHERE nome = ?
             ON CONFLICT DO NOTHING`,
            [r.rows[0].id, nome]
          );
        }
      }
    }

    return { semeado: true };
  });
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/** Operações ativas, na ordem configurada (o que o formulário oferece). */
async function operacoesAtivas() {
  await garantirSemeado();
  return db
    .prepare('SELECT id, nome, ordem FROM cfg_operacoes WHERE ativo = 1 ORDER BY ordem, nome')
    .all();
}

/** Todas as operações, ativas ou não (o que a tela de admin mostra). */
async function todasAsOperacoes() {
  await garantirSemeado();
  return db
    .prepare('SELECT id, nome, ordem, ativo FROM cfg_operacoes ORDER BY ordem, nome')
    .all();
}

/**
 * Documentos com a lista de operações vinculadas.
 * @param apenasAtivos  true (padrão) devolve só os ativos — é o que o
 *                      formulário deve usar. A tela de admin passa false.
 */
async function documentos({ apenasAtivos = true } = {}) {
  await garantirSemeado();

  const filtro = apenasAtivos ? 'WHERE d.ativo = 1' : '';
  const linhas = await db
    .prepare(
      `SELECT d.id, d.codigo, d.rotulo, d.ordem, d.tem_validade, d.ativo, d.todas_operacoes,
              COALESCE(
                (SELECT string_agg(o.nome, '|' ORDER BY o.ordem)
                   FROM cfg_documento_operacao vo
                   JOIN cfg_operacoes o ON o.id = vo.operacao_id
                  WHERE vo.documento_id = d.id),
                ''
              ) AS operacoes_txt
         FROM cfg_documentos d
         ${filtro}
        ORDER BY d.ordem, d.rotulo`
    )
    .all();

  return linhas.map((l) => ({
    id: l.id,
    codigo: l.codigo,
    rotulo: l.rotulo,
    ordem: l.ordem,
    temValidade: l.tem_validade === 1,
    ativo: l.ativo === 1,
    todasOperacoes: l.todas_operacoes === 1,
    operacoes: l.operacoes_txt ? l.operacoes_txt.split('|') : [],
  }));
}

/**
 * O que o formulário precisa saber: operações disponíveis + documentos.
 * O front decide o que exibir conforme as operações marcadas.
 */
async function paraFormulario() {
  const [ops, docs] = await Promise.all([operacoesAtivas(), documentos({ apenasAtivos: true })]);
  return {
    operacoes: ops.map((o) => o.nome),
    documentos: docs.map((d) => ({
      codigo: d.codigo,
      rotulo: d.rotulo,
      temValidade: d.temValidade,
      // null = vale para todas (mesma convenção do TIPOS_DOCUMENTO)
      operacoes: d.todasOperacoes ? null : d.operacoes,
    })),
  };
}

/** A matriz inteira, para a tela de admin. */
async function paraAdmin() {
  const [ops, docs] = await Promise.all([todasAsOperacoes(), documentos({ apenasAtivos: false })]);
  return { operacoes: ops, documentos: docs };
}

/** Documentos que se aplicam às operações dadas (mesma regra do validacao). */
async function documentosPara(operacoes) {
  const marcadas = (Array.isArray(operacoes) ? operacoes : [operacoes])
    .filter((o) => !vazio(o))
    .map((o) => limparTexto(o).toUpperCase());

  const docs = await documentos({ apenasAtivos: true });
  return docs.filter((d) => d.todasOperacoes || d.operacoes.some((op) => marcadas.includes(op)));
}

// ---------------------------------------------------------------------------
// Escrita (somente admin)
// ---------------------------------------------------------------------------

/** Liga/desliga uma operação. Desligada, deixa de aparecer no formulário. */
async function definirOperacaoAtiva(id, ativo) {
  await garantirSemeado();
  const r = await db
    .prepare('UPDATE cfg_operacoes SET ativo = ? WHERE id = ?')
    .run(ativo ? 1 : 0, id);
  return r.changes > 0;
}

/** Cria uma operação (cliente novo). Devolve null se o nome já existir. */
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

/** Liga/desliga um documento. */
async function definirDocumentoAtivo(id, ativo) {
  await garantirSemeado();
  const r = await db
    .prepare('UPDATE cfg_documentos SET ativo = ? WHERE id = ?')
    .run(ativo ? 1 : 0, id);
  return r.changes > 0;
}

/**
 * Define para quais operações um documento é exigido.
 *
 * @param todas       true = exigido por todas (os vínculos são apagados)
 * @param operacaoIds ids das operações, quando "todas" é false
 *
 * Numa transação: a troca do modo e a regravação dos vínculos precisam ser
 * atômicas, senão uma falha no meio deixa o documento sem exigência nenhuma.
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

/** Cria um tipo de documento novo. */
async function criarDocumento({ codigo, rotulo, temValidade = false }) {
  await garantirSemeado();

  // O código é identificador técnico (vai virar nome de pasta e id no banco):
  // maiúsculas, sem acento e sem espaço.
  const cod = limparTexto(codigo)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove os acentos separados pelo NFD
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!cod) return { ok: false, erro: 'Informe o código do documento.' };
  const rot = limparTexto(rotulo) || cod;

  const existente = await db.prepare('SELECT id FROM cfg_documentos WHERE codigo = ?').get(cod);
  if (existente) return { ok: false, erro: `Já existe um documento com o código "${cod}".` };

  const ordem = (await db.prepare('SELECT COALESCE(max(ordem), 0) + 1 AS n FROM cfg_documentos').get()).n;
  const r = await db
    .prepare(
      `INSERT INTO cfg_documentos (codigo, rotulo, ordem, tem_validade, ativo, todas_operacoes)
       VALUES (?, ?, ?, ?, 1, 1) RETURNING id`
    )
    .run(cod, rot, ordem, temValidade ? 1 : 0);
  return { ok: true, id: r.lastInsertRowid, codigo: cod, rotulo: rot };
}

/** Renomeia o rótulo de um documento (o código não muda — é identificador). */
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
  definirOperacoesDoDocumento,
};
