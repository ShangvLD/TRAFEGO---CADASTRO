/* ============================================================================
   Camada de acesso aos usuários

   Concentra todas as consultas relacionadas a login/usuário. As rotas do
   servidor chamam estas funções em vez de escrever SQL diretamente.
   ========================================================================== */

const bcrypt = require('bcryptjs');
const db = require('./db');

const CUSTO_HASH = 10; // fator de custo do bcrypt (equilíbrio segurança/velocidade)

/** Busca um usuário ativo pelo e-mail. Retorna undefined se não existir. */
async function buscarPorEmail(email) {
  return db
    .prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1')
    .get(email);
}

/** Busca um usuário pelo id. */
async function buscarPorId(id) {
  return db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id);
}

/**
 * Cria um novo usuário com a senha já criptografada.
 * Lança erro se o e-mail já existir (restrição UNIQUE do banco).
 */
async function criar({ nome, email, senha, papel }) {
  const senhaHash = bcrypt.hashSync(senha, CUSTO_HASH);
  const info = await db
    .prepare(
      `INSERT INTO usuarios (nome, email, senha_hash, papel)
       VALUES (?, ?, ?, ?)`
    )
    .run(nome, email, senhaHash, papel);
  return buscarPorId(info.lastInsertRowid);
}

/**
 * Valida e-mail + senha. Retorna o usuário (sem o hash) se as credenciais
 * baterem, ou null caso contrário.
 */
async function validarCredenciais(email, senha) {
  const usuario = await buscarPorEmail(email);
  if (!usuario) return null;

  const senhaConfere = bcrypt.compareSync(senha, usuario.senha_hash);
  if (!senhaConfere) return null;

  // Nunca devolvemos o hash da senha para fora desta camada.
  const { senha_hash, ...seguro } = usuario;
  return seguro;
}

/** Lista todos os usuários (uso administrativo). */
async function listar() {
  return db
    .prepare('SELECT id, nome, email, papel, ativo, criado_em FROM usuarios ORDER BY nome')
    .all();
}

module.exports = {
  buscarPorEmail,
  buscarPorId,
  criar,
  validarCredenciais,
  listar,
};
