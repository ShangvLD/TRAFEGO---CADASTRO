/* ============================================================================
   Camada de dados do cadastro nativo (formulário do Portal)

   Grava o cadastro nas DUAS formas, de propósito:

     1. ESTRUTURADA — tabelas condutores / proprietarios / veiculos /
        solicitacao_cadastro / documentos. É o que permite consulta de verdade
        ("quais CNHs vencem em 30 dias?") e alimenta o BI.

     2. LEGADA — a linha em "solicitacoes" com "assunto" (operações separadas
        por "|") e "detalhes" (texto no mesmo formato que o Microsoft Forms
        produz). É o que o painel do responsável já sabe ler.

   Por que as duas: o painel, a API e o fluxo de aprovação por operação
   funcionam hoje sobre o formato legado. Escrever nos dois mantém tudo
   funcionando SEM ALTERAÇÃO no painel durante a transição — o mesmo princípio
   que tornou a migração Turso → Supabase segura (trocar a implementação e
   preservar o contrato).

   Quando o painel passar a ler o formato estruturado, a escrita legada pode
   ser removida. Até lá, ela é a rede de segurança.
   ========================================================================== */

const db = require('./db');
const { validarCadastro, formatarCpf, formatarTelefone, formatarPlaca } = require('./validacao');

// ---------------------------------------------------------------------------
// Representação legada
// ---------------------------------------------------------------------------

/**
 * Monta o texto de "detalhes" no formato que o painel já interpreta:
 * "Rótulo: valor | Rótulo: valor | ...".
 *
 * A ordem espelha a dos registros vindos do Forms, para o modal de detalhes
 * exibir os campos na mesma sequência a que as pessoas já estão acostumadas.
 * Campos ausentes entram vazios (o painel oculta), mantendo a mesma "cara".
 */
function montarDetalhesLegado(d) {
  const partes = [
    ['Condutor', d.condutor_nome],
    ['CPF', d.condutor_cpf ? formatarCpf(d.condutor_cpf) : ''],
    ['EMAIL', d.condutor_email],
    ['Contato MOT', d.condutor_telefone ? formatarTelefone(d.condutor_telefone) : ''],
    ['CNH', d.cnh_numero],
    ['Categoria CNH', d.cnh_categoria],
    ['Validade CNH', d.cnh_validade ? formatarDataBr(d.cnh_validade) : ''],
    ['Proprietário', d.proprietario_nome],
    ['Doc Proprietário', d.proprietario_documento ? formatarDocumento(d.proprietario_documento) : ''],
    ['Contato Prop', d.proprietario_telefone ? formatarTelefone(d.proprietario_telefone) : ''],
    ['TAG', d.tag],
    ['Placa Cavalo', d.placa_cavalo ? formatarPlaca(d.placa_cavalo) : ''],
    ['Placa Carreta', d.placa_carreta ? formatarPlaca(d.placa_carreta) : ''],
    ['Rastreador ID', d.rastreador_id],
    ['OBS', d.obs],
  ];
  return partes.map(([rotulo, valor]) => `${rotulo}: ${valor == null ? '' : valor}`).join(' | ');
}

/** AAAA-MM-DD -> DD/MM/AAAA (só para o texto legado). */
function formatarDataBr(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}

/** Formata CPF ou CNPJ conforme o tamanho. */
function formatarDocumento(digitos) {
  const d = String(digitos || '');
  if (d.length === 11) return formatarCpf(d);
  if (d.length === 14) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return d;
}

/** O "assunto" é a lista de operações separada por " | " (formato do painel). */
function montarAssuntoLegado(operacoes) {
  return (operacoes || []).join(' | ');
}

// ---------------------------------------------------------------------------
// Criação do cadastro
// ---------------------------------------------------------------------------

/**
 * Cria um cadastro a partir dos dados JÁ VALIDADOS pelo módulo de validação.
 *
 * @param dados        saída de validarCadastro().dados
 * @param solicitante  { nome, email } — quem está logado no Portal
 * @returns { id, condutor_id, proprietario_id }
 *
 * Tudo numa transação: se qualquer passo falhar, nada é gravado.
 */
async function criar(dados, solicitante) {
  const assunto = montarAssuntoLegado(dados.operacoes);
  const detalhes = montarDetalhesLegado(dados);

  return db.transacao(async (q) => {
    // ---- Condutor: upsert por CPF ----------------------------------------
    // O mesmo condutor pode ser cadastrado mais de uma vez (recadastro, troca
    // de operação). Atualizamos os dados dele e reaproveitamos o registro, em
    // vez de duplicar. COALESCE preserva o que já havia quando o campo novo
    // vem vazio — não deixamos um recadastro incompleto apagar dado bom.
    const condutor = await q(
      `INSERT INTO condutores (cpf, nome, email, telefone, cnh_numero, cnh_categoria, cnh_validade)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (cpf) DO UPDATE SET
         nome          = excluded.nome,
         email         = COALESCE(excluded.email, condutores.email),
         telefone      = COALESCE(excluded.telefone, condutores.telefone),
         cnh_numero    = COALESCE(excluded.cnh_numero, condutores.cnh_numero),
         cnh_categoria = COALESCE(excluded.cnh_categoria, condutores.cnh_categoria),
         cnh_validade  = COALESCE(excluded.cnh_validade, condutores.cnh_validade),
         atualizado_em = ${db.AGORA_SQL}
       RETURNING id`,
      [
        dados.condutor_cpf,
        dados.condutor_nome,
        dados.condutor_email || null,
        dados.condutor_telefone || null,
        dados.cnh_numero || null,
        dados.cnh_categoria || null,
        dados.cnh_validade || null,
      ]
    );
    const condutorId = condutor.rows[0].id;

    // ---- Proprietário: upsert por documento -------------------------------
    // Sem documento informado não há chave para deduplicar, então grava solto.
    let proprietarioId = null;
    if (dados.proprietario_nome || dados.proprietario_documento) {
      if (dados.proprietario_documento) {
        const p = await q(
          `INSERT INTO proprietarios (documento, nome, telefone)
           VALUES (?, ?, ?)
           ON CONFLICT (documento) DO UPDATE SET
             nome          = excluded.nome,
             telefone      = COALESCE(excluded.telefone, proprietarios.telefone),
             atualizado_em = ${db.AGORA_SQL}
           RETURNING id`,
          [dados.proprietario_documento, dados.proprietario_nome || '(sem nome)', dados.proprietario_telefone || null]
        );
        proprietarioId = p.rows[0].id;
      } else {
        const p = await q(
          `INSERT INTO proprietarios (nome, telefone) VALUES (?, ?) RETURNING id`,
          [dados.proprietario_nome, dados.proprietario_telefone || null]
        );
        proprietarioId = p.rows[0].id;
      }
    }

    // ---- Veículos: registra as placas no catálogo -------------------------
    for (const [placa, tipo] of [
      [dados.placa_cavalo, 'cavalo'],
      [dados.placa_carreta, 'carreta'],
    ]) {
      if (!placa) continue;
      await q(
        `INSERT INTO veiculos (placa, tipo) VALUES (?, ?)
         ON CONFLICT (placa) DO UPDATE SET tipo = excluded.tipo`,
        [placa, tipo]
      );
    }

    // ---- Solicitação (formato legado, que o painel lê) --------------------
    const s = await q(
      `INSERT INTO solicitacoes
         (solicitante_nome, solicitante_email, assunto, detalhes, origem)
       VALUES (?, ?, ?, ?, 'portal')
       RETURNING id`,
      [solicitante.nome, solicitante.email, assunto, detalhes]
    );
    const solicitacaoId = s.rows[0].id;

    // ---- Dados estruturados ----------------------------------------------
    await q(
      `INSERT INTO solicitacao_cadastro
         (solicitacao_id, condutor_id, proprietario_id, placa_cavalo, placa_carreta, tag, rastreador_id, obs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        solicitacaoId,
        condutorId,
        proprietarioId,
        dados.placa_cavalo || null,
        dados.placa_carreta || null,
        dados.tag || null,
        dados.rastreador_id || null,
        dados.obs || null,
      ]
    );

    return { id: solicitacaoId, condutor_id: condutorId, proprietario_id: proprietarioId };
  });
}

/**
 * Valida e cria em um passo. Devolve:
 *   { ok: true, id, condutor_id }            — gravou
 *   { ok: false, erros: { campo: msg } }     — não passou na validação
 *
 * As operações permitidas vêm da CONFIGURAÇÃO no banco (editável pelo admin),
 * não da constante do código — senão um cliente recém-cadastrado pela tela
 * seria recusado aqui.
 */
async function validarECriar(entrada, solicitante) {
  // require aqui dentro (e não no topo) para evitar ciclo:
  // config-formulario -> validacao, e cadastros -> config-formulario.
  const configFormulario = require('./config-formulario');
  const operacoesPermitidas = (await configFormulario.operacoesAtivas()).map((o) => o.nome);

  const { ok, dados, erros } = validarCadastro(entrada, { operacoesPermitidas });
  if (!ok) return { ok: false, erros };
  const criado = await criar(dados, solicitante);
  return { ok: true, ...criado };
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

/** Dados estruturados de uma solicitação (null se ela não vier do formulário nativo). */
async function buscarPorSolicitacao(solicitacaoId) {
  return db
    .prepare(
      `SELECT sc.*,
              c.nome  AS condutor_nome,  c.cpf   AS condutor_cpf,
              c.email AS condutor_email, c.telefone AS condutor_telefone,
              c.cnh_numero, c.cnh_categoria, c.cnh_validade,
              p.nome AS proprietario_nome, p.documento AS proprietario_documento,
              p.telefone AS proprietario_telefone
         FROM solicitacao_cadastro sc
         LEFT JOIN condutores    c ON c.id = sc.condutor_id
         LEFT JOIN proprietarios p ON p.id = sc.proprietario_id
        WHERE sc.solicitacao_id = ?`
    )
    .get(solicitacaoId);
}

/** Documentos de uma solicitação. */
async function listarDocumentos(solicitacaoId) {
  return db
    .prepare(
      `SELECT id, tipo, nome_arquivo, drive_id, item_id, tamanho, content_type, validade, enviado_em
         FROM documentos WHERE solicitacao_id = ? ORDER BY id`
    )
    .all(solicitacaoId);
}

/**
 * Condutores com CNH vencendo dentro de N dias (ou já vencida).
 * É a consulta que só se torna possível com o modelo estruturado — hoje, com a
 * validade dentro de uma string de texto, isso não existe.
 */
async function cnhVencendo(dias = 30) {
  return db
    .prepare(
      `SELECT id, nome, cpf, telefone, cnh_numero, cnh_categoria, cnh_validade
         FROM condutores
        WHERE cnh_validade IS NOT NULL
          AND cnh_validade <= to_char((now() AT TIME ZONE 'UTC') + make_interval(days => ?), 'YYYY-MM-DD')
        ORDER BY cnh_validade`
    )
    .all(dias);
}

module.exports = {
  criar,
  validarECriar,
  buscarPorSolicitacao,
  listarDocumentos,
  cnhVencendo,
  // expostos para teste
  montarDetalhesLegado,
  montarAssuntoLegado,
};
