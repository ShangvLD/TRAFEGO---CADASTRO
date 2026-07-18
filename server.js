/* ============================================================================
   TRÁFEGO — Cadastro | Servidor (Fase 1)

   Responsável por:
     - servir os arquivos estáticos (CSS, imagens, JS do front)
     - autenticação por sessão (login / logout)
     - proteger as páginas por papel (solicitante x responsável)

   Suba com:  npm start   (ou npm run dev para recarregar ao salvar)
   ========================================================================== */

require('dotenv').config();

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('./src/session-store')(session);

require('./src/db'); // inicializa o banco (cria as tabelas na 1ª execução)
const usuarios = require('./src/usuarios');
const solicitacoes = require('./src/solicitacoes');
const { exigirLogin, exigirPapel, paginaInicialPorPapel } = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------------------------------
// Middlewares base
// --------------------------------------------------------------------------
app.use(express.urlencoded({ extended: true })); // formulários HTML
app.use(express.json()); // requisições fetch (login via JS)

app.use(
  session({
    store: new SqliteStore(),
    secret: process.env.SESSION_SECRET || 'segredo-de-desenvolvimento-troque-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, // cookie inacessível a JavaScript do navegador
      sameSite: 'lax',
      secure: false, // troque para true quando servir por HTTPS
      maxAge: 8 * 60 * 60 * 1000, // 8 horas
    },
  })
);

// Arquivos estáticos (CSS, imagens). Ficam públicos de propósito.
app.use(express.static(path.join(__dirname, 'public')));

const VIEWS = path.join(__dirname, 'views');

// --------------------------------------------------------------------------
// Rotas de autenticação
// --------------------------------------------------------------------------

// Página de login. Quem já está logado é mandado direto para sua home.
app.get('/login', (req, res) => {
  if (req.session && req.session.usuario) {
    return res.redirect(paginaInicialPorPapel(req.session.usuario.papel));
  }
  res.sendFile(path.join(VIEWS, 'login.html'));
});

// Processa o login (chamado via fetch pela tela de login).
app.post('/api/login', (req, res) => {
  const email = (req.body.email || '').trim();
  const senha = req.body.senha || '';

  if (!email || !senha) {
    return res.status(400).json({ ok: false, erro: 'Informe e-mail e senha.' });
  }

  const usuario = usuarios.validarCredenciais(email, senha);
  if (!usuario) {
    return res.status(401).json({ ok: false, erro: 'E-mail ou senha inválidos.' });
  }

  // Guarda apenas o essencial na sessão.
  req.session.usuario = {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
  };

  res.json({ ok: true, redirect: paginaInicialPorPapel(usuario.papel) });
});

// Encerra a sessão.
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true, redirect: '/login' });
  });
});

// Dados do usuário logado — o front usa para preencher o cabeçalho.
app.get('/api/eu', exigirLogin, (req, res) => {
  res.json({ ok: true, usuario: req.session.usuario });
});

// --------------------------------------------------------------------------
// Páginas protegidas
// --------------------------------------------------------------------------

// Raiz: manda cada um para sua home (ou para o login).
app.get('/', (req, res) => {
  if (req.session && req.session.usuario) {
    return res.redirect(paginaInicialPorPapel(req.session.usuario.papel));
  }
  res.redirect('/login');
});

// Área do solicitante.
app.get('/solicitante', exigirLogin, exigirPapel('solicitante', 'admin'), (req, res) => {
  res.sendFile(path.join(VIEWS, 'solicitante.html'));
});

// Painel do responsável.
app.get('/responsavel', exigirLogin, exigirPapel('responsavel', 'admin'), (req, res) => {
  res.sendFile(path.join(VIEWS, 'responsavel.html'));
});

// --------------------------------------------------------------------------
// API de solicitações
// --------------------------------------------------------------------------

// Lista para o painel do responsável (com os indicadores).
app.get('/api/solicitacoes', exigirLogin, exigirPapel('responsavel', 'admin'), (req, res) => {
  res.json({
    ok: true,
    resumo: solicitacoes.contarPorStatus(),
    solicitacoes: solicitacoes.listar(),
  });
});

// Solicitações do próprio solicitante logado ("Minhas solicitações").
app.get('/api/minhas-solicitacoes', exigirLogin, (req, res) => {
  res.json({
    ok: true,
    solicitacoes: solicitacoes.listarPorEmail(req.session.usuario.email),
  });
});

// Registra a decisão (aprovar / reprovar) — apenas responsável/admin.
app.post(
  '/api/solicitacoes/:id/decisao',
  exigirLogin,
  exigirPapel('responsavel', 'admin'),
  (req, res) => {
    const id = Number(req.params.id);
    const { status, observacao } = req.body;

    if (!['aprovado', 'reprovado'].includes(status)) {
      return res.status(400).json({ ok: false, erro: 'Status inválido.' });
    }

    const atualizada = solicitacoes.registrarDecisao(id, {
      status,
      observacao,
      revisadoPor: req.session.usuario.nome,
    });

    if (!atualizada) {
      return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
    }

    res.json({ ok: true, solicitacao: atualizada });
  }
);

// --------------------------------------------------------------------------
// Webhook do Microsoft Forms (via Power Automate)
//
// O Power Automate chama esta rota a cada nova resposta do formulário,
// enviando os campos em JSON. É uma rota PÚBLICA (o Power Automate não faz
// login), então é protegida por um segredo compartilhado no cabeçalho
// "x-webhook-secret". Se o segredo não estiver configurado no .env, a rota
// fica desligada — assim ninguém consegue gravar solicitações anonimamente.
//
// Corpo esperado (JSON):
//   {
//     "solicitante_nome":  "Fulano de Tal",        (obrigatório)
//     "solicitante_email": "fulano@jomedlog...",   (obrigatório)
//     "assunto":           "Cadastro de ...",       (obrigatório)
//     "detalhes":          "texto livre",           (opcional)
//     "anexo":             "https://.../arquivo",   (opcional — link na nuvem)
//     "origem_id":         "id-da-resposta-forms"   (opcional, evita duplicar)
//   }
// --------------------------------------------------------------------------
app.post('/api/forms/webhook', (req, res) => {
  const segredoEsperado = process.env.FORMS_WEBHOOK_SECRET;

  if (!segredoEsperado) {
    return res
      .status(503)
      .json({ ok: false, erro: 'Webhook não configurado (defina FORMS_WEBHOOK_SECRET no .env).' });
  }

  if (req.get('x-webhook-secret') !== segredoEsperado) {
    return res.status(401).json({ ok: false, erro: 'Segredo inválido.' });
  }

  const b = req.body || {};
  const solicitante_nome = String(b.solicitante_nome || '').trim();
  const solicitante_email = String(b.solicitante_email || '').trim();
  const assunto = String(b.assunto || '').trim();

  if (!solicitante_nome || !solicitante_email || !assunto) {
    return res.status(400).json({
      ok: false,
      erro: 'Campos obrigatórios ausentes: solicitante_nome, solicitante_email e assunto.',
    });
  }

  const { solicitacao, duplicada } = solicitacoes.registrarDoForms({
    solicitante_nome,
    solicitante_email,
    assunto,
    detalhes: b.detalhes,
    anexo: b.anexo, // link único, texto, ou o JSON do campo de upload do Forms
    anexos: b.anexos, // (opcional) lista já estruturada [{ nome, url }]
    origem_id: b.origem_id,
  });

  // 200 mesmo quando duplicada: o Power Automate considera sucesso e não reenvia.
  res.json({ ok: true, duplicada, id: solicitacao.id });
});

// --------------------------------------------------------------------------
// Sobe o servidor
// --------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n  TRÁFEGO — Cadastro rodando em  http://localhost:${PORT}\n`);
});
