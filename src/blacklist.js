/* ============================================================================
   Blacklist Geomed — proprietários que não podem ser cadastrados

   A regra de negócio existe hoje, mas mora no WhatsApp: a diretoria avisa que
   determinado proprietário não deve ser cadastrado, e a pessoa da contratação
   guarda isso de cabeça. Quem sai de férias leva a lista junto, e o cadastro
   passa.

   Aqui a lista vira registro: um CPF ou CNPJ, quem mandou bloquear, o motivo e
   a data. O envio de cadastro consulta e PARA quando o documento está na lista.

   O bloqueio é sempre pelo PROPRIETÁRIO — é ele que a diretoria recusa, e é o
   documento dele que reaparece com outro motorista e outra placa na tentativa
   seguinte.

   NADA É APAGADO. Desbloquear preenche liberado_em/liberado_por/liberado_motivo
   e a linha continua lá. Um bloqueio que some não deixa como responder "por que
   este cadastro ficou parado três semanas em março".
   ========================================================================== */

const db = require('./db');
const { apenasDigitos, cpfValido, cnpjValido, formatarCpf, formatarCnpj } = require('./validacao');

/* ---------------------------------------------------------------------------
   Quem manda bloquear

   Lista fechada, e não texto livre, porque este campo é a AUTORIDADE do
   bloqueio: é a resposta a "quem decidiu isso?" quando o proprietário liga
   reclamando. Digitado à mão, viraria "eduardo", "Ed", "diretoria" — e nenhum
   desses nomes localiza a pessoa que decidiu.

   Para acrescentar alguém, basta uma linha aqui: a tela e a validação leem
   desta lista.
   --------------------------------------------------------------------------- */
const BLOQUEADORES = [
  'Eduardo.Garrido',
  'Vanderlei.Garrido',
  'Cintia.Farias',
  'Saulo.Faqueris',
  'Setor Contratação',
];

/** Documento só com dígitos — a forma em que ele é guardado e comparado. */
function normalizar(documento) {
  return apenasDigitos(documento);
}

/** CPF (11) ou CNPJ (14) com dígito verificador conferido. */
function documentoValido(documento) {
  const d = normalizar(documento);
  if (d.length === 11) return cpfValido(d);
  if (d.length === 14) return cnpjValido(d);
  return false;
}

/** Máscara de exibição, conforme o tamanho. */
function formatar(documento) {
  const d = normalizar(documento);
  if (d.length === 11) return formatarCpf(d);
  if (d.length === 14) return formatarCnpj(d);
  return d;
}

/** 'CPF' ou 'CNPJ' — usado nas mensagens, para a pessoa saber o que conferir. */
function tipoDe(documento) {
  return normalizar(documento).length === 14 ? 'CNPJ' : 'CPF';
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

/**
 * O registro ATIVO deste documento, ou null.
 *
 * "Ativo" é liberado_em IS NULL. O índice único parcial garante que exista no
 * máximo um por documento — bloquear duas vezes o mesmo CPF sem ter liberado
 * daria erro de chave, e não duas linhas ativas dizendo coisas diferentes.
 */
async function buscar(documento) {
  const d = normalizar(documento);
  if (!d) return null;

  return (
    (await db
      .prepare('SELECT * FROM blacklist WHERE documento = ? AND liberado_em IS NULL')
      .get(d)) || null
  );
}

/** Atalho: { bloqueado, registro }. */
async function verificar(documento) {
  const registro = await buscar(documento);
  return { bloqueado: !!registro, registro };
}

/**
 * Mensagem mostrada a quem tentou enviar o cadastro.
 *
 * Diz O QUE aconteceu e A QUEM recorrer, e NÃO repete o motivo do bloqueio: o
 * motivo é anotação interna da contratação ("suspeita de X", "processo Y"), e
 * quem envia o cadastro pode ser o próprio proprietário.
 */
function mensagemDeBloqueio(registro) {
  const quem = registro && registro.bloqueado_por ? ` por ${registro.bloqueado_por}` : '';
  return (
    `Este ${tipoDe(registro.documento)} está na Blacklist Geomed (bloqueado${quem}). ` +
    'O cadastro não pode prosseguir — procure o setor de contratação.'
  );
}

/**
 * Procura, num objeto de respostas, algum documento de proprietário bloqueado.
 *
 * Existe para os módulos genéricos (agregado, candidato), onde os campos são
 * criados na tela de configuração e não têm nome fixo: o que identifica o
 * campo é falar de proprietário E conter um CPF ou CNPJ válido. Um telefone ou
 * um nome na mesma seção não passam pelo teste de dígito verificador.
 *
 * @returns { bloqueado, registro, campo } — campo é a chave que bateu, para o
 *          erro aparecer embaixo do campo certo no formulário.
 */
async function verificarRespostas(valores) {
  if (!valores || typeof valores !== 'object') return { bloqueado: false };

  for (const [campo, valor] of Object.entries(valores)) {
    if (!/propriet/i.test(campo)) continue;
    if (!documentoValido(valor)) continue;

    const { bloqueado, registro } = await verificar(valor);
    if (bloqueado) return { bloqueado: true, registro, campo };
  }

  return { bloqueado: false };
}

/* ---------------------------------------------------------------------------
   Rótulos que carregam o documento do proprietário no texto de "detalhes"

   O que chega pelo webhook do Forms não é um objeto com campos nomeados: é uma
   string "Rótulo: valor | Rótulo: valor". E o rótulo varia conforme a época do
   formulário, então a lista é aberta.

   "CPF" sozinho está FORA de propósito: nesse formato ele é o CPF do CONDUTOR,
   e bloquear por ele barraria o motorista errado. "CNPJ" sozinho entra porque
   pessoa jurídica, neste cadastro, é sempre o proprietário.
   --------------------------------------------------------------------------- */
const ROTULOS_DO_PROPRIETARIO = [
  'Doc Proprietário',
  'Documento Proprietário',
  'CPF Proprietário',
  'CNPJ Proprietário',
  'CPF/CNPJ Proprietário',
  'Proprietário CPF',
  'Proprietário CNPJ',
  'CNPJ',
];

const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const chaveDeRotulo = (t) => semAcento(t).trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Procura o documento do proprietário dentro do texto "Rótulo: valor | ...".
 *
 * Devolve '' quando não acha — e não achar é o caso comum hoje: o Forms em
 * produção coleta só o NOME do proprietário. Isso é um limite conhecido desta
 * porta de entrada, não um erro: sem o documento não há como bloquear, e a
 * solicitação entra normalmente.
 */
function documentoDoTexto(detalhes) {
  const texto = String(detalhes == null ? '' : detalhes);
  if (!texto) return '';

  const alvos = new Set(ROTULOS_DO_PROPRIETARIO.map(chaveDeRotulo));

  for (const parte of texto.split(/\s*\|\s*|\r?\n/)) {
    const pos = parte.indexOf(':');
    if (pos < 0) continue;
    if (!alvos.has(chaveDeRotulo(parte.slice(0, pos)))) continue;

    const valor = parte.slice(pos + 1).trim();
    if (documentoValido(valor)) return normalizar(valor);
  }

  return '';
}

/**
 * Lista para a tela. Bloqueios ativos primeiro, mais recentes no topo:
 * a pergunta do dia a dia é "quem está bloqueado agora", e o histórico de
 * liberados é consulta eventual.
 */
async function listar() {
  return db
    .prepare(
      `SELECT * FROM blacklist
        ORDER BY (liberado_em IS NULL) DESC, criado_em DESC, id DESC`
    )
    .all();
}

// ---------------------------------------------------------------------------
// Escrita
// ---------------------------------------------------------------------------

/**
 * Bloqueia um documento.
 *
 * @param criadoPor  e-mail de quem registrou no Portal. É diferente de
 *   bloqueado_por: um é quem DECIDIU (a diretoria), o outro é quem DIGITOU.
 *   Guardar só um dos dois perde metade da trilha.
 *
 * @returns { ok: false, erros } ou { ok: true, registro }
 */
async function bloquear({ documento, nome, bloqueado_por, motivo }, criadoPor) {
  const erros = {};

  const doc = normalizar(documento);
  if (!doc) erros.documento = 'Informe o CPF ou CNPJ do proprietário.';
  else if (!documentoValido(doc)) {
    erros.documento =
      doc.length === 11 || doc.length === 14
        ? `${tipoDe(doc)} inválido (confira os dígitos).`
        : 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).';
  }

  const quem = String(bloqueado_por || '').trim();
  if (!quem) erros.bloqueado_por = 'Informe quem mandou bloquear.';
  else if (!BLOQUEADORES.includes(quem)) erros.bloqueado_por = 'Nome fora da lista.';

  // O motivo é obrigatório de propósito. Um bloqueio sem motivo é
  // indefensável seis meses depois, quando ninguém lembra do WhatsApp em que
  // a decisão foi tomada — e é o que trava a liberação de quem foi bloqueado
  // por engano.
  const porque = String(motivo || '').trim();
  if (!porque) erros.motivo = 'Descreva o motivo do bloqueio.';
  else if (porque.length > 2000) erros.motivo = 'O motivo deve ter no máximo 2000 caracteres.';

  const nomeProp = String(nome || '').trim();
  if (nomeProp.length > 120) erros.nome = 'O nome deve ter no máximo 120 caracteres.';

  if (Object.keys(erros).length) return { ok: false, erros };

  const jaTem = await buscar(doc);
  if (jaTem) {
    return {
      ok: false,
      erros: { documento: `Este ${tipoDe(doc)} já está bloqueado (desde ${jaTem.criado_em}).` },
    };
  }

  const info = await db
    .prepare(
      `INSERT INTO blacklist (documento, nome, bloqueado_por, motivo, criado_por)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id`
    )
    .run(doc, nomeProp || null, quem, porque, criadoPor || null);

  return {
    ok: true,
    registro: await db.prepare('SELECT * FROM blacklist WHERE id = ?').get(info.lastInsertRowid),
  };
}

/**
 * Desbloqueia. A linha PERMANECE: ganha data, autor e motivo da liberação.
 *
 * O documento volta a poder ser bloqueado depois — o índice único só olha as
 * linhas ativas — e o histórico mostra as duas passagens.
 */
async function liberar(id, { liberado_por, motivo }) {
  const erros = {};

  const quem = String(liberado_por || '').trim();
  if (!quem) erros.liberado_por = 'Informe quem autorizou a liberação.';
  else if (!BLOQUEADORES.includes(quem)) erros.liberado_por = 'Nome fora da lista.';

  const porque = String(motivo || '').trim();
  if (!porque) erros.motivo = 'Descreva o motivo da liberação.';
  else if (porque.length > 2000) erros.motivo = 'O motivo deve ter no máximo 2000 caracteres.';

  if (Object.keys(erros).length) return { ok: false, erros };

  const info = await db
    .prepare(
      `UPDATE blacklist
          SET liberado_em     = datetime('now', 'localtime'),
              liberado_por    = ?,
              liberado_motivo = ?
        WHERE id = ? AND liberado_em IS NULL`
    )
    .run(quem, porque, id);

  if (!info.changes) {
    return { ok: false, erros: { geral: 'Bloqueio não encontrado ou já liberado.' } };
  }

  return { ok: true, registro: await db.prepare('SELECT * FROM blacklist WHERE id = ?').get(id) };
}

module.exports = {
  BLOQUEADORES,
  normalizar,
  documentoValido,
  formatar,
  tipoDe,
  buscar,
  verificar,
  verificarRespostas,
  documentoDoTexto,
  mensagemDeBloqueio,
  listar,
  bloquear,
  liberar,
};
