/* ============================================================================
   Código canônico dos tipos de documento

   O PROBLEMA QUE ISTO RESOLVE: o mesmo documento tinha três códigos, um por
   módulo, porque cada lista de documentosIniciais foi escrita numa semana
   diferente (ver src/modulos.js e src/validacao.js):

     Direção Segura       CERT_DIRECAO_SEGURA  |  CURSO_DIRECAO_SEGURA
                          |  CERTIFICADO_DE_DIRECAO_SEGURA
     Acidente em rodovia  CERTIFICADO_DE_COMO_EVITAR_ACIDENTE_NAS_RODOVIAS
                          |  CURSO_ACIDENTE_RODOVIA

   Enquanto cada módulo só olhava a própria lista isso não incomodava. Passa a
   incomodar na primeira pergunta que cruza módulos — "este motorista já
   entregou o curso de direção segura?" — que com três códigos responde "não"
   três vezes. E na renovação, que procura o documento já enviado: procura
   pelo código do módulo atual e não acha o que veio do outro.

   E o RESULTADO RDO, que era o caso mais fora do padrão: definido como
   constante em src/fluxo.js, COM ESPAÇO, sem linha em cfg_documentos, e
   comparado com .toUpperCase() em oito lugares. Era o único documento nativo
   do sistema e o único sem convenção nenhuma.

   A CONVENÇÃO, e só ela:

     MAIÚSCULAS, sem acento, palavras separadas por "_"
     CNH  COMPROVANTE_RESIDENCIA  CRLV_CAVALO  RESULTADO_RDO

   Maiúscula e não minúscula porque é o que as 12 linhas em produção e as 20
   de cfg_documentos já usam; mudar para minúsculo seria trocar de bagunça.
   ========================================================================== */

/**
 * Põe um código na forma canônica.
 *
 * Aceita o que vier — "RESULTADO RDO", "cnh", "Crlv-Cavalo" — e devolve
 * sempre a mesma coisa. É o que permite a comparação parar de depender de
 * quem digitou o valor.
 */
function normalizarCodigo(texto) {
  return String(texto == null ? '' : texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira acento
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Códigos antigos -> código canônico.
 *
 * Cada linha aqui é um código que EXISTE no banco hoje. A tabela não é uma
 * lista de sinônimos imaginários: é o inventário do que precisa ser traduzido
 * enquanto a migração não roda, e a prova de que rodou depois.
 */
const ALIASES = {
  // O espaço era o problema; o resto do nome estava certo.
  RESULTADO_RDO: 'RESULTADO_RDO',

  CERT_DIRECAO_SEGURA: 'CERT_DIRECAO_SEGURA',
  CURSO_DIRECAO_SEGURA: 'CERT_DIRECAO_SEGURA',
  CERTIFICADO_DE_DIRECAO_SEGURA: 'CERT_DIRECAO_SEGURA',
  CERTIFICADO_DIRECAO_SEGURA: 'CERT_DIRECAO_SEGURA',

  CERT_ACIDENTE_RODOVIA: 'CERT_ACIDENTE_RODOVIA',
  CURSO_ACIDENTE_RODOVIA: 'CERT_ACIDENTE_RODOVIA',
  CERTIFICADO_DE_COMO_EVITAR_ACIDENTE_NAS_RODOVIAS: 'CERT_ACIDENTE_RODOVIA',
};

/** Código canônico de um tipo, seja qual for a forma em que ele chegou. */
function canonico(texto) {
  const c = normalizarCodigo(texto);
  return ALIASES[c] || c;
}

/** Dois tipos são o mesmo documento? Compara pelo canônico, nunca por string. */
function mesmoTipo(a, b) {
  return !!a && !!b && canonico(a) === canonico(b);
}

/**
 * Tipo do resultado da pesquisa RDO.
 *
 * Mora AQUI e não em fluxo.js porque é um tipo de documento como os outros —
 * fluxo.js cuida de etapas e decisões. O DOC_RDO de lá reexporta este valor,
 * para não haver duas verdades.
 */
const RESULTADO_RDO = 'RESULTADO_RDO';

/** Este documento é o resultado do RDO? Reconhece a forma antiga, com espaço. */
function ehResultadoRdo(tipo) {
  return canonico(tipo) === RESULTADO_RDO;
}

module.exports = {
  normalizarCodigo,
  canonico,
  mesmoTipo,
  ALIASES,
  RESULTADO_RDO,
  ehResultadoRdo,
};
