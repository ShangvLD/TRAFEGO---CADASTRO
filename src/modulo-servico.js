/* ============================================================================
   Resolve a camada de dados de cada módulo

   Ponto único que liga slug -> funções de acesso ao banco:

     · terceiro  -> src/solicitacoes.js  (implementação específica, em produção:
                    operações por cliente, decisão individual, anexos do Forms)
     · os demais -> src/modulo-dados.js  (fábrica genérica, uma por tabela)

   As rotas genéricas do server.js chamam sempre `dadosDe(slug)` e não sabem
   qual das duas está por trás — as duas expõem listar/buscarPorId/
   contarPorStatus/versao/registrarDecisao/excluir com a mesma assinatura.

   As camadas são criadas uma vez, no carregamento do módulo, e reaproveitadas.
   ========================================================================== */

const { MODULOS } = require('./modulos');
const { criarCamada } = require('./modulo-dados');
const solicitacoes = require('./solicitacoes');

const camadas = new Map();

for (const m of MODULOS) {
  camadas.set(m.slug, m.slug === 'terceiro' ? solicitacoes : criarCamada(m.tabela, m.slug));
}

/** Camada de dados do módulo. null se o slug não existir. */
function dadosDe(slug) {
  return camadas.get(String(slug || '').toLowerCase()) || null;
}

module.exports = { dadosDe };
