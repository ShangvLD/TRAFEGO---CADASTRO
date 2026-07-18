/* ============================================================================
   Criar usuário via linha de comando (uso administrativo).

   É assim que VOCÊ controla os logins enquanto não há uma tela de admin.

   Uso:
     npm run criar-usuario -- "Nome Completo" email@jomedlog.com.br senha papel

   Onde "papel" é:  solicitante | responsavel | admin

   Exemplo:
     npm run criar-usuario -- "João Silva" joao@jomedlog.com.br Senha@123 solicitante
   ========================================================================== */

const usuarios = require('./usuarios');

const PAPEIS_VALIDOS = ['solicitante', 'responsavel', 'admin'];

// process.argv[0]=node, [1]=script, os argumentos reais começam no índice 2.
const [nome, email, senha, papel] = process.argv.slice(2);

if (!nome || !email || !senha || !papel) {
  console.error('Faltam argumentos.\n');
  console.error('Uso: npm run criar-usuario -- "Nome" email senha papel');
  console.error(`Papel deve ser um de: ${PAPEIS_VALIDOS.join(', ')}`);
  process.exit(1);
}

if (!PAPEIS_VALIDOS.includes(papel)) {
  console.error(`Papel inválido: "${papel}".`);
  console.error(`Use um de: ${PAPEIS_VALIDOS.join(', ')}`);
  process.exit(1);
}

if (senha.length < 6) {
  console.error('A senha deve ter pelo menos 6 caracteres.');
  process.exit(1);
}

try {
  const novo = usuarios.criar({ nome, email, senha, papel });
  console.log(`✓ Usuário criado: ${novo.email} (${novo.papel})`);
} catch (erro) {
  if (String(erro.message).includes('UNIQUE')) {
    console.error(`Já existe um usuário com o e-mail "${email}".`);
  } else {
    console.error('Erro ao criar usuário:', erro.message);
  }
  process.exit(1);
}
