/* ============================================================================
   Tipos de pesquisa — o que cada modalidade pergunta

   Uma solicitação de cadastro nem sempre precisa de tudo. Pesquisar só o
   motorista para um cliente novo não exige CRLV da carreta; renovar a pesquisa
   de um veículo que já está cadastrado não exige recadastrar o veículo.

   Duas ideias, e a diferença entre elas é o que a tela precisa deixar claro:

     CADASTRO   (completo, motorista, veiculo, carreta)
                O item ainda não tem pesquisa. Pergunta o que aquele recorte
                precisa e cria o cadastro.

     RENOVAÇÃO  O item JÁ tem cadastro. Não pergunta de novo o que já está
                gravado: identifica o cadastro existente e abre uma nova
                solicitação de pesquisa junto ao cliente/gerenciadora.

   ----------------------------------------------------------------------------
   COMO O RECORTE É FEITO: pelo ESCOPO

   Cada pergunta e cada anexo declara a que ele pertence (coluna "escopo" em
   cfg_campos e cfg_documentos):

     solicitacao  aparece nas CINCO modalidades. É o que descreve o pedido
                  (grau de importância, observação) e o que pode ter MUDADO
                  desde o cadastro — o proprietário: o motorista pode ter
                  trocado de empresa, e a renovação precisa saber.
     geral        é do cadastro e não muda: aparece nas quatro que criam
                  cadastro, não na renovação.
     motorista    é do condutor  (CPF, CNH, comprovante de residência)
     veiculo      é do cavalo    (placa do cavalo, CRLV do cavalo, ANTT)
     carreta      é da carreta   (placa da carreta, CRLV da carreta)

   A diferença entre "solicitacao" e "geral" é o que decide o que a RENOVAÇÃO
   pergunta. Sem ela, ou a renovação repete o cadastro inteiro, ou perde o dado
   que muda entre uma pesquisa e outra. As duas coisas já aconteceram no papel.

   O escopo é EDITÁVEL na tela de configuração. Ele é um julgamento de negócio
   — "a conta bancária do proprietário é do veículo ou vale para tudo?" não é
   uma pergunta que o código saiba responder — e por isso não fica escondido
   aqui dentro.
   ========================================================================== */

const ESCOPOS = [
  {
    id: 'solicitacao',
    rotulo: 'Toda pesquisa (inclusive renovação)',
    icone: 'all_inclusive',
    ajuda: 'Aparece nas cinco modalidades. Use para o que descreve o PEDIDO ' +
           '(grau de importância, observação) e para o que PODE TER MUDADO desde ' +
           'o cadastro — o proprietário, por exemplo: o motorista pode ter trocado ' +
           'de empresa, e a renovação precisa saber disso.',
  },
  {
    id: 'geral',
    rotulo: 'Todo cadastro (menos renovação)',
    icone: 'assignment',
    ajuda: 'Aparece nas quatro pesquisas que criam cadastro, mas NÃO na renovação. ' +
           'Use para o dado cadastral que não muda e já está gravado — repeti-lo ' +
           'na renovação seria pedir de novo o que o sistema já tem.',
  },
  { id: 'motorista', rotulo: 'Motorista', icone: 'person',
    ajuda: 'Só nas pesquisas que envolvem o condutor.' },
  { id: 'veiculo', rotulo: 'Veículo', icone: 'local_shipping',
    ajuda: 'Só nas pesquisas que envolvem o cavalo.' },
  { id: 'carreta', rotulo: 'Carreta', icone: 'rv_hookup',
    ajuda: 'Só nas pesquisas que envolvem a carreta.' },
];

// Pergunta nova nasce como dado de cadastro: é o caso comum, e o erro dele é
// aparecer demais numa pesquisa específica — visível e fácil de corrigir. O
// contrário (nascer como "solicitação") a faria vazar para a renovação, que é
// justamente onde ninguém quer ver campo de cadastro.
const ESCOPO_PADRAO = 'geral';

function escopoValido(id) {
  return ESCOPOS.some((e) => e.id === id);
}

/** Normaliza um escopo vindo de fora; o que não reconhece vira "geral". */
function normalizarEscopo(valor) {
  const id = String(valor || '').trim().toLowerCase();
  return escopoValido(id) ? id : ESCOPO_PADRAO;
}

/* ---------------------------------------------------------------------------
   As modalidades

   "escopos" é a lista que o formulário mostra. "renovacao: true" muda o fluxo
   inteiro: em vez de perguntar o cadastro, o formulário identifica um cadastro
   que já existe.
   --------------------------------------------------------------------------- */
const TIPOS_PESQUISA = [
  {
    id: 'completo',
    rotulo: 'Completo',
    icone: 'checklist',
    resumo: 'Motorista, veículo, carreta e todos os anexos.',
    ajuda: 'A pesquisa inteira, como sempre foi: condutor, veículo, carreta, ' +
           'documentação e anexos. Use quando nada disso está cadastrado ainda.',
    escopos: ['solicitacao', 'geral', 'motorista', 'veiculo', 'carreta'],
    renovacao: false,
  },
  {
    id: 'motorista',
    rotulo: 'Motorista',
    icone: 'person',
    resumo: 'Só o condutor e os documentos dele.',
    ajuda: 'Pesquisa apenas do condutor: dados pessoais, CNH e os anexos dele. ' +
           'Nada de veículo ou carreta.',
    escopos: ['solicitacao', 'geral', 'motorista'],
    renovacao: false,
  },
  {
    id: 'veiculo',
    rotulo: 'Veículo',
    icone: 'local_shipping',
    resumo: 'Só o cavalo e os documentos dele.',
    ajuda: 'Pesquisa apenas do veículo: placa do cavalo, proprietário e os ' +
           'anexos do veículo. Nada de motorista ou carreta.',
    escopos: ['solicitacao', 'geral', 'veiculo'],
    renovacao: false,
  },
  {
    id: 'carreta',
    rotulo: 'Carreta',
    icone: 'rv_hookup',
    resumo: 'Só a carreta e os documentos dela.',
    ajuda: 'Pesquisa apenas da carreta: placa e anexos da carreta. Nada de ' +
           'motorista ou veículo.',
    escopos: ['solicitacao', 'geral', 'carreta'],
    renovacao: false,
  },
  {
    id: 'renovacao',
    rotulo: 'Renovação',
    icone: 'autorenew',
    resumo: 'O cadastro já existe — só pede a pesquisa de novo.',
    ajuda: 'Para quem JÁ tem cadastro. O formulário não pergunta os dados de ' +
           'novo: identifica o cadastro existente e abre uma nova solicitação ' +
           'de pesquisa junto ao cliente ou à gerenciadora.',
    // Renovação não coleta cadastro: só o que vale para qualquer solicitação
    // (grau de importância, observação) mais a identificação do que renovar.
    escopos: ['solicitacao'],
    renovacao: true,
    alvos: ['motorista', 'veiculo', 'carreta'],
  },
];

const TIPO_PADRAO = 'completo';

function acharTipoPesquisa(id) {
  const alvo = String(id || '').trim().toLowerCase();
  return TIPOS_PESQUISA.find((t) => t.id === alvo) || null;
}

/**
 * O que identifica o cadastro em cada alvo de renovação.
 *
 * O CPF e a placa são as chaves reais do sistema — o condutor é deduplicado por
 * CPF e o veículo por placa —, então são elas que encontram o cadastro.
 */
const IDENTIFICACAO = {
  motorista: {
    campo: 'renovacao_cpf',
    rotulo: 'CPF do motorista',
    tipo: 'cpf',
    placeholder: '000.000.000-00',
    dica: 'O cadastro é procurado por este CPF.',
    naoAchou: 'Não há motorista cadastrado com este CPF. Para cadastrar do zero, ' +
              'escolha o tipo de pesquisa "Motorista".',
  },
  veiculo: {
    campo: 'renovacao_placa',
    rotulo: 'Placa do cavalo',
    tipo: 'placa',
    placeholder: 'ABC1D23',
    dica: 'O cadastro é procurado por esta placa.',
    naoAchou: 'Não há veículo cadastrado com esta placa. Para cadastrar do zero, ' +
              'escolha o tipo de pesquisa "Veículo".',
  },
  carreta: {
    campo: 'renovacao_placa',
    rotulo: 'Placa da carreta',
    tipo: 'placa',
    placeholder: 'XYZ4321',
    dica: 'O cadastro é procurado por esta placa.',
    naoAchou: 'Não há carreta cadastrada com esta placa. Para cadastrar do zero, ' +
              'escolha o tipo de pesquisa "Carreta".',
  },
};

/**
 * Resolve a modalidade escolhida.
 *
 * @returns { ok, tipo, alvo, escopos, renovacao, identificacao } ou { ok:false, erro }
 */
function resolver(tipoId, alvoId) {
  const tipo = acharTipoPesquisa(tipoId || TIPO_PADRAO);
  if (!tipo) return { ok: false, erro: 'Tipo de pesquisa inválido.' };

  if (!tipo.renovacao) {
    return {
      ok: true,
      tipo: tipo.id,
      alvo: null,
      escopos: tipo.escopos,
      renovacao: false,
      identificacao: null,
    };
  }

  const alvo = String(alvoId || '').trim().toLowerCase();
  if (!tipo.alvos.includes(alvo)) {
    return { ok: false, erro: 'Escolha o que deseja renovar: motorista, veículo ou carreta.' };
  }

  return {
    ok: true,
    tipo: tipo.id,
    alvo,
    // A renovação mostra os anexos DAQUELE alvo (só os vencidos e os que
    // faltam — ver documentosPendentes em src/cadastros.js), então o escopo do
    // alvo entra aqui para o filtro de anexos. Os CAMPOS continuam só os
    // gerais: o cadastro já existe e não é perguntado de novo.
    escopos: ['solicitacao'],
    escoposDeAnexo: ['solicitacao', 'geral', alvo],
    renovacao: true,
    identificacao: IDENTIFICACAO[alvo],
  };
}

/** Etiqueta curta para o painel: "COMPLETO", "RENOVAÇÃO · VEÍCULO". */
function etiqueta(tipoId, alvoId) {
  const tipo = acharTipoPesquisa(tipoId);
  if (!tipo) return '';
  if (!tipo.renovacao) return tipo.rotulo.toUpperCase();

  const alvo = acharTipoPesquisa(alvoId);
  const nomeDoAlvo = alvo ? alvo.rotulo : String(alvoId || '').toUpperCase();
  return `RENOVAÇÃO · ${String(nomeDoAlvo).toUpperCase()}`;
}

/** O escopo passa neste recorte? */
function escopoCabe(escopo, escopos) {
  return (escopos || []).includes(normalizarEscopo(escopo));
}

module.exports = {
  ESCOPOS,
  ESCOPO_PADRAO,
  escopoValido,
  normalizarEscopo,
  escopoCabe,
  TIPOS_PESQUISA,
  TIPO_PADRAO,
  acharTipoPesquisa,
  IDENTIFICACAO,
  resolver,
  etiqueta,
};
