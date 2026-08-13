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
const {
  validarCadastro, formatarCpf, formatarTelefone, formatarPlaca, formatarPis, acharPrioridade,
  apenasDigitos, normalizarPlaca, CAMPOS_DO_TERCEIRO,
} = require('./validacao');
const pesquisasCfg = require('./pesquisas');

const rotuloPrioridade = (id) => (acharPrioridade(id) || {}).rotulo;

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
 *
 * PERGUNTAS NOVAS, criadas na tela de configuração, entram DEPOIS dos 18, com
 * o rótulo que o admin deu. Os 18 mantêm os rótulos legados de propósito: são
 * os mesmos dos 51 registros históricos importados do Forms, e trocá-los faria
 * o mesmo campo aparecer com dois nomes conforme a idade do cadastro.
 *
 * @param extras  [{ id, rotulo }] das perguntas que não são as 18 conhecidas
 */
function montarDetalhesLegado(d, extras = []) {
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
    ['PIS Proprietário', d.proprietario_pis ? formatarPis(d.proprietario_pis) : ''],
    ['TAG', d.tag],
    ['Placa Cavalo', d.placa_cavalo ? formatarPlaca(d.placa_cavalo) : ''],
    ['Placa Carreta', d.placa_carreta ? formatarPlaca(d.placa_carreta) : ''],
    ['Rastreador', d.rastreador],
    ['Rastreador ID', d.rastreador_id],
    ['Prioridade', d.prioridade ? (rotuloPrioridade(d.prioridade) || d.prioridade) : ''],
    ['OBS', d.obs],
  ];

  // Vazio é omitido aqui (diferente dos 18 acima): uma pergunta nova que
  // ninguém respondeu não precisa ocupar linha no modal de detalhes.
  for (const extra of extras) {
    const valor = d[extra.id];
    if (valor === undefined || valor === null || valor === '') continue;
    partes.push([extra.rotulo, valor]);
  }

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
async function criar(dados, solicitante, { extras = [], pesquisa = null, existente = null } = {}) {
  const assunto = montarAssuntoLegado(dados.operacoes);
  const detalhes = pesquisa && pesquisa.renovacao
    ? montarDetalhesRenovacao(dados, pesquisa, existente, extras)
    : montarDetalhesLegado(dados, extras);

  // Na renovação, as placas não vêm do formulário: vêm do cadastro que foi
  // identificado. Aqui as duas origens viram uma só, para o resto da gravação
  // não precisar saber de onde veio.
  const placaCavalo = (existente && existente.placaCavalo) || dados.placa_cavalo || null;
  const placaCarreta = (existente && existente.placaCarreta) || dados.placa_carreta || null;

  return db.transacao(async (q) => {
    // ---- Condutor: upsert por CPF ----------------------------------------
    // O mesmo condutor pode ser cadastrado mais de uma vez (recadastro, troca
    // de operação). Atualizamos os dados dele e reaproveitamos o registro, em
    // vez de duplicar. COALESCE preserva o que já havia quando o campo novo
    // vem vazio — não deixamos um recadastro incompleto apagar dado bom.
    //
    // SEM CPF NÃO HÁ CONDUTOR: a pesquisa de veículo ou de carreta não pergunta
    // motorista nenhum, e a renovação usa o condutor que já existe. A coluna
    // condutor_id em solicitacao_cadastro é anulável exatamente para isso.
    let condutorId = existente ? existente.condutorId || null : null;

    if (!condutorId && dados.condutor_cpf) {
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
      condutorId = condutor.rows[0].id;
    }

    // ---- Proprietário: upsert por documento -------------------------------
    // Sem documento informado não há chave para deduplicar, então grava solto.
    let proprietarioId = null;
    if (dados.proprietario_nome || dados.proprietario_documento) {
      if (dados.proprietario_documento) {
        const p = await q(
          `INSERT INTO proprietarios (documento, nome, telefone, pis)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (documento) DO UPDATE SET
             nome          = excluded.nome,
             telefone      = COALESCE(excluded.telefone, proprietarios.telefone),
             -- COALESCE e nao substituicao: um cadastro novo sem o PIS nao
             -- apaga o PIS que outro cadastro ja tinha informado.
             pis           = COALESCE(excluded.pis, proprietarios.pis),
             atualizado_em = ${db.AGORA_SQL}
           RETURNING id`,
          [
            dados.proprietario_documento,
            dados.proprietario_nome || '(sem nome)',
            dados.proprietario_telefone || null,
            dados.proprietario_pis || null,
          ]
        );
        proprietarioId = p.rows[0].id;
      } else {
        const p = await q(
          `INSERT INTO proprietarios (nome, telefone, pis) VALUES (?, ?, ?) RETURNING id`,
          [dados.proprietario_nome, dados.proprietario_telefone || null, dados.proprietario_pis || null]
        );
        proprietarioId = p.rows[0].id;
      }
    }

    // ---- Veículos: registra as placas no catálogo -------------------------
    for (const [placa, tipo] of [
      [placaCavalo, 'cavalo'],
      [placaCarreta, 'carreta'],
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
         (solicitante_nome, solicitante_email, assunto, detalhes, origem, prioridade,
          tipo_pesquisa, alvo_renovacao)
       VALUES (?, ?, ?, ?, 'portal', ?, ?, ?)
       RETURNING id`,
      [
        solicitante.nome,
        solicitante.email,
        assunto,
        detalhes,
        dados.prioridade || null,
        pesquisa ? pesquisa.tipo : null,
        pesquisa ? pesquisa.alvo || null : null,
      ]
    );
    const solicitacaoId = s.rows[0].id;

    // ---- Dados estruturados ----------------------------------------------
    await q(
      `INSERT INTO solicitacao_cadastro
         (solicitacao_id, condutor_id, proprietario_id, placa_cavalo, placa_carreta, tag, rastreador, rastreador_id, obs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        solicitacaoId,
        condutorId,
        proprietarioId,
        placaCavalo,
        placaCarreta,
        dados.tag || null,
        dados.rastreador || null,
        dados.rastreador_id || null,
        dados.obs || null,
      ]
    );

    return { id: solicitacaoId, condutor_id: condutorId, proprietario_id: proprietarioId };
  });
}

/* ---------------------------------------------------------------------------
   RENOVAÇÃO

   O item já tem cadastro. Nada de recadastrar: o formulário identifica o que
   já existe (por CPF ou por placa) e abre uma solicitação nova de pesquisa.
   --------------------------------------------------------------------------- */

/** Texto de detalhes de uma renovação — os 18 campos do cadastro não se aplicam. */
function montarDetalhesRenovacao(d, pesquisa, existente, extras = []) {
  const partes = [['Renovação', String(pesquisa.alvo || '').toUpperCase()]];

  if (existente && existente.resumo) {
    for (const [rotulo, valor] of existente.resumo) partes.push([rotulo, valor]);
  }
  if (d.prioridade) partes.push(['Prioridade', rotuloPrioridade(d.prioridade) || d.prioridade]);
  if (d.obs) partes.push(['OBS', d.obs]);

  for (const extra of extras) {
    const valor = d[extra.id];
    if (valor === undefined || valor === null || valor === '') continue;
    partes.push([extra.rotulo, valor]);
  }

  return partes.map(([rotulo, valor]) => `${rotulo}: ${valor == null ? '' : valor}`).join(' | ');
}

/**
 * Anexos que o cadastro existente já tem, por tipo.
 * Os documentos ficam presos a uma SOLICITAÇÃO, não ao condutor ou à placa —
 * então o caminho é pelas solicitações anteriores daquele mesmo item.
 */
async function anexosJaEnviados(alvo, chave) {
  const onde = {
    motorista: 'sc.condutor_id = ?',
    veiculo: 'sc.placa_cavalo = ?',
    carreta: 'sc.placa_carreta = ?',
  }[alvo];
  if (!onde) return new Map();

  const linhas = await db
    .prepare(
      `SELECT d.tipo,
              max(d.enviado_em) AS enviado_em,
              max(d.validade)   AS validade
         FROM documentos d
         JOIN solicitacao_cadastro sc ON sc.solicitacao_id = d.solicitacao_id
        WHERE d.modulo = 'terceiro' AND ${onde}
        GROUP BY d.tipo`
    )
    .all(chave);

  return new Map(linhas.map((l) => [String(l.tipo).toUpperCase(), l]));
}

/**
 * Encontra o cadastro que a renovação vai renovar.
 *
 * @returns { ok:true, existente, resumo, anexos } ou { ok:false, erro }
 *   anexos — só os que FALTAM ou estão VENCIDOS. Um documento com validade que
 *   ninguém registrou entra como pendente de propósito: não saber a validade
 *   não é prova de que está válido, e a renovação existe justamente para o
 *   cliente reavaliar o que venceu.
 */
async function acharParaRenovar(alvo, valor, { documentosDoModulo = [], hoje = null } = {}) {
  const bruto = String(valor || '').trim();
  if (!bruto) return { ok: false, erro: 'Informe o que deseja renovar.' };

  let existente = null;
  let resumo = [];
  let chave = null;

  if (alvo === 'motorista') {
    const cpf = apenasDigitos(bruto);
    const c = await db
      .prepare('SELECT id, cpf, nome, telefone, cnh_numero, cnh_categoria, cnh_validade FROM condutores WHERE cpf = ?')
      .get(cpf);
    if (!c) return { ok: false, erro: 'naoAchou' };

    existente = { condutorId: c.id };
    chave = c.id;
    resumo = [
      ['Condutor', c.nome],
      ['CPF', formatarCpf(c.cpf)],
      ['Contato MOT', c.telefone ? formatarTelefone(c.telefone) : ''],
      ['CNH', c.cnh_numero || ''],
      ['Categoria CNH', c.cnh_categoria || ''],
      ['Validade CNH', c.cnh_validade ? formatarDataBr(c.cnh_validade) : ''],
    ].filter(([, v]) => v);
  } else {
    const placa = normalizarPlaca(bruto);
    const v = await db.prepare('SELECT id, placa, tipo FROM veiculos WHERE placa = ?').get(placa);
    if (!v) return { ok: false, erro: 'naoAchou' };

    existente = alvo === 'carreta' ? { placaCarreta: v.placa } : { placaCavalo: v.placa };
    chave = v.placa;
    resumo = [[alvo === 'carreta' ? 'Placa Carreta' : 'Placa Cavalo', formatarPlaca(v.placa)]];
  }

  const jaEnviados = await anexosJaEnviados(alvo, chave);
  const referencia = hoje || new Date().toISOString().slice(0, 10);

  const anexos = documentosDoModulo.map((doc) => {
    const enviado = jaEnviados.get(String(doc.codigo).toUpperCase());

    if (!enviado) {
      return { ...doc, situacao: 'faltando', motivo: 'Nunca foi enviado para este cadastro.' };
    }
    if (doc.temValidade && !enviado.validade) {
      return { ...doc, situacao: 'sem_validade', enviadoEm: enviado.enviado_em,
               motivo: 'Já foi enviado, mas sem validade registrada.' };
    }
    if (doc.temValidade && enviado.validade < referencia) {
      return { ...doc, situacao: 'vencido', enviadoEm: enviado.enviado_em, validade: enviado.validade,
               motivo: `Venceu em ${formatarDataBr(enviado.validade)}.` };
    }
    return { ...doc, situacao: 'ok', enviadoEm: enviado.enviado_em, validade: enviado.validade || null };
  });

  return {
    ok: true,
    existente: { ...existente, resumo },
    resumo,
    anexos,
    pendentes: anexos.filter((a) => a.situacao !== 'ok'),
  };
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

  // ---- Qual modalidade foi escolhida ------------------------------------
  const recorte = pesquisasCfg.resolver(entrada.tipoPesquisa, entrada.alvoRenovacao);
  if (!recorte.ok) return { ok: false, erros: { tipoPesquisa: recorte.erro } };

  const [operacoes, perguntas, docs] = await Promise.all([
    configFormulario.operacoesAtivas(),
    // Só as ATIVAS: campo desativado não foi mostrado, e o que não foi
    // mostrado não pode ser exigido nem gravado.
    configFormulario.perguntas('terceiro', { apenasAtivas: true }),
    configFormulario.documentos('terceiro', { apenasAtivos: true }),
  ]);

  // O RECORTE vale aqui também, não só na tela: a pesquisa de motorista não
  // pode exigir a placa do cavalo só porque alguém mandou um POST direto.
  const campos = perguntas
    .filter((p) => pesquisasCfg.escopoCabe(p.escopo, recorte.escopos))
    .map((p) => ({
      id: p.campoId,
      rotulo: p.rotulo,
      tipo: p.tipo,
      obrigatorio: p.obrigatorio,
      opcoes: p.opcoes,
      max: p.max,
    }));

  // ---- Renovação: identifica o cadastro em vez de perguntar de novo ------
  let existente = null;
  if (recorte.renovacao) {
    const escoposDeAnexo = recorte.escoposDeAnexo || recorte.escopos;
    const achado = await acharParaRenovar(recorte.alvo, entrada[recorte.identificacao.campo], {
      documentosDoModulo: docs.filter((d) => pesquisasCfg.escopoCabe(d.escopo, escoposDeAnexo)),
    });

    if (!achado.ok) {
      const mensagem = achado.erro === 'naoAchou' ? recorte.identificacao.naoAchou : achado.erro;
      return { ok: false, erros: { [recorte.identificacao.campo]: mensagem } };
    }
    existente = achado.existente;
  }

  const { ok, dados, erros } = validarCadastro(entrada, {
    operacoesPermitidas: operacoes.map((o) => o.nome),
    campos,
  });
  if (!ok) return { ok: false, erros };

  // Perguntas que não são as 18 do desenho original: elas não têm coluna
  // própria, então a resposta entra no texto de "detalhes", que é o que o
  // painel já lê campo a campo.
  const conhecidos = new Set(CAMPOS_DO_TERCEIRO.map((c) => c.id));
  const extras = campos.filter((c) => !conhecidos.has(c.id));

  const criado = await criar(dados, solicitante, {
    extras,
    pesquisa: { tipo: recorte.tipo, alvo: recorte.alvo, renovacao: recorte.renovacao },
    existente,
  });
  return { ok: true, ...criado, tipoPesquisa: recorte.tipo, alvo: recorte.alvo };
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
  acharParaRenovar,
  buscarPorSolicitacao,
  listarDocumentos,
  cnhVencendo,
  // expostos para teste
  montarDetalhesLegado,
  montarAssuntoLegado,
};
