/* ============================================================================
   Teste local do webhook do Microsoft Forms.

   Como a nuvem do Power Automate NÃO alcança o "localhost" durante o
   desenvolvimento, este script simula o que o Power Automate envia: um POST
   com o segredo no cabeçalho e uma resposta de exemplo no corpo.

   Use para validar toda a esteira (webhook -> banco -> painel) sem depender
   de estar hospedado.

   Rode com o servidor no ar (npm start), em outro terminal:

     npm run testar-webhook

   Passe valores próprios via variáveis de ambiente, se quiser:

     NOME="Maria" EMAIL="maria@jomedlog.com.br" ASSUNTO="Teste" npm run testar-webhook
   ========================================================================== */

require('dotenv').config();

const PORT = process.env.PORT || 3000;
const segredo = process.env.FORMS_WEBHOOK_SECRET;

if (!segredo) {
  console.error(
    '\n  ✗ FORMS_WEBHOOK_SECRET não está definido no .env.\n' +
      '    Defina-o (copie de .env.example) antes de testar o webhook.\n'
  );
  process.exit(1);
}

// Um origem_id fixo por execução deixa fácil testar a anti-duplicidade:
// rode duas vezes com o mesmo valor e a 2ª deve responder "duplicada: true".
const corpo = {
  solicitante_nome: process.env.NOME || 'Teste Webhook',
  solicitante_email: process.env.EMAIL || 'solicitante@jomedlog.com.br',
  assunto: process.env.ASSUNTO || 'Cadastro de teste via webhook',
  detalhes: process.env.DETALHES || 'Resposta simulada para validar a integração.',
  anexo: process.env.ANEXO || 'https://exemplo.sharepoint.com/arquivo-de-teste.pdf',
  origem_id: process.env.ORIGEM_ID || 'teste-local-001',
};

const url = `http://localhost:${PORT}/api/forms/webhook`;

(async () => {
  console.log(`\n  → POST ${url}`);
  console.log('  → corpo:', JSON.stringify(corpo, null, 2), '\n');

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': segredo,
      },
      body: JSON.stringify(corpo),
    });

    const dados = await resp.json().catch(() => ({}));
    console.log(`  ← HTTP ${resp.status}`);
    console.log('  ←', JSON.stringify(dados), '\n');

    if (resp.ok && dados.ok) {
      console.log(
        dados.duplicada
          ? '  ✓ Já existia (anti-duplicidade funcionando). Nada foi gravado de novo.\n'
          : `  ✓ Solicitação registrada com id ${dados.id}. Confira no painel do responsável.\n`
      );
    } else {
      console.log('  ✗ O webhook recusou a requisição (veja a resposta acima).\n');
      process.exit(1);
    }
  } catch (e) {
    console.error(
      `\n  ✗ Não consegui falar com o servidor em ${url}.\n` +
        '    O servidor está no ar? Rode "npm start" em outro terminal.\n' +
        `    Detalhe: ${e.message}\n`
    );
    process.exit(1);
  }
})();
