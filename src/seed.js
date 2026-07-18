/* ============================================================================
   Seed — cria usuários de teste para a Fase 1.

   Rode uma única vez com:  npm run seed

   É seguro rodar de novo: usuários que já existem são apenas pulados.
   Em produção, troque estas senhas e use o script "criar-usuario".
   ========================================================================== */

const usuarios = require('./usuarios');
const solicitacoes = require('./solicitacoes');

const usuariosDeTeste = [
  {
    nome: 'Solicitante Teste',
    email: 'solicitante@jomedlog.com.br',
    senha: 'solicitante123',
    papel: 'solicitante',
  },
  {
    nome: 'Responsável Teste',
    email: 'responsavel@jomedlog.com.br',
    senha: 'responsavel123',
    papel: 'responsavel',
  },
  {
    nome: 'Administrador',
    email: 'admin@jomedlog.com.br',
    senha: 'admin123',
    papel: 'admin',
  },
];

console.log('Criando usuários de teste...\n');

for (const u of usuariosDeTeste) {
  const existente = usuarios.buscarPorEmail(u.email);
  if (existente) {
    console.log(`  • já existe:  ${u.email} (${existente.papel})`);
    continue;
  }
  usuarios.criar(u);
  console.log(`  ✓ criado:     ${u.email} (${u.papel})  senha: ${u.senha}`);
}

// --------------------------------------------------------------------------
// Solicitações de exemplo (só insere se a tabela estiver vazia).
// Simulam o que virá do Microsoft Forms na Fase 4.
// --------------------------------------------------------------------------
const solicitacoesDeExemplo = [
  {
    solicitante_nome: 'Solicitante Teste',
    solicitante_email: 'solicitante@jomedlog.com.br',
    assunto: 'Cadastro de transportadora — Rodoviário Sul Ltda',
    detalhes: 'CNPJ 12.345.678/0001-90. Solicita inclusão para rotas do Sul.',
    anexo: 'contrato-social.pdf',
  },
  {
    solicitante_nome: 'Solicitante Teste',
    solicitante_email: 'solicitante@jomedlog.com.br',
    assunto: 'Cadastro de motorista — João Pereira',
    detalhes: 'CNH categoria E, validade 2028. MOPP em dia.',
    anexo: 'cnh-joao.jpg',
  },
  {
    solicitante_nome: 'Maria Souza',
    solicitante_email: 'maria.souza@jomedlog.com.br',
    assunto: 'Cadastro de veículo — Placa ABC1D23',
    detalhes: 'Carreta baú, 2021. Documento de propriedade anexado.',
    anexo: 'crlv-abc1d23.pdf',
  },
];

console.log('\nCriando solicitações de exemplo...\n');

if (solicitacoes.listar().length > 0) {
  console.log('  • já existem solicitações — nada a inserir.');
} else {
  for (const s of solicitacoesDeExemplo) {
    solicitacoes.criar(s);
    console.log(`  ✓ criada:     "${s.assunto}"`);
  }
}

console.log('\nPronto. Lembre de trocar as senhas antes de ir para produção.');
