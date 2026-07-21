/* ============================================================================
   Entrada serverless do Vercel.

   O Vercel executa cada função a partir da pasta /api. Aqui apenas importamos
   o app Express definido em server.js — que NÃO chama app.listen quando é
   importado (só quando rodado direto, no desenvolvimento local). O Vercel
   passa cada requisição HTTP para este app.
   ========================================================================== */

module.exports = require('../server.js');
