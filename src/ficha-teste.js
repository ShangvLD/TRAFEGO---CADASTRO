/* ============================================================================
   A ficha do teste prático: critérios, conceitos, resultados e pontuação

   Arquivo separado de src/teste-pratico.js por UM motivo concreto: o db.js
   precisa da lista de critérios para gerar a visão de leitura no Supabase (uma
   coluna por critério), e teste-pratico.js já importa o db. Um require do db
   para lá fecharia ciclo. Aqui não fecha, porque este arquivo NÃO IMPORTA NADA
   — é a mesma razão pela qual src/pesquisas.js e src/tipos-campo.js existem
   soltos e o db lê deles.

   É ele a fonte única da ficha: o formulário, a validação que cobra o
   preenchimento, a pontuação e as colunas da visão saem todos daqui. Mudar um
   critério é mexer em um lugar.

   ONDE MEXER PARA AJUSTAR A AVALIAÇÃO:

     PERGUNTAS   a lista SECOES. Acrescentar, tirar ou renomear um critério é
                 editar essa lista — o formulário, a validação e a pontuação
                 acompanham. A coluna correspondente na visão é recriada no
                 próximo boot (a visão é derrubada e refeita toda vez).

                 CUIDADO com o "id": ele é o que está gravado nas fichas já
                 preenchidas. Renomear o RÓTULO é livre e não perde nada;
                 trocar o ID faz a resposta antiga virar órfã e sair da conta.

     PESO        o campo "pontos" de cada conceito, abaixo.
   ========================================================================== */

/**
 * Os quatro conceitos, e quanto cada um vale de 0 a 10.
 *
 * A nota do teste é a MÉDIA dos pontos dos critérios respondidos — por isso os
 * pontos já estão na escala final: não existe uma segunda conversão escondida
 * em algum lugar, e o valor que o avaliador escolhe é o valor que entra na
 * conta.
 *
 * Insatisfatório vale 0, e não 2,5, para a escala usar os dois extremos: tudo
 * insatisfatório dá 0,0 e tudo excelente dá 10,0. Com um piso acima de zero, a
 * pior avaliação possível ainda pareceria nota de aprovação.
 *
 * ESTES NÚMEROS SÃO O AJUSTE. Se "Regular" devesse valer mais (ou menos) no
 * peso da nota, é aqui que se muda — em um lugar só, sem tocar no formulário
 * nem na validação.
 */
const CONCEITOS = [
  { id: 'excelente', rotulo: 'Excelente', pontos: 10, cor: 'is-success' },
  { id: 'bom', rotulo: 'Bom', pontos: 7, cor: 'is-info' },
  { id: 'regular', rotulo: 'Regular', pontos: 4, cor: 'is-warning' },
  { id: 'insatisfatorio', rotulo: 'Insatisfatório', pontos: 0, cor: 'is-danger' },
];

/** A escala da nota. Existe como constante porque a tela também a exibe. */
const NOTA_MAXIMA = 10;

const SECOES = [
  {
    id: 'direcao',
    titulo: 'Avaliação de direção',
    icone: 'directions_car',
    criterios: [
      { id: 'conducao_veiculo', rotulo: 'Condução do veículo' },
      { id: 'controle_veiculo', rotulo: 'Controle do veículo' },
      { id: 'regras_transito', rotulo: 'Respeito às regras de trânsito' },
      { id: 'conducao_defensiva', rotulo: 'Condução defensiva' },
    ],
  },
  {
    id: 'manobra',
    titulo: 'Avaliação de manobra',
    icone: 'sync_alt',
    criterios: [
      { id: 'controle_manobras', rotulo: 'Controle em manobras' },
      { id: 'baliza_re', rotulo: 'Baliza / manobra de ré' },
      { id: 'percepcao_espaco', rotulo: 'Percepção de espaço' },
      { id: 'controle_durante_manobras', rotulo: 'Controle do veículo durante manobras' },
    ],
  },
];

/**
 * Os três resultados possíveis.
 *
 * O resultado é ESCOLHIDO pelo avaliador, e não deduzido da nota. Quem aplica
 * o teste viu coisas que os oito critérios não perguntam — e uma reprovação
 * automática por média faria o sistema decidir a contratação no lugar dele.
 * A nota informa a decisão; não a substitui.
 *
 * "Aprovado com ressalvas" e "Reprovado" exigem justificativa porque são os
 * dois que alguém vai questionar depois, e "não lembro por quê" é o que faz o
 * registro não valer nada.
 */
const RESULTADOS = [
  { id: 'aprovado', rotulo: 'Aprovado', cor: 'is-success', icone: 'check_circle', exigeJustificativa: false },
  {
    id: 'aprovado_ressalvas',
    rotulo: 'Aprovado com ressalvas',
    cor: 'is-parcial',
    icone: 'error',
    exigeJustificativa: true,
  },
  { id: 'reprovado', rotulo: 'Reprovado', cor: 'is-danger', icone: 'cancel', exigeJustificativa: true },
];

/** Todos os critérios, achatados, na ordem em que aparecem na ficha. */
const TODOS_CRITERIOS = SECOES.flatMap((s) =>
  s.criterios.map((c) => ({ ...c, secao: s.id, secaoTitulo: s.titulo }))
);

const acharConceito = (id) => CONCEITOS.find((c) => c.id === id) || null;
const acharResultado = (id) => RESULTADOS.find((r) => r.id === id) || null;
const acharCriterio = (id) => TODOS_CRITERIOS.find((c) => c.id === id) || null;

/** A ficha inteira, para a tela se desenhar sem repetir a lista de critérios. */
function configuracao() {
  return { conceitos: CONCEITOS, secoes: SECOES, resultados: RESULTADOS, notaMaxima: NOTA_MAXIMA };
}

/**
 * A nota do teste, de 0 a 10.
 *
 * Critério ainda em branco fica FORA da média, em vez de valer zero: um
 * rascunho pela metade mostraria uma nota péssima que ninguém deu. Por isso a
 * resposta traz também "respondidos" e "parcial" — uma nota tirada de três dos
 * oito critérios é um número honesto sobre três critérios, e a tela precisa
 * poder dizer isso em vez de anunciar 6,7 como se fosse o teste inteiro.
 *
 * Nenhum critério respondido devolve null, e não zero: "não avaliado" e "foi
 * avaliado e tirou zero" são coisas opostas.
 */
function pontuacaoDe(avaliacoes) {
  const pontos = Object.entries(avaliacoes || {})
    .filter(([id]) => acharCriterio(id))
    .map(([, valor]) => acharConceito(valor))
    .filter(Boolean)
    .map((c) => c.pontos);

  if (!pontos.length) return null;

  const media = pontos.reduce((a, b) => a + b, 0) / pontos.length;
  const nota = Math.round(media * 10) / 10;

  return {
    nota,
    maximo: NOTA_MAXIMA,
    respondidos: pontos.length,
    total: TODOS_CRITERIOS.length,
    parcial: pontos.length < TODOS_CRITERIOS.length,
    // Vírgula, e não ponto: é a nota como quem lê a escreve.
    texto: nota.toFixed(1).replace('.', ',') + ' de ' + NOTA_MAXIMA,
  };
}

module.exports = {
  CONCEITOS,
  SECOES,
  RESULTADOS,
  TODOS_CRITERIOS,
  NOTA_MAXIMA,
  acharConceito,
  acharResultado,
  acharCriterio,
  configuracao,
  pontuacaoDe,
};
