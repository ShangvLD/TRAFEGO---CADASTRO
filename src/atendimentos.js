/* ============================================================================
   Quem está cuidando de cada cadastro

   Antes de abrir uma solicitação, a pessoa declara como vai participar:

     responsavel   assume o atendimento. Um por cadastro.
     colaborador   acompanha e ajuda, sem tirar o responsável. Vários.

   POR QUE ISSO EXISTE: hoje duas pessoas abrem o mesmo cadastro, as duas
   ligam para o motorista e as duas decidem. Registrar quem entrou resolve a
   pergunta "quem está com este?" antes do retrabalho acontecer, não depois.

   A regra de UM responsável está no índice único do banco, não aqui. Duas
   pessoas clicando no mesmo segundo passariam por qualquer verificação feita
   em código antes do INSERT — o banco é o único ponto que enxerga as duas.
   ========================================================================== */

const db = require('./db');

/** Participações ativas de um cadastro, responsável primeiro. */
async function listar(modulo, solicitacaoId) {
  return db
    .prepare(
      `SELECT id, usuario_id, usuario_nome, usuario_email, papel, entrou_em, atualizado_em
         FROM atendimentos
        WHERE modulo = ? AND solicitacao_id = ? AND saiu_em IS NULL
        ORDER BY CASE papel WHEN 'responsavel' THEN 0 ELSE 1 END, entrou_em`
    )
    .all(modulo, solicitacaoId);
}

/** Forma que as telas consomem: responsável, colaboradores e última mexida. */
function montarResumo(linhas) {
  const responsavel = linhas.find((l) => l.papel === 'responsavel') || null;
  const colaboradores = linhas.filter((l) => l.papel === 'colaborador');
  const atualizadoEm = linhas.reduce(
    (maior, l) => (!maior || String(l.atualizado_em) > maior ? String(l.atualizado_em) : maior),
    null
  );
  return {
    emAtendimento: linhas.length > 0,
    responsavel: responsavel
      ? { id: responsavel.usuario_id, nome: responsavel.usuario_nome, email: responsavel.usuario_email, desde: responsavel.entrou_em }
      : null,
    colaboradores: colaboradores.map((c) => ({
      id: c.usuario_id,
      nome: c.usuario_nome,
      email: c.usuario_email,
      desde: c.entrou_em,
    })),
    atualizadoEm,
  };
}

async function resumo(modulo, solicitacaoId) {
  return montarResumo(await listar(modulo, solicitacaoId));
}

/**
 * Resumo de VÁRIAS solicitações de uma vez, para a listagem.
 *
 * Uma consulta só: o painel mostra dezenas de linhas, e uma consulta por linha
 * seria dezenas de idas ao banco a cada atualização automática da tela.
 */
async function resumoDeVarias(modulo, ids) {
  const lista = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  if (!lista.length) return {};

  const linhas = await db
    .prepare(
      `SELECT solicitacao_id, usuario_id, usuario_nome, usuario_email, papel, entrou_em, atualizado_em
         FROM atendimentos
        WHERE modulo = ? AND solicitacao_id = ANY(?) AND saiu_em IS NULL
        ORDER BY CASE papel WHEN 'responsavel' THEN 0 ELSE 1 END, entrou_em`
    )
    .all(modulo, lista);

  const porSolicitacao = {};
  for (const l of linhas) {
    (porSolicitacao[l.solicitacao_id] = porSolicitacao[l.solicitacao_id] || []).push(l);
  }

  const mapa = {};
  for (const id of Object.keys(porSolicitacao)) mapa[id] = montarResumo(porSolicitacao[id]);
  return mapa;
}

/** A participação ativa desta pessoa neste cadastro, se houver. */
async function minhaParticipacao(modulo, solicitacaoId, usuarioId) {
  return db
    .prepare(
      `SELECT id, papel, entrou_em FROM atendimentos
        WHERE modulo = ? AND solicitacao_id = ? AND usuario_id = ? AND saiu_em IS NULL`
    )
    .get(modulo, solicitacaoId, usuarioId);
}

/**
 * Entra num cadastro como responsável ou colaborador.
 *
 * @param forcar  admin assumindo um cadastro que já tem responsável. Sem isso
 *                um cadastro cujo responsável saiu de férias ficaria travado,
 *                e a saída seria mexer no banco na mão.
 */
async function entrar({ modulo, solicitacaoId, usuario, papel, forcar = false }) {
  if (papel !== 'responsavel' && papel !== 'colaborador') {
    return { ok: false, erro: 'Tipo de participação inválido.' };
  }

  const atual = await minhaParticipacao(modulo, solicitacaoId, usuario.id);

  // Já está aqui com o mesmo papel: não é erro, é a pessoa reabrindo a tela.
  if (atual && atual.papel === papel) {
    return { ok: true, papel, jaEstava: true, resumo: await resumo(modulo, solicitacaoId) };
  }

  if (papel === 'responsavel') {
    const dono = await db
      .prepare(
        `SELECT usuario_id, usuario_nome FROM atendimentos
          WHERE modulo = ? AND solicitacao_id = ? AND papel = 'responsavel' AND saiu_em IS NULL`
      )
      .get(modulo, solicitacaoId);

    if (dono && dono.usuario_id !== usuario.id) {
      if (!forcar) {
        return {
          ok: false,
          codigo: 'JA_TEM_RESPONSAVEL',
          erro: `${dono.usuario_nome} já assumiu este cadastro. Você pode entrar como colaborador.`,
          resumo: await resumo(modulo, solicitacaoId),
        };
      }
      // Transferência: o anterior vira colaborador em vez de sumir — ele
      // trabalhou no cadastro, e some do histórico se for só removido.
      await db
        .prepare(
          `UPDATE atendimentos SET papel = 'colaborador', atualizado_em = ${db.AGORA_SQL}
            WHERE modulo = ? AND solicitacao_id = ? AND usuario_id = ? AND saiu_em IS NULL`
        )
        .run(modulo, solicitacaoId, dono.usuario_id);
    }
  }

  if (atual) {
    // Promoção ou rebaixamento de quem já estava participando.
    await db
      .prepare(`UPDATE atendimentos SET papel = ?, atualizado_em = ${db.AGORA_SQL} WHERE id = ?`)
      .run(papel, atual.id);
  } else {
    // O nome e o e-mail ficam gravados aqui de propósito: se o usuário for
    // desativado ou trocar de e-mail, o histórico continua legível.
    await db
      .prepare(
        `INSERT INTO atendimentos (modulo, solicitacao_id, usuario_id, usuario_nome, usuario_email, papel)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(modulo, solicitacaoId, usuario.id, usuario.nome, usuario.email, papel);
  }

  return { ok: true, papel, resumo: await resumo(modulo, solicitacaoId) };
}

/** Sai do cadastro. A linha fica, com a data de saída. */
async function sair({ modulo, solicitacaoId, usuarioId }) {
  const r = await db
    .prepare(
      `UPDATE atendimentos SET saiu_em = ${db.AGORA_SQL}, atualizado_em = ${db.AGORA_SQL}
        WHERE modulo = ? AND solicitacao_id = ? AND usuario_id = ? AND saiu_em IS NULL`
    )
    .run(modulo, solicitacaoId, usuarioId);

  if (!r.changes) return { ok: false, erro: 'Você não está participando deste cadastro.' };
  return { ok: true, resumo: await resumo(modulo, solicitacaoId) };
}

/** Histórico completo, inclusive quem já saiu. */
async function historico(modulo, solicitacaoId) {
  return db
    .prepare(
      `SELECT usuario_nome, usuario_email, papel, entrou_em, saiu_em
         FROM atendimentos
        WHERE modulo = ? AND solicitacao_id = ?
        ORDER BY entrou_em`
    )
    .all(modulo, solicitacaoId);
}

/** Chamado quando a solicitação é excluída (não há FK para três tabelas). */
async function excluirDaSolicitacao(modulo, solicitacaoId) {
  const r = await db
    .prepare('DELETE FROM atendimentos WHERE modulo = ? AND solicitacao_id = ?')
    .run(modulo, solicitacaoId);
  return r.changes;
}

module.exports = {
  listar,
  resumo,
  resumoDeVarias,
  minhaParticipacao,
  entrar,
  sair,
  historico,
  excluirDaSolicitacao,
};
