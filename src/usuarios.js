/* ============================================================================
   Camada de acesso aos usuários

   Concentra todas as consultas relacionadas a login/usuário. As rotas do
   servidor chamam estas funções em vez de escrever SQL diretamente.
   ========================================================================== */

const bcrypt = require('bcryptjs');
const db = require('./db');
const papeis = require('./papeis');
const { validarEmail, validarNome, limparTexto } = require('./validacao');

const CUSTO_HASH = 10; // fator de custo do bcrypt (equilíbrio segurança/velocidade)
const SENHA_MINIMA = 8;

/**
 * Busca um usuário ativo pelo e-mail. Retorna undefined se não existir.
 * A comparação ignora maiúsculas/minúsculas (lower nos dois lados, casando com
 * o índice único idx_usuarios_email_lower).
 */
async function buscarPorEmail(email) {
  return db
    .prepare('SELECT * FROM usuarios WHERE lower(email) = lower(?) AND ativo = 1')
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
       VALUES (?, ?, ?, ?)
       RETURNING id`
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

// ---------------------------------------------------------------------------
// Administração de usuários (tela /admin/usuarios)
//
// Todas as funções abaixo devolvem { ok, ... } em vez de lançar exceção, para a
// tela poder mostrar a mensagem exata do problema.
// ---------------------------------------------------------------------------

/**
 * Quantos administradores ATIVOS existem, ignorando um id opcional.
 *
 * O COALESCE com -1 evita `? IS NULL`: em `$1 IS NULL` o PostgreSQL não tem
 * como inferir o tipo do parâmetro e recusa a consulta. Com COALESCE(?, -1) ele
 * infere inteiro pelo -1, e nenhum id real é -1, então passar null equivale a
 * não ignorar ninguém.
 */
async function contarAdminsAtivos(ignorarId = null) {
  const r = await db
    .prepare(
      `SELECT count(*)::int AS n FROM usuarios
        WHERE papel = 'admin' AND ativo = 1 AND id <> COALESCE(?, -1)`
    )
    .get(ignorarId == null ? null : Number(ignorarId));
  return r ? r.n : 0;
}

/**
 * Valida os dados de um usuário novo e o cria.
 * Devolve { ok:true, usuario } ou { ok:false, erros:{campo:msg} }.
 */
async function criarValidado({ nome, email, senha, papel }) {
  const erros = {};

  const rNome = validarNome(nome, { rotulo: 'O nome' });
  if (!rNome.ok) erros.nome = rNome.erro;

  const rEmail = validarEmail(email);
  if (!rEmail.ok) erros.email = rEmail.erro;

  const s = String(senha == null ? '' : senha);
  if (s.length < SENHA_MINIMA) {
    erros.senha = `A senha deve ter pelo menos ${SENHA_MINIMA} caracteres.`;
  }

  const p = limparTexto(papel).toLowerCase();
  if (!papeis.NOMES_PAPEIS.includes(p)) {
    erros.papel = 'Selecione um papel válido.';
  }

  if (Object.keys(erros).length) return { ok: false, erros };

  // O índice único é em lower(email), então a checagem também precisa ser.
  const existente = await db
    .prepare('SELECT id FROM usuarios WHERE lower(email) = lower(?)')
    .get(rEmail.valor);
  if (existente) {
    return { ok: false, erros: { email: 'Já existe um usuário com este e-mail.' } };
  }

  const criado = await criar({ nome: rNome.valor, email: rEmail.valor, senha: s, papel: p });
  return { ok: true, usuario: semSenha(criado) };
}

/** Remove o hash antes de devolver o usuário para fora. */
function semSenha(u) {
  if (!u) return u;
  const { senha_hash, ...seguro } = u;
  return seguro;
}

/**
 * Ativa/desativa um usuário.
 *
 * Duas travas, para o sistema não ficar sem quem o administre:
 *   · ninguém desativa a própria conta;
 *   · não é possível desativar o ÚLTIMO administrador ativo.
 */
async function definirAtivo(id, ativo, { idDoSolicitante } = {}) {
  const alvo = await buscarPorId(id);
  if (!alvo) return { ok: false, erro: 'Usuário não encontrado.' };

  if (!ativo) {
    if (Number(id) === Number(idDoSolicitante)) {
      return { ok: false, erro: 'Você não pode desativar a sua própria conta.' };
    }
    if (alvo.papel === 'admin' && (await contarAdminsAtivos(id)) === 0) {
      return { ok: false, erro: 'Este é o último administrador ativo — não pode ser desativado.' };
    }
  }

  await db.prepare('UPDATE usuarios SET ativo = ? WHERE id = ?').run(ativo ? 1 : 0, id);
  return { ok: true };
}

/**
 * Troca o papel de um usuário.
 * Mesma trava: não deixa o sistema sem administrador ativo, e ninguém rebaixa
 * a própria conta (evita perder o acesso sem perceber).
 */
async function definirPapel(id, papel, { idDoSolicitante } = {}) {
  const p = limparTexto(papel).toLowerCase();
  if (!papeis.NOMES_PAPEIS.includes(p)) {
    return { ok: false, erro: 'Papel inválido.' };
  }

  const alvo = await buscarPorId(id);
  if (!alvo) return { ok: false, erro: 'Usuário não encontrado.' };
  if (alvo.papel === p) return { ok: true, semMudanca: true };

  if (alvo.papel === 'admin' && p !== 'admin') {
    if (Number(id) === Number(idDoSolicitante)) {
      return { ok: false, erro: 'Você não pode remover o seu próprio acesso de administrador.' };
    }
    if ((await contarAdminsAtivos(id)) === 0) {
      return { ok: false, erro: 'Este é o último administrador ativo — o papel não pode ser trocado.' };
    }
  }

  await db.prepare('UPDATE usuarios SET papel = ? WHERE id = ?').run(p, id);
  return { ok: true };
}

/** Define uma senha nova (uso administrativo: a pessoa esqueceu a dela). */
async function trocarSenha(id, senha) {
  const s = String(senha == null ? '' : senha);
  if (s.length < SENHA_MINIMA) {
    return { ok: false, erro: `A senha deve ter pelo menos ${SENHA_MINIMA} caracteres.` };
  }
  const alvo = await buscarPorId(id);
  if (!alvo) return { ok: false, erro: 'Usuário não encontrado.' };

  await db
    .prepare('UPDATE usuarios SET senha_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(s, CUSTO_HASH), id);
  return { ok: true };
}

/** Lista para a tela de administração, com o rótulo do papel já resolvido. */
async function listarParaAdmin() {
  const linhas = await db
    .prepare(
      `SELECT id, nome, email, papel, ativo, criado_em
         FROM usuarios ORDER BY ativo DESC, nome`
    )
    .all();

  return linhas.map((u) => ({
    ...u,
    ativo: u.ativo === 1,
    papelRotulo: papeis.rotuloDoPapel(u.papel),
    formularios: papeis.formulariosDoPapel(u.papel),
    paineis: papeis.paineisDoPapel(u.papel),
  }));
}

module.exports = {
  buscarPorEmail,
  buscarPorId,
  criar,
  validarCredenciais,
  listar,
  // administração
  SENHA_MINIMA,
  criarValidado,
  definirAtivo,
  definirPapel,
  trocarSenha,
  listarParaAdmin,
  contarAdminsAtivos,
};
