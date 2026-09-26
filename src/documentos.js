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
const tiposDocumento = require('./tipos-documento');

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
    // Mensagem nomeando a variável de propósito: quem vê isto é do time
    // interno, e "não configurado" sozinho não diz o que fazer. A causa é
    // sempre a mesma — a chave não chegou ao ambiente.
    return {
      ok: false,
      erro:
        'Armazenamento não configurado: falta a variável SUPABASE_SERVICE_KEY neste ambiente. ' +
        'Um administrador pode conferir em Configurações > Armazenamento.',
    };
  }

  // Módulo e id na pasta: é o que amarra o arquivo a ESTE cadastro, e não ao
  // e-mail de quem o abriu (ver pastaDaSolicitacao).
  const pasta = armazenamento.pastaDaSolicitacao(modulo, solicitacaoId, dono || {});

  // O tipo é canonizado ANTES de qualquer coisa: é o mesmo valor que vai
  // nomear o arquivo e o que vai para a coluna "tipo", e os dois precisam ser
  // idênticos — senão a contagem abaixo não acha o que já existe e o segundo
  // envio sobrescreve o primeiro em vez de virar CNH_2.
  const codigo = tiposDocumento.canonico(tipo);

  // Mesmo tipo enviado de novo: acrescenta sufixo em vez de sobrescrever, para
  // não perder o anterior sem querer (CNH e CNH_2, por exemplo).
  //
  // A comparação passa pelo canônico dos dois lados porque a tabela ainda
  // guarda código antigo em linha antiga ("RESULTADO RDO", com espaço): sem
  // isso, reenviar o RDO de um cadastro migrado começaria a contagem do zero.
  const doMesmoTipo = await db
    .prepare('SELECT tipo FROM documentos WHERE modulo = ? AND solicitacao_id = ?')
    .all(modulo, solicitacaoId);
  const jaTem = doMesmoTipo.filter((d) => tiposDocumento.canonico(d.tipo) === codigo).length;

  const caminho = armazenamento.caminhoDoArquivo(pasta, codigo, nomeArquivo, jaTem);
  const { url, metodo, cabecalhos } = await prov.urlDeUpload(caminho, contentType);

  return {
    ok: true,
    caminho,
    tipo: codigo,
    url,
    metodo,
    cabecalhos: cabecalhos || null,
    provedor: prov.nome,
    bucket: prov.bucket || null,
  };
}

/**
 * Registra no banco um arquivo já enviado ao storage.
 * Reenvio do mesmo caminho atualiza o registro em vez de duplicar.
 *
 * @param criadoPor  id do usuário que anexou. Nulo só para registro de
 *                   migração, onde não há como saber quem foi.
 * @param origem     nativo (padrão) | forms | migrado
 */
async function registrar({
  modulo,
  solicitacaoId,
  tipo,
  caminho,
  nomeOriginal,
  contentType,
  tamanho,
  provedor,
  bucket,
  validade,
  criadoPor,
  origem,
  escopo,
  condutorId,
  proprietarioId,
  veiculoId,
  permitirLegado = false,
}) {
  // O caminho volta pelo navegador. Sem conferir, um caminho trocado criaria um
  // registro apontando para o arquivo de OUTRO cadastro — e o painel mostraria
  // a CNH de alguém no cadastro errado.
  caminho = armazenamento.validarCaminhoLogico(caminho);

  // ...e o formato estar certo não basta: o caminho precisa ser DESTA
  // solicitação. Sem esta linha, registrar o caminho da pasta de outro
  // cadastro criava, no seu próprio, um documento que a rota de download
  // entrega — ela confere "documento pertence à solicitação", e a linha
  // recém-criada diz que sim. Era leitura da CNH alheia sabendo só o id.
  //
  // "permitirLegado" existe para a migração (src/migrar-storage.js), que
  // reescreve linha por linha e não pode ser barrada pelo formato antigo —
  // onde módulo e id não estão no caminho e a conferência é impossível.
  if (solicitacaoId != null && !armazenamento.caminhoPertenceA(caminho, modulo, solicitacaoId)) {
    if (!(permitirLegado && armazenamento.caminhoLegado(caminho))) {
      throw new Error(`Caminho inválido: "${caminho}" não pertence a esta solicitação.`);
    }
  }

  // Mesmo motivo do nome do arquivo: o que entra na coluna "tipo" é o código
  // canônico, não o que o front mandou. É o único jeito de "RESULTADO RDO" e
  // "RESULTADO_RDO" pararem de ser dois documentos diferentes.
  tipo = tiposDocumento.canonico(tipo);

  const prov = provedor || armazenamento.provedor().nome;

  // O bucket é do provedor que REALMENTE gravou, não do provedor atual: um
  // registro de migração pode informar os dois explicitamente.
  const cont =
    bucket !== undefined
      ? bucket
      : (armazenamento.PROVEDORES[prov] && armazenamento.PROVEDORES[prov].bucket) || null;

  // Os parâmetros vão em .run(), não em .prepare() — prepare() recebe só o SQL.
  const r = await db
    .prepare(
      `INSERT INTO documentos
         (modulo, solicitacao_id, tipo, nome_arquivo, nome_original, caminho, provedor,
          bucket, content_type, tamanho, validade, criado_por, origem, escopo,
          condutor_id, proprietario_id, veiculo_id, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
       -- O índice de "caminho" é PARCIAL (só onde não é nulo). O PostgreSQL
       -- exige que o ON CONFLICT repita o mesmo predicado, senão não reconhece
       -- qual índice usar.
       ON CONFLICT (caminho) WHERE caminho IS NOT NULL DO UPDATE SET
         tipo          = excluded.tipo,
         nome_arquivo  = excluded.nome_arquivo,
         nome_original = excluded.nome_original,
         content_type  = excluded.content_type,
         tamanho       = excluded.tamanho,
         bucket        = excluded.bucket,
         escopo        = COALESCE(excluded.escopo, documentos.escopo),
         -- A autoria NUNCA é apagada por um reenvio sem usuário (a migração,
         -- por exemplo). Só troca quando alguém identificado reenvia.
         criado_por    = COALESCE(excluded.criado_por, documentos.criado_por),
         validade      = COALESCE(excluded.validade, documentos.validade),
         atualizado_em = datetime('now', 'localtime')
       RETURNING id`
    )
    .run(
      modulo,
      solicitacaoId == null ? null : solicitacaoId,
      tipo,
      caminho.split('/').pop(),
      nomeOriginal || null,
      caminho,
      prov,
      cont,
      contentType || null,
      tamanho || null,
      validade || null,
      criadoPor == null ? null : Number(criadoPor),
      origem || 'nativo',
      escopo || null,
      condutorId == null ? null : Number(condutorId),
      proprietarioId == null ? null : Number(proprietarioId),
      veiculoId == null ? null : Number(veiculoId)
    );

  return { ok: true, id: r.lastInsertRowid };
}

/** Documentos de uma solicitação. */
async function listar(modulo, solicitacaoId) {
  return db
    .prepare(
      `SELECT id, tipo, nome_arquivo, nome_original, caminho, provedor, bucket,
              content_type, tamanho, validade, enviado_em, origem, escopo, criado_por
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
      `SELECT id, solicitacao_id, tipo, nome_arquivo, caminho, provedor,
              content_type, tamanho
         FROM documentos
        WHERE modulo = ? AND solicitacao_id = ANY(?)
        ORDER BY solicitacao_id, tipo, id`
    )
    .all(modulo, lista);
}

/** Um documento pelo id. */
async function buscarPorId(id) {
  return db
    .prepare(
      `SELECT id, modulo, solicitacao_id, tipo, nome_arquivo, caminho, provedor,
              content_type, tamanho
         FROM documentos WHERE id = ?`
    )
    .get(id);
}

/**
 * Onde o arquivo está DE FATO, pelo provedor gravado com ele — não pelo
 * provedor em uso agora. Null quando esse provedor não existe neste ambiente
 * (arquivo na pasta do canal, portal rodando no Vercel, por exemplo).
 */
function armazenamentoDe(d) {
  return armazenamento.provedorDe(d && d.provedor);
}

/** Explicação para quando o arquivo existe, mas não é alcançável daqui. */
function motivoIndisponivel(d) {
  if (d && d.provedor === 'pasta') {
    return 'Este arquivo está na pasta do canal do Teams. Só abre com o portal rodando na máquina que sincroniza essa pasta.';
  }
  return `Armazenamento "${d && d.provedor}" não está configurado neste ambiente.`;
}

/**
 * Acrescenta a URL de leitura a uma lista de documentos.
 *
 * Assina em LOTE quando o provedor sabe fazer isso — uma requisição em vez de
 * uma por arquivo. O ganho é de latência: a assinatura é quase toda ida e
 * volta até o storage, então o número de chamadas pesa mais que a quantidade
 * de caminhos.
 *
 * @param rotaDeDownload  (doc) => caminho da rota do servidor, usada quando o
 *                        provedor não tem URL pública (pasta em disco)
 */
async function comUrls(lista, { segundos = 1800, rotaDeDownload } = {}) {
  const docs = lista || [];
  if (!docs.length) return [];

  // Agrupa por provedor: uma lista pode misturar arquivos do Supabase com
  // arquivos gravados em pasta, e cada um assina do seu jeito.
  const porProvedor = new Map();
  for (const d of docs) {
    const chave = d.provedor || '';
    if (!porProvedor.has(chave)) porProvedor.set(chave, []);
    porProvedor.get(chave).push(d);
  }

  const urls = new Map();
  for (const [, grupo] of porProvedor) {
    const prov = armazenamentoDe(grupo[0]);
    if (!prov) continue;
    if (typeof prov.urlsDeLeitura === 'function') {
      const m = await prov.urlsDeLeitura(grupo.map((d) => d.caminho), segundos);
      for (const [caminho, url] of m) urls.set(caminho, url);
    }
  }

  return Promise.all(
    docs.map(async (d) => {
      const prov = armazenamentoDe(d);
      if (!prov) return { ...d, url: null, indisponivel: motivoIndisponivel(d) };

      // Já veio no lote? Senão tenta individualmente — cobre o provedor sem
      // assinatura em lote e o caminho que o lote não devolveu.
      let url = urls.get(d.caminho);
      if (!url) {
        try {
          url = await prov.urlDeLeitura(d.caminho, segundos);
        } catch (e) {
          return { ...d, url: null, indisponivel: e.message.slice(0, 120) };
        }
      }
      return { ...d, url: url || (rotaDeDownload ? rotaDeDownload(d) : null) };
    })
  );
}

/** URL temporária para baixar um documento (null quando não há link direto). */
async function urlDeLeitura(id, segundos = 600) {
  const d = await db.prepare('SELECT caminho, provedor FROM documentos WHERE id = ?').get(id);
  if (!d || !d.caminho) return null;
  const prov = armazenamentoDe(d);
  return prov ? prov.urlDeLeitura(d.caminho, segundos) : null;
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
  const d = await db.prepare('SELECT caminho, provedor FROM documentos WHERE id = ?').get(id);
  if (!d) return { ok: false, erro: 'Documento não encontrado.' };

  // Primeiro o arquivo: se falhar, o registro fica e dá para tentar de novo.
  // Na ordem inversa, um erro deixaria arquivo órfão no storage, invisível.
  if (d.caminho) {
    const prov = armazenamentoDe(d);
    // Sem o provedor certo, apagar o registro esconderia um arquivo que
    // continua existindo — e com CPF e CNH dentro. Melhor recusar.
    if (!prov) return { ok: false, erro: motivoIndisponivel(d) };
    try {
      await prov.remover(d.caminho);
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
    .prepare('SELECT id, caminho, provedor FROM documentos WHERE modulo = ? AND solicitacao_id = ?')
    .all(modulo, solicitacaoId);

  for (const d of lista) {
    if (!d.caminho) continue;
    // Um arquivo que não sai não deve impedir a exclusão dos outros nem da
    // solicitação; vira lixo no storage, que é menos grave que travar a operação.
    const prov = armazenamentoDe(d);
    if (!prov) {
      console.error(`[documentos] ${d.caminho} ficou órfão: ${motivoIndisponivel(d)}`);
      continue;
    }
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

/**
 * Quais solicitações têm um documento de um TIPO — só os ids, não os arquivos.
 *
 * Existe para o painel poder dizer "o comprovante do RDO está anexado" a quem
 * NÃO pode abrir o arquivo. O responsável precisa do fato (para confirmar a
 * reprovação); o arquivo em si continua sendo só do admin.
 */
async function idsComTipo(modulo, tipo) {
  // A comparação passa pelo código canônico, e não por upper(tipo) = upper(?),
  // porque a tabela guarda as duas grafias do mesmo documento: "RESULTADO RDO"
  // nas linhas antigas e "RESULTADO_RDO" nas novas. Com upper(), o painel
  // dizia "o comprovante não foi anexado" para cadastro que tinha o anexo —
  // e o responsável ficava sem poder confirmar a reprovação.
  //
  // Filtra em SQL pelo módulo (que usa índice) e canoniza em JS: a função de
  // normalização vive no Node, e replicar as regras dela em SQL criaria duas
  // definições do que é o mesmo tipo — exatamente o problema que ela resolve.
  const alvo = tiposDocumento.canonico(tipo);

  const linhas = await db
    .prepare(`SELECT DISTINCT solicitacao_id, tipo FROM documentos WHERE modulo = ?`)
    .all(modulo);

  return new Set(
    linhas
      .filter((l) => tiposDocumento.canonico(l.tipo) === alvo)
      .map((l) => Number(l.solicitacao_id))
  );
}

module.exports = {
  prepararEnvio,
  buscarPorId,
  armazenamentoDe,
  comUrls,
  motivoIndisponivel,
  registrar,
  listar,
  listarDeVarias,
  urlDeLeitura,
  excluir,
  excluirDaSolicitacao,
  contarPorSolicitacao,
  idsComTipo,
};
