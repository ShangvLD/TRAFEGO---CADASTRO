/* ============================================================================
   Documentos anexados às solicitações

   Liga o registro no banco (tabela "documentos") ao arquivo no storage
   (src/storage.js). O banco guarda o CAMINHO, nunca a URL: URL de acesso é
   temporária e assinada, gerada na hora da leitura. Guardar URL no banco criaria
   links que expiram — foi exatamente o problema dos 200 anexos do Forms, onde
   mover o arquivo quebrou todas as referências.

   Serve os três módulos. Como a coluna solicitacao_id não pode ter chave
   estrangeira para três tabelas ao mesmo tempo, o par (modulo, solicitacao_id)
   é a identificação, e a exclusão em cascata é feita em código.
   ========================================================================== */

const db = require('./db');
const armazenamento = require('./storage');

/**
 * Prepara o envio de um arquivo: decide o caminho e devolve a URL assinada
 * para o navegador enviar DIRETO ao storage, sem passar pelo servidor.
 *
 * @param dono { nome, cpf }  usados na pasta: JOAO_DA_SILVA_12345678900
 */
async function prepararEnvio({ modulo, solicitacaoId, tipo, nomeArquivo, contentType, tamanho, dono }) {
  const valido = armazenamento.validarArquivo({ nome: nomeArquivo, contentType, tamanho });
  if (!valido.ok) return { ok: false, erro: valido.erro };

  const prov = armazenamento.provedor();
  if (!prov.disponivel()) {
    return { ok: false, erro: 'Armazenamento não configurado no servidor.' };
  }

  const pasta = armazenamento.pastaDoCadastro(dono && dono.nome, dono && dono.cpf);

  // Mesmo tipo enviado de novo: acrescenta sufixo em vez de sobrescrever, para
  // não perder o anterior sem querer (CNH e CNH_2, por exemplo).
  const jaTem = await db
    .prepare('SELECT count(*)::int AS n FROM documentos WHERE modulo = ? AND solicitacao_id = ? AND tipo = ?')
    .get(modulo, solicitacaoId, tipo);

  const caminho = armazenamento.caminhoDoArquivo(pasta, tipo, nomeArquivo, jaTem ? jaTem.n : 0);
  const { url, metodo } = await prov.urlDeUpload(caminho, contentType);

  return { ok: true, caminho, url, metodo, provedor: prov.nome };
}

/**
 * Registra no banco um arquivo já enviado ao storage.
 * Reenvio do mesmo caminho atualiza o registro em vez de duplicar.
 */
async function registrar({ modulo, solicitacaoId, tipo, caminho, nomeOriginal, contentType, tamanho, provedor, validade }) {
  // Os parâmetros vão em .run(), não em .prepare() — prepare() recebe só o SQL.
  const r = await db
    .prepare(
      `INSERT INTO documentos
         (modulo, solicitacao_id, tipo, nome_arquivo, nome_original, caminho, provedor, content_type, tamanho, validade)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       -- O índice de "caminho" é PARCIAL (só onde não é nulo). O PostgreSQL
       -- exige que o ON CONFLICT repita o mesmo predicado, senão não reconhece
       -- qual índice usar.
       ON CONFLICT (caminho) WHERE caminho IS NOT NULL DO UPDATE SET
         tipo          = excluded.tipo,
         nome_arquivo  = excluded.nome_arquivo,
         nome_original = excluded.nome_original,
         content_type  = excluded.content_type,
         tamanho       = excluded.tamanho,
         validade      = COALESCE(excluded.validade, documentos.validade)
       RETURNING id`
    )
    .run(
      modulo,
      solicitacaoId,
      tipo,
      caminho.split('/').pop(),
      nomeOriginal || null,
      caminho,
      provedor || armazenamento.provedor().nome,
      contentType || null,
      tamanho || null,
      validade || null
    );

  return { ok: true, id: r.lastInsertRowid };
}

/** Documentos de uma solicitação. */
async function listar(modulo, solicitacaoId) {
  return db
    .prepare(
      `SELECT id, tipo, nome_arquivo, nome_original, caminho, provedor,
              content_type, tamanho, validade, enviado_em
         FROM documentos
        WHERE modulo = ? AND solicitacao_id = ?
        ORDER BY tipo, id`
    )
    .all(modulo, solicitacaoId);
}

/** Documentos de VÁRIAS solicitações de uma vez (exportação em lote). */
async function listarDeVarias(modulo, ids) {
  const lista = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!lista.length) return [];

  // = ANY($1) aceita o array inteiro num parâmetro só: evita montar uma
  // sequência de "?" do tamanho da lista, que muda a cada chamada.
  return db
    .prepare(
      `SELECT id, solicitacao_id, tipo, nome_arquivo, caminho, content_type, tamanho
         FROM documentos
        WHERE modulo = ? AND solicitacao_id = ANY(?)
        ORDER BY solicitacao_id, tipo, id`
    )
    .all(modulo, lista);
}

/** Um documento pelo id. */
async function buscarPorId(id) {
  return db
    .prepare('SELECT id, modulo, solicitacao_id, tipo, nome_arquivo, caminho, content_type, tamanho FROM documentos WHERE id = ?')
    .get(id);
}

/** URL temporária para baixar um documento. */
async function urlDeLeitura(id, segundos = 600) {
  const d = await db.prepare('SELECT caminho, provedor FROM documentos WHERE id = ?').get(id);
  if (!d || !d.caminho) return null;
  return armazenamento.provedor().urlDeLeitura(d.caminho, segundos);
}

/**
 * Exclui o registro e o arquivo.
 *
 * ATENÇÃO ao verificar a exclusão: a URL assinada é servida por CDN, e pode
 * continuar entregando o arquivo em cache por alguns minutos DEPOIS de ele ter
 * sido apagado. Para confirmar de verdade, consulte o objeto com a chave de
 * serviço (que não passa pelo cache), não pela URL assinada.
 */
async function excluir(id) {
  const d = await db.prepare('SELECT caminho FROM documentos WHERE id = ?').get(id);
  if (!d) return { ok: false, erro: 'Documento não encontrado.' };

  // Primeiro o arquivo: se falhar, o registro fica e dá para tentar de novo.
  // Na ordem inversa, um erro deixaria arquivo órfão no storage, invisível.
  if (d.caminho) {
    try {
      await armazenamento.provedor().remover(d.caminho);
    } catch (e) {
      return { ok: false, erro: `Não foi possível remover o arquivo: ${e.message}` };
    }
  }

  await db.prepare('DELETE FROM documentos WHERE id = ?').run(id);
  return { ok: true };
}

/**
 * Exclui todos os documentos de uma solicitação. Chamado quando a solicitação
 * é excluída — a chave estrangeira não existe mais (a tabela serve três
 * módulos), então a cascata é feita aqui.
 */
async function excluirDaSolicitacao(modulo, solicitacaoId) {
  const lista = await db
    .prepare('SELECT id, caminho FROM documentos WHERE modulo = ? AND solicitacao_id = ?')
    .all(modulo, solicitacaoId);

  const prov = armazenamento.provedor();
  for (const d of lista) {
    if (!d.caminho) continue;
    // Um arquivo que não sai não deve impedir a exclusão dos outros nem da
    // solicitação; vira lixo no storage, que é menos grave que travar a operação.
    try {
      await prov.remover(d.caminho);
    } catch (e) {
      console.error(`[documentos] não removeu ${d.caminho}: ${e.message}`);
    }
  }

  await db.prepare('DELETE FROM documentos WHERE modulo = ? AND solicitacao_id = ?').run(modulo, solicitacaoId);
  return lista.length;
}

/** Quantos documentos cada solicitação tem (para a coluna do painel). */
async function contarPorSolicitacao(modulo) {
  const linhas = await db
    .prepare(
      `SELECT solicitacao_id, count(*)::int AS n
         FROM documentos WHERE modulo = ? GROUP BY solicitacao_id`
    )
    .all(modulo);

  const mapa = {};
  for (const l of linhas) mapa[l.solicitacao_id] = l.n;
  return mapa;
}

module.exports = {
  prepararEnvio,
  buscarPorId,
  registrar,
  listar,
  listarDeVarias,
  urlDeLeitura,
  excluir,
  excluirDaSolicitacao,
  contarPorSolicitacao,
};
