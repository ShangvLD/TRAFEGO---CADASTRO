/* ============================================================================
   TRÁFEGO — Cadastro | Servidor

   Responsável por:
     - servir os arquivos estáticos (CSS, imagens, JS do front)
     - autenticação por sessão (login / logout)
     - proteger as páginas por papel (solicitante x responsável)
     - receber respostas do Microsoft Forms (webhook via Power Automate)

   Roda de duas formas:
     - LOCAL (npm start / npm run dev): sobe um servidor HTTP normal.
     - VERCEL (serverless): o arquivo api/index.js importa este "app" e o
       Vercel o executa a cada requisição. Por isso NÃO chamamos app.listen()
       quando somos importados — só quando o arquivo é executado direto.
   ========================================================================== */

require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const SessaoStore = require('./src/session-store')(session);

const usuarios = require('./src/usuarios');
const solicitacoes = require('./src/solicitacoes');
const cadastros = require('./src/cadastros');
const configFormulario = require('./src/config-formulario');
const pesquisas = require('./src/pesquisas');
const { MODULOS, acharModulo, rotaFormulario, rotaPainel } = require('./src/modulos');
const papeis = require('./src/papeis');
const { dadosDe } = require('./src/modulo-servico');
const { menuPara, menuDaConta } = require('./src/menu');
const campos = require('./src/campos');
const documentos = require('./src/documentos');
const atendimentos = require('./src/atendimentos');
const limiteLogin = require('./src/limite-login');
const fluxo = require('./src/fluxo');
const testePratico = require('./src/teste-pratico');
const {
  exigirLogin,
  exigirAdmin,
  exigirFormulario,
  exigirPainel,
  paginaInicialPorPapel,
} = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const EM_PRODUCAO = process.env.NODE_ENV === 'production';

// Em produção (Vercel) o app fica atrás de um proxy HTTPS. Sem isto, o cookie
// "secure" não é enviado e a sessão nunca gruda.
if (EM_PRODUCAO) app.set('trust proxy', 1);

// Pequeno auxiliar: deixa handlers assíncronos encaminharem erros ao Express.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Compara dois segredos sem deixar o TEMPO da comparação contar quantos
 * caracteres bateram (usado pelo webhook do Forms).
 *
 * Os dois lados são reduzidos a um hash de tamanho fixo antes da comparação
 * porque timingSafeEqual exige buffers do mesmo comprimento — e o comprimento
 * do que chegou é justamente uma das coisas que não devem vazar.
 */
function segredoConfere(recebido, esperado) {
  if (typeof recebido !== 'string' || !recebido) return false;
  const digerir = (v) => crypto.createHash('sha256').update(String(v), 'utf8').digest();
  return crypto.timingSafeEqual(digerir(recebido), digerir(esperado));
}

/**
 * Quem pode CONFIGURAR formulário: admin, ou quem acompanha algum painel.
 *
 * Quem trata o cadastro no dia a dia é quem descobre que falta uma pergunta —
 * exigir admin para isso transforma um ajuste de cinco segundos num pedido que
 * espera. Incluir e editar, então, é de quem opera.
 *
 * EXCLUIR não: apagar pergunta joga fora as respostas já dadas nela, e isso não
 * volta. Fica com o admin (ver exigirAdmin nas rotas DELETE).
 */
function exigirConfigurarFormulario(req, res, next) {
  const u = req.session && req.session.usuario;
  if (!u) return res.status(401).json({ ok: false, erro: 'Não autenticado.' });
  if (papeis.ehAdmin(u.papel) || papeis.paineisDoPapel(u.papel).length) return next();
  return res.status(403).json({ ok: false, erro: 'Sem permissão para configurar formulários.' });
}

/**
 * Quem pode usar a Blacklist Geomed: admin, ou quem acompanha algum painel.
 *
 * Mesmo critério dos Relatórios, que dividem o menu da conta com ela, e pelo
 * mesmo motivo: é trabalho de quem ANALISA cadastro. O responsável pela
 * contratação recebe o aviso da diretoria e registra na hora — passar por um
 * admin transformaria um bloqueio urgente num pedido na fila.
 */
function exigirBlacklist(req, res, next) {
  const u = req.session && req.session.usuario;
  if (!u) return res.status(401).json({ ok: false, erro: 'Não autenticado.' });
  if (papeis.ehAdmin(u.papel) || papeis.paineisDoPapel(u.papel).length) return next();
  return res.status(403).json({ ok: false, erro: 'Sem permissão para ver a Blacklist Geomed.' });
}

/**
 * Freio da consulta por CPF/placa (ver /api/cadastros/existente).
 *
 * Conta por USUÁRIO, no banco, e não por sessão: sair e entrar de novo não
 * zera o contador. 200 consultas em 15 minutos é muito mais do que preencher
 * um formulário exige e muito menos do que varrer uma lista de CPFs rende.
 */
const limitarConsultaDeCadastro = wrap(async (req, res, next) => {
  const chaves = limiteLogin.chaveDe('consulta:cadastro', req.session.usuario.id, 200);

  const freio = await limiteLogin.verificar(chaves);
  if (freio.bloqueado) {
    const minutos = Math.max(1, Math.ceil(freio.segundos / 60));
    res.set('Retry-After', String(freio.segundos));
    return res.status(429).json({
      ok: false,
      erro: `Muitas consultas em pouco tempo. Tente de novo em ${minutos} minuto(s).`,
    });
  }

  await limiteLogin.contar(chaves);
  return next();
});

// --------------------------------------------------------------------------
// Middlewares base
// --------------------------------------------------------------------------
// Guarda o corpo cru (para diagnóstico do webhook).
function capturarRaw(req, res, buf) {
  req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
}


// --------------------------------------------------------------------------
// Cabeçalhos de segurança
//
// Vêm ANTES do estático para valerem também para CSS, imagem e JS do front.
//
// O que cada um resolve:
//
//   Content-Security-Policy  diz de onde a página pode carregar coisa. É o que
//       transforma um XSS futuro em nada: sem ele, um script injetado pode
//       mandar o conteúdo da tela (CPF, CNH) para qualquer servidor.
//   X-Frame-Options / frame-ancestors  impede embutir o portal num iframe de
//       outro site (clickjacking: o clique do usuário vai para o botão errado).
//   X-Content-Type-Options  impede o navegador "adivinhar" que um anexo .txt é
//       HTML e executá-lo.
//   Referrer-Policy  o link assinado do anexo não deve vazar no Referer.
//   Strict-Transport-Security  só em produção: fecha a porta do primeiro
//       acesso em HTTP. Local roda sem HTTPS, e mandar isso ali travaria a
//       máquina do desenvolvedor em https://localhost.
//
// SOBRE O 'unsafe-inline' EM script-src: cada view tem um <script> embutido no
// próprio HTML (as telas se montam ali). Tirar isso exige mover esse script
// para arquivo em public/js — vale fazer, e aí o 'unsafe-inline' sai daqui.
// Mesmo com ele, a política já barra o principal: script vindo de FORA e envio
// de dados para domínio estranho (connect-src).
// --------------------------------------------------------------------------
const URL_SUPABASE = require('./src/storage').URL_PROJETO || 'https://*.supabase.co';

// O navegador manda o arquivo direto para o Supabase (URL assinada) e mostra a
// miniatura da foto de lá — por isso o host entra em connect-src e img-src.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  `img-src 'self' data: blob: ${URL_SUPABASE}`,
  `connect-src 'self' ${URL_SUPABASE}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  // Câmera fica de fora da lista de propósito: no celular o anexo é tirado na
  // hora, e bloquear aqui atrapalharia o envio pelo formulário.
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), payment=()');
  if (EM_PRODUCAO) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});
// Arquivos estáticos (CSS, imagens) ANTES da sessão: assim requisições de
// assets não disparam uma consulta ao store de sessão a cada arquivo.
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// src/validacao.js servido ao NAVEGADOR
//
// O mesmo arquivo valida no servidor e no cliente — uma só fonte de verdade.
// Sem isso, teríamos duas cópias das regras de CPF/placa/CNH divergindo com o
// tempo (o front aceita e o back recusa, ou pior: o contrário).
//
// O módulo é CommonJS e não usa require, então basta envolvê-lo num escopo com
// um "module.exports" de mentira e publicar o resultado em window.Validacao.
// --------------------------------------------------------------------------
const validacaoParaNavegador = (() => {
  const fonte = fs.readFileSync(path.join(__dirname, 'src', 'validacao.js'), 'utf8');
  return (
    '/* Gerado a partir de src/validacao.js — não edite aqui. */\n' +
    '(function () {\n' +
    'var module = { exports: {} };\n' +
    'var exports = module.exports;\n' +
    fonte +
    '\nwindow.Validacao = module.exports;\n' +
    '})();\n'
  );
})();

app.get('/js/validacao.js', (req, res) => {
  res.type('application/javascript');

  // "no-cache" NÃO é "não guarde": o navegador guarda e PERGUNTA se mudou,
  // respondido com 304 quando não mudou. Custa uma requisição minúscula por
  // carregamento e garante que a tela nunca fique com regra velha.
  //
  // Antes eram 3600s de cache fixo. Depois de um deploy, o formulário rodava
  // até uma hora com a validação anterior — e o sintoma era silencioso: campo
  // novo sem aparecer, lista sem opção, e nada de errado no servidor. Só as
  // páginas HTML apontam para cá; guardar uma hora não economizava nada perto
  // do custo de depurar isso.
  res.set('Cache-Control', EM_PRODUCAO ? 'no-cache' : 'no-store');
  res.send(validacaoParaNavegador); // o Express põe o ETag, que faz o 304
});

app.use(express.urlencoded({ extended: true })); // formulários HTML
app.use(express.json({ strict: false, verify: capturarRaw })); // requisições fetch (login via JS) — strict:false aceita corpo em string


// --------------------------------------------------------------------------
// Segredo que assina o cookie de sessão
//
// Antes havia um valor fixo de reserva ('segredo-de-desenvolvimento-troque-me').
// Isso é um buraco silencioso: se a variável faltasse nas Environment Variables
// do Vercel, o sistema subiria normalmente assinando os cookies com um segredo
// que está escrito no código — e qualquer pessoa forjaria um cookie de admin.
// Falta de segredo em produção agora derruba o boot, que é um problema visível.
//
// Local continua com valor de reserva, para não pedir configuração de quem só
// quer rodar "npm run dev".
// --------------------------------------------------------------------------
const SESSION_SECRET = (() => {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;

  if (EM_PRODUCAO) {
    throw new Error(
      'SESSION_SECRET ausente ou curto demais (mínimo 16 caracteres).\n' +
        'Defina nas Environment Variables do Vercel um valor longo e aleatório, ex.:\n' +
        '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"'
    );
  }

  console.warn('[sessão] SESSION_SECRET não definido — usando segredo de desenvolvimento.');
  return 'segredo-de-desenvolvimento-troque-me';
})();

app.use(
  session({
    store: new SessaoStore(),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true, // cookie inacessível a JavaScript do navegador
      sameSite: 'lax',
      secure: EM_PRODUCAO, // exige HTTPS em produção (Vercel serve por HTTPS)
      maxAge: 8 * 60 * 60 * 1000, // 8 horas
    },
  })
);

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
//
// Três coisas acontecem aqui, nesta ordem:
//   1. o freio de força bruta (src/limite-login.js) barra quem já errou demais;
//   2. as credenciais são conferidas;
//   3. a sessão é REGENERADA antes de virar sessão logada.
//
// Sobre o (3): sem regenerar, o id de sessão que o navegador já tinha ANTES do
// login continua valendo depois dele. Quem conseguisse plantar um id no
// navegador da vítima (fixação de sessão) passaria a compartilhar a sessão
// autenticada dela. Regenerar troca o id no momento em que ele passa a valer
// algo, e custa uma linha.
app.post(
  '/api/login',
  wrap(async (req, res) => {
    const email = (req.body.email || '').trim();
    const senha = req.body.senha || '';

    if (!email || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe e-mail e senha.' });
    }

    const chaves = limiteLogin.chavesDoLogin(email, req.ip);

    const freio = await limiteLogin.verificar(chaves);
    if (freio.bloqueado) {
      const minutos = Math.max(1, Math.ceil(freio.segundos / 60));
      res.set('Retry-After', String(freio.segundos));
      return res.status(429).json({
        ok: false,
        erro: `Muitas tentativas de login. Tente de novo em ${minutos} minuto(s).`,
      });
    }

    const usuario = await usuarios.validarCredenciais(email, senha);
    if (!usuario) {
      await limiteLogin.registrarFalha(chaves);
      // Mesma mensagem para e-mail inexistente e senha errada, de propósito:
      // distinguir os dois entrega a lista de quem tem conta.
      return res.status(401).json({ ok: false, erro: 'E-mail ou senha inválidos.' });
    }

    await limiteLogin.limpar(chaves);

    await new Promise((resolve, reject) =>
      req.session.regenerate((err) => (err ? reject(err) : resolve()))
    );

    // Guarda apenas o essencial na sessão. "verificadoEm" é o relógio da
    // revalidação periódica feita em src/auth.js (exigirLogin).
    req.session.usuario = {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      papel: usuario.papel,
      verificadoEm: Date.now(),
    };

    // Espera o store gravar ANTES de responder: a tela redireciona na hora, e
    // a requisição seguinte pode cair em outra instância da função.
    await new Promise((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve()))
    );

    res.json({ ok: true, redirect: paginaInicialPorPapel(usuario.papel) });
  })
);

// Encerra a sessão.
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true, redirect: '/login' });
  });
});

// Dados do usuário logado + MENU montado a partir das permissões.
// O front desenha o menu com isso (public/js/app.js), então acrescentar um
// módulo não exige editar nenhuma view.
app.get('/api/eu', exigirLogin, (req, res) => {
  const u = req.session.usuario;
  res.json({
    ok: true,
    usuario: u,
    papelRotulo: papeis.rotuloDoPapel(u.papel),
    ehAdmin: papeis.ehAdmin(u.papel),
    formularios: papeis.formulariosDoPapel(u.papel),
    paineis: papeis.paineisDoPapel(u.papel),
    menu: menuPara(u),
    menuConta: menuDaConta(u),
  });
});

// Metadados de um módulo — as telas genéricas usam para título e descrição.
app.get(
  '/api/modulos/:slug',
  exigirLogin,
  (req, res) => {
    const m = acharModulo(req.params.slug);
    if (!m) return res.status(404).json({ ok: false, erro: 'Módulo não encontrado.' });
    res.json({
      ok: true,
      modulo: {
        slug: m.slug,
        rotulo: m.rotulo,
        rotuloCurto: m.rotuloCurto,
        icone: m.icone,
        descricao: m.descricao,
        // O painel se desenha a partir daqui: candidato não se vincula a
        // cliente, então a coluna e o filtro de clientes não existem para ele.
        // Sem este sinal, a tela mostraria uma coluna sempre vazia — que em
        // tabela parece dado faltando, não "não se aplica".
        temOperacoes: m.operacoesPermitidas === null || (m.operacoesPermitidas || []).length > 0,
        temRdo: !!m.temRdo,
        // Teste prático é só do candidato. O painel genérico serve os três
        // módulos, e é este sinal que decide se o ícone e a ficha existem na
        // tela — a rota já nem é registrada para quem não tem.
        temTestePratico: testePratico.permite(m.slug),
      },
    });
  }
);

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

// A rota /solicitante (Microsoft Forms embutido numa iframe) foi removida: o
// formulário nativo cobre o mesmo caso com validação na hora, e duas portas de
// entrada com regras diferentes só geravam divergência. O WEBHOOK do Forms
// continua ativo mais abaixo — quem responde por fora do Portal ainda entra.

// Acompanhamento das próprias solicitações, de todos os módulos liberados.
app.get('/minhas-solicitacoes', exigirLogin, (req, res) => {
  res.sendFile(path.join(VIEWS, 'minhas-solicitacoes.html'));
});

// Relatórios: leitura gerencial, separada do acompanhamento do dia a dia.
// Restrita a quem enxerga algum painel — quem só preenche formulário vê
// apenas as próprias solicitações, e um indicador sobre elas não diria nada.
app.get('/relatorios', exigirLogin, (req, res) => {
  if (!papeis.paineisDoPapel(req.session.usuario.papel).length) {
    // Mesma conduta das outras páginas restritas: manda para a home do papel,
    // em vez de uma tela de erro. Quem chegou aqui digitou a URL ou seguiu um
    // link antigo — não é um caso a explicar, é um caminho a corrigir.
    return res.redirect(paginaInicialPorPapel(req.session.usuario.papel));
  }
  res.sendFile(path.join(VIEWS, 'relatorios.html'));
});

// --------------------------------------------------------------------------
// BLACKLIST GEOMED
//
// A lista de proprietários que a diretoria recusou. Quem analisa cadastro
// registra o bloqueio aqui, e o envio de cadastro passa a bater nela.
// --------------------------------------------------------------------------
app.get('/blacklist', exigirLogin, (req, res) => {
  const u = req.session.usuario;
  if (!papeis.ehAdmin(u.papel) && !papeis.paineisDoPapel(u.papel).length) {
    return res.redirect(paginaInicialPorPapel(u.papel));
  }
  res.sendFile(path.join(VIEWS, 'blacklist.html'));
});

// A lista inteira (ativos e já liberados) e a lista de quem pode mandar
// bloquear — a tela monta o <select> a partir daqui, e não de HTML fixo, para
// acrescentar um nome ser uma linha em src/blacklist.js.
app.get(
  '/api/blacklist',
  exigirLogin,
  exigirBlacklist,
  wrap(async (req, res) => {
    const registros = await blacklist.listar();

    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      bloqueadores: blacklist.BLOQUEADORES,
      registros: registros.map((r) => ({ ...r, documento_formatado: blacklist.formatar(r.documento) })),
    });
  })
);

app.post(
  '/api/blacklist',
  exigirLogin,
  exigirBlacklist,
  wrap(async (req, res) => {
    const r = await blacklist.bloquear(req.body || {}, req.session.usuario.email);
    if (!r.ok) return res.status(400).json({ ok: false, erros: r.erros });
    res.status(201).json({ ok: true, registro: r.registro });
  })
);

// Desbloqueio. POST e não DELETE de propósito: nada é removido — a linha ganha
// data, autor e motivo da liberação, e continua na tabela.
app.post(
  '/api/blacklist/:id/liberar',
  exigirLogin,
  exigirBlacklist,
  wrap(async (req, res) => {
    const r = await blacklist.liberar(Number(req.params.id), req.body || {});
    if (!r.ok) return res.status(400).json({ ok: false, erros: r.erros });
    res.json({ ok: true, registro: r.registro });
  })
);

/**
 * Dados do relatório: TODAS as solicitações dos módulos que a pessoa acompanha.
 *
 * Diferente de /api/solicitacoes, que é do painel do terceiro. Aqui vem tudo
 * junto, com o módulo marcado em cada linha, porque o relatório é gerencial e
 * a pergunta é sobre o conjunto.
 */
app.get(
  '/api/relatorios',
  exigirLogin,
  wrap(async (req, res) => {
    const u = req.session.usuario;
    const slugs = papeis.paineisDoPapel(u.papel);
    if (!slugs.length) return res.status(403).json({ ok: false, erro: 'Sem permissão.' });

    const porModulo = await Promise.all(
      slugs.map(async (slug) => {
        const dados = dadosDe(slug);
        const modulo = acharModulo(slug);
        if (!dados || !modulo) return [];
        const linhas = await dados.listar();
        return linhas.map((s) => ({ ...s, modulo: slug, moduloRotulo: modulo.rotuloCurto }));
      })
    );

    // O RDO é restrito a admin, e o relatório não é exceção.
    const podeVerRdo = papeis.podeRdo(u.papel);
    const lista = porModulo.flat().map((s) => (podeVerRdo ? s : semRdo(s)));

    res.json({
      ok: true,
      podeVerRdo,
      modulos: slugs.map((s) => ({ slug: s, rotulo: acharModulo(s).rotuloCurto })),
      solicitacoes: lista.sort((a, b) => String(b.criado_em).localeCompare(String(a.criado_em))),
    });
  })
);

/**
 * Tudo sobre UMA solicitação: contato, documentos e histórico.
 *
 * Serve o "Ver" da tela de acompanhamento. Quem envia precisa consultar o que
 * mandou sem depender de quem analisa — e sem virar mais uma coluna na grade,
 * que foi o que deixou a tela pesada.
 *
 * Acesso: o DONO da solicitação, ou quem acompanha o painel daquele módulo.
 * Amarrar só ao painel esconderia do solicitante o próprio cadastro.
 */
app.get(
  '/api/modulos/:slug/solicitacoes/:id/detalhe',
  exigirLogin,
  wrap(async (req, res) => {
    const m = acharModulo(req.params.slug);
    const id = Number(req.params.id);
    if (!m || !Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Pedido inválido.' });

    const dados = dadosDe(m.slug);
    const s = dados && (await dados.buscarPorId(id));
    if (!s) return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });

    const u = req.session.usuario;
    const dono = String(s.solicitante_email || '').toLowerCase() === String(u.email).toLowerCase();
    const acompanha = papeis.podePainel(u.papel, m.slug);
    if (!dono && !acompanha) return res.status(403).json({ ok: false, erro: 'Sem permissão.' });

    // A pesquisa RDO — resposta e ARQUIVO — é de quem acompanha o painel.
    //
    // O arquivo já foi restrito a admin, e a restrição saiu porque produzia o
    // oposto do que prometia: o responsável é quem analisa e quem ANEXA o
    // comprovante, então ele mandava o PDF e o via desaparecer da tela no
    // instante seguinte — sem erro, sem aviso. O documento sumia da lista para
    // a mesma pessoa que acabara de enviá-lo, e a leitura natural disso é que
    // o envio falhou. O SOLICITANTE continua fora, que é a restrição que
    // importa: a pesquisa é conferência interna sobre ele mesmo.
    const podeRdo = papeis.podeRdo(u.papel, m.slug);
    let docs = await documentos.listar(m.slug, id);
    const temComprovanteRdo = docs.some((d) => fluxo.ehRdo(d.tipo));
    if (!podeRdo) {
      docs = docs.filter((d) => !fluxo.ehRdo(d.tipo));
    }

    res.json({
      ok: true,
      solicitacao: podeRdo ? { ...s, rdo: { ...s.rdo, temComprovante: temComprovanteRdo } } : semRdo(s),
      documentos: await documentos.comUrls(docs, {
        rotaDeDownload: (d) => `/api/modulos/${m.slug}/solicitacoes/${id}/documentos/${d.id}/baixar`,
      }),
      // Quem passou pelo cadastro, inclusive quem já saiu — é o histórico que
      // responde "com quem eu falo sobre isso" depois que a pessoa trocou.
      historico: await atendimentos.historico(m.slug, id),
      // O teste prático, quando o módulo tem um. Fora para o SOLICITANTE pelo
      // mesmo motivo do RDO: é julgamento interno sobre ele mesmo.
      teste: acompanha ? await testePratico.atual(m.slug, id) : null,
    });
  })
);

// ---- Páginas dos módulos, geradas a partir do registro -------------------
//
// Cada módulo ganha /cadastro/<slug> e /painel/<slug>. O módulo com view
// própria (terceiro) usa a dele; os demais usam as telas genéricas, que se
// adaptam pelos metadados.
for (const m of MODULOS) {
  app.get(rotaFormulario(m.slug), exigirLogin, exigirFormulario(m.slug), (req, res) => {
    res.sendFile(path.join(VIEWS, m.viewFormulario || 'modulo-formulario.html'));
  });

  app.get(rotaPainel(m.slug), exigirLogin, exigirPainel(m.slug), (req, res) => {
    res.sendFile(path.join(VIEWS, m.viewPainel || 'modulo-painel.html'));
  });
}

// ---- Endereços antigos, preservados -------------------------------------
// /cadastro e /responsavel viraram rotas por módulo. Redirecionar em vez de
// dar 404 mantém funcionando os favoritos e qualquer link já compartilhado.
app.get('/cadastro', (req, res) => res.redirect(rotaFormulario('terceiro')));
app.get('/responsavel', (req, res) => res.redirect(rotaPainel('terceiro')));

// Configuração do formulário — SOMENTE admin.
app.get('/admin/formulario', exigirLogin, exigirAdmin, (req, res) => {
  res.sendFile(path.join(VIEWS, 'admin-formulario.html'));
});

// Gestão de usuários — SOMENTE admin.
app.get('/admin/usuarios', exigirLogin, exigirAdmin, (req, res) => {
  res.sendFile(path.join(VIEWS, 'admin-usuarios.html'));
});

// --------------------------------------------------------------------------
// API de usuários (somente admin)
//
// Substitui o script de linha de comando `npm run criar-usuario`, que continua
// funcionando mas exige acesso ao terminal do projeto.
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Diagnóstico do armazenamento — somente admin
//
// Existe porque a configuração do storage é invisível pela tela: a chave do
// Supabase mora numa variável de ambiente, e sem ela o upload recusa sem que
// ninguém saiba por quê. Aqui dá para conferir em dois segundos, sem terminal
// e sem abrir o painel do Vercel.
//
// Não devolve a chave, só se ela existe.
// --------------------------------------------------------------------------
app.get(
  '/api/admin/armazenamento',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const armazenamento = require('./src/storage');
    const emUso = armazenamento.provedor();

    const provedores = {};
    for (const [nome, p] of Object.entries(armazenamento.PROVEDORES)) {
      provedores[nome] = p.disponivel();
    }

    // Uma escrita de verdade: "a chave existe" não prova que ela funciona
    // (pode estar revogada, ou apontar para outro projeto).
    let escrita = { ok: false, erro: 'não testado' };
    if (emUso.disponivel()) {
      const alvo = 'CADASTROS/_DIAGNOSTICO/teste.pdf';
      try {
        await emUso.enviar(alvo, Buffer.from('%PDF-1.4 diagnostico\n%%EOF\n'), 'application/pdf');
        const volta = await emUso.baixar(alvo);
        await emUso.remover(alvo);
        escrita = { ok: volta && volta.length > 0 };
      } catch (e) {
        escrita = { ok: false, erro: e.message.slice(0, 200) };
      }
    }

    res.json({
      ok: true,
      emUso: emUso.nome,
      funcionando: emUso.disponivel() && escrita.ok,
      // Quando não está funcionando, diz o que falta em vez de deixar
      // adivinhar entre "chave ausente" e "URL do projeto ausente".
      falta: emUso.disponivel() ? [] : (emUso.oQueFalta ? emUso.oQueFalta() : ['configuração']),
      escolhaExplicita: process.env.STORAGE_PROVEDOR || null,
      provedores,
      escrita,
      limiteMB: armazenamento.TAMANHO_MAXIMO_MB,
      bucket: armazenamento.BUCKET,
      pastaCanal: process.env.PASTA_CANAL || null,
      ambiente: EM_PRODUCAO ? 'producao' : 'local',
    });
  })
);

// Lista os usuários + os papéis disponíveis (para o seletor da tela).
app.get(
  '/api/admin/usuarios',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    res.json({
      ok: true,
      usuarios: await usuarios.listarParaAdmin(),
      papeis: papeis.PAPEIS_ATUAIS.map((p) => ({
        valor: p,
        rotulo: papeis.rotuloDoPapel(p),
        formularios: papeis.formulariosDoPapel(p),
        paineis: papeis.paineisDoPapel(p),
      })),
      senhaMinima: usuarios.SENHA_MINIMA,
      meuId: req.session.usuario.id,
    });
  })
);

// Cria um usuário.
app.post(
  '/api/admin/usuarios',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const { nome, email, senha, papel } = req.body || {};
    const r = await usuarios.criarValidado({ nome, email, senha, papel });
    if (!r.ok) return res.status(400).json({ ok: false, erros: r.erros });
    res.status(201).json({ ok: true, usuario: r.usuario });
  })
);

// Ativa/desativa ou troca o papel.
app.patch(
  '/api/admin/usuarios/:id',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const b = req.body || {};
    const idDoSolicitante = req.session.usuario.id;

    if (typeof b.ativo === 'boolean') {
      const r = await usuarios.definirAtivo(id, b.ativo, { idDoSolicitante });
      if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    }

    if (typeof b.papel === 'string') {
      const r = await usuarios.definirPapel(id, b.papel, { idDoSolicitante });
      if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    }

    res.json({ ok: true });
  })
);

// Define uma senha nova (quando a pessoa esquece a dela).
app.post(
  '/api/admin/usuarios/:id/senha',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const r = await usuarios.trocarSenha(id, (req.body || {}).senha);
    if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    res.json({ ok: true });
  })
);

// --------------------------------------------------------------------------
// API de solicitações
// --------------------------------------------------------------------------

// Lista para o painel do responsável (com os indicadores).
app.get(
  '/api/solicitacoes',
  exigirLogin,
  exigirPainel('terceiro'),
  wrap(async (req, res) => {
    const [resumo, lista, anexos, comComprovante] = await Promise.all([
      solicitacoes.contarPorStatus(),
      solicitacoes.listar(),
      documentos.contarPorSolicitacao('terceiro'),
      // Só os ids: o responsável precisa saber que o comprovante existe para
      // poder confirmar a reprovação, sem receber o arquivo.
      documentos.idsComTipo('terceiro', fluxo.DOC_RDO),
    ]);
    // O resultado do RDO é de quem ACOMPANHA o painel. Filtrar AQUI, e não só
    // na tela: esconder no HTML deixaria o dado viajando na resposta, visível
    // a quem abrisse o inspetor do navegador.
    const podeVerRdo = papeis.podeRdo(req.session.usuario.papel, 'terceiro');
    const visiveis = podeVerRdo
      ? lista.map((s) => ({ ...s, rdo: { ...s.rdo, temComprovante: comComprovante.has(Number(s.id)) } }))
      : lista.map(semRdo);

    res.json({
      ok: true,
      papel: req.session.usuario.papel, // o front usa para mostrar o botão de excluir só ao admin
      usuarioId: req.session.usuario.id, // para saber se ele mesmo já está no atendimento
      podeVerRdo,
      resumo,
      solicitacoes: visiveis,
      anexos,
      atendimentos: await atendimentos.resumoDeVarias('terceiro', lista.map((s) => s.id)),
    });
  })
);

// "Impressão digital" da lista, para o painel se atualizar sozinho.
//
// O painel consulta esta rota a cada poucos segundos e só busca a lista
// completa quando o valor muda. É uma consulta agregada, muito mais barata que
// devolver as 52 linhas com detalhes e anexos a cada verificação — o que
// importa no plano gratuito do banco.
app.get(
  '/api/solicitacoes/versao',
  exigirLogin,
  exigirPainel('terceiro'),
  wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await solicitacoes.versao()) });
  })
);

// Exclui uma solicitação — SOMENTE admin.
app.delete(
  '/api/solicitacoes/:id',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok: false, erro: 'Id inválido.' });
    }
    const removido = await solicitacoes.excluir(id);
    if (!removido) {
      return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
    }
    res.json({ ok: true });
  })
);

// --------------------------------------------------------------------------
// Configuração do formulário (operações e matriz de documentos)
//
// A LEITURA é liberada a qualquer usuário logado — o formulário precisa dela
// para montar os campos. A ESCRITA é só do admin.
// --------------------------------------------------------------------------
// Configuração do módulo TERCEIRO (rota histórica, usada por views/cadastro.html).
//
// O TIPO DE PESQUISA recorta o que volta: "motorista" não devolve a placa da
// carreta nem o CRLV dela. Sem o parâmetro, devolve tudo — que é o que
// "completo" faz, e mantém compatível quem chamar sem saber da modalidade.
app.get(
  '/api/config-formulario',
  exigirLogin,
  wrap(async (req, res) => {
    const r = await configFormulario.paraFormulario('terceiro', {
      tipoPesquisa: req.query.tipoPesquisa || null,
      alvo: req.query.alvo || null,
    });
    if (r.ok === false) return res.status(400).json({ ok: false, erro: r.erro });

    res.json({ ok: true, ...r, tiposDePesquisa: pesquisas.TIPOS_PESQUISA });
  })
);

// Encontra o cadastro que uma RENOVAÇÃO vai renovar, e diz quais anexos dele
// estão vencidos ou faltando. A tela chama enquanto a pessoa digita o CPF ou a
// placa, para mostrar quem foi encontrado antes de enviar.
//
// DUAS TRAVAS, porque esta rota responde sobre PESSOA a partir de um CPF ou de
// uma placa — é a única do sistema com essa forma, e era aberta a qualquer
// usuário logado:
//
//   exigirAcessoAoModulo('terceiro')  só quem preenche ou acompanha o cadastro
//       de terceiro tem motivo para consultar renovação. Antes, qualquer papel
//       logado consultava.
//
//   limitarConsultaDeCadastro        a tela chama a cada digitação, então o
//       teto é alto; o que ele impede é a varredura (rodar uma lista de CPFs
//       para descobrir quem está cadastrado, com nome e documentos).
app.get(
  '/api/cadastros/existente',
  exigirLogin,
  exigirAcessoAoModulo('terceiro'),
  limitarConsultaDeCadastro,
  wrap(async (req, res) => {
    const recorte = pesquisas.resolver('renovacao', req.query.alvo);
    if (!recorte.ok) return res.status(400).json({ ok: false, erro: recorte.erro });

    const escoposDeAnexo = recorte.escoposDeAnexo || recorte.escopos;
    const docs = (await configFormulario.documentos('terceiro', { apenasAtivos: true }))
      .filter((d) => pesquisas.escopoCabe(d.escopo, escoposDeAnexo));

    const r = await cadastros.acharParaRenovar(recorte.alvo, req.query.valor, {
      documentosDoModulo: docs,
    });

    if (!r.ok) {
      const erro = r.erro === 'naoAchou' ? recorte.identificacao.naoAchou : r.erro;
      // 200 com achado:false, e não 404: "não encontrei" é uma resposta
      // esperada enquanto a pessoa digita, não uma falha da requisição.
      return res.json({ ok: true, achado: false, erro });
    }

    res.json({ ok: true, achado: true, resumo: r.resumo, anexos: r.anexos, pendentes: r.pendentes });
  })
);

// Especificação COMPLETA do formulário de um módulo: campos, operações e
// documentos. A tela genérica se desenha inteira a partir daqui — acrescentar
// campo em src/campos.js aparece na tela sem tocar em HTML.
app.get(
  '/api/modulos/:slug/formulario',
  exigirLogin,
  wrap(async (req, res) => {
    const m = acharModulo(req.params.slug);
    if (!m) return res.status(404).json({ ok: false, erro: 'Módulo não encontrado.' });

    // O spread vem PRIMEIRO: paraFormulario() também devolve um campo "modulo"
    // (só o slug), e se viesse depois sobrescreveria o objeto com os rótulos.
    res.json({
      ok: true,
      ...(await configFormulario.paraFormulario(m.slug)),
      modulo: { slug: m.slug, rotulo: m.rotulo, rotuloCurto: m.rotuloCurto, descricao: m.descricao },
    });
  })
);

// Matriz completa (inclui itens desativados) — para a tela de administração.
app.get(
  '/api/admin/formulario',
  exigirLogin,
  exigirConfigurarFormulario,
  wrap(async (req, res) => {
    const slug = String(req.query.modulo || 'terceiro');
    if (!acharModulo(slug)) return res.status(404).json({ ok: false, erro: 'Módulo não encontrado.' });
    res.json({ ok: true, ...(await configFormulario.paraAdmin(slug)) });
  })
);

// Cria uma operação (cliente novo).
app.post(
  '/api/admin/operacoes',
  exigirLogin,
  exigirConfigurarFormulario,
  wrap(async (req, res) => {
    const r = await configFormulario.criarOperacao((req.body || {}).nome);
    if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    res.status(201).json(r);
  })
);

// Liga/desliga uma operação.
app.patch(
  '/api/admin/operacoes/:id',
  exigirLogin,
  exigirConfigurarFormulario,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const achou = await configFormulario.definirOperacaoAtiva(id, !!(req.body || {}).ativo);
    if (!achou) return res.status(404).json({ ok: false, erro: 'Operação não encontrada.' });
    res.json({ ok: true });
  })
);

// Cria um tipo de documento.
app.post(
  '/api/admin/documentos',
  exigirLogin,
  exigirConfigurarFormulario,
  wrap(async (req, res) => {
    const { modulo, codigo, rotulo, temValidade, obrigatorio, escopo } = req.body || {};
    const r = await configFormulario.criarDocumento({
      modulo: modulo || 'terceiro',
      codigo,
      rotulo,
      temValidade,
      obrigatorio: obrigatorio !== false,
      escopo,
    });
    if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    res.status(201).json(r);
  })
);

// Atualiza um documento: ativo, rótulo e/ou para quais operações ele vale.
app.patch(
  '/api/admin/documentos/:id',
  exigirLogin,
  exigirConfigurarFormulario,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const b = req.body || {};
    let mexeu = false;

    if (typeof b.ativo === 'boolean') {
      mexeu = (await configFormulario.definirDocumentoAtivo(id, b.ativo)) || mexeu;
    }
    if (typeof b.rotulo === 'string') {
      mexeu = (await configFormulario.renomearDocumento(id, b.rotulo)) || mexeu;
    }
    if (typeof b.obrigatorio === 'boolean') {
      mexeu = (await configFormulario.definirDocumentoObrigatorio(id, b.obrigatorio)) || mexeu;
    }
    if (typeof b.escopo === 'string') {
      mexeu = (await configFormulario.definirDocumentoEscopo(id, b.escopo)) || mexeu;
    }
    if (typeof b.todas === 'boolean') {
      const ids = Array.isArray(b.operacaoIds) ? b.operacaoIds.map(Number).filter(Number.isInteger) : [];
      mexeu = (await configFormulario.definirOperacoesDoDocumento(id, { todas: b.todas, operacaoIds: ids })) || mexeu;
    }

    if (!mexeu) return res.status(404).json({ ok: false, erro: 'Documento não encontrado ou nada a alterar.' });
    res.json({ ok: true });
  })
);

// --------------------------------------------------------------------------
// DOCUMENTOS — upload nativo e exportação
//
// O arquivo NÃO passa pelo servidor: o navegador pede uma URL assinada, envia
// direto ao storage e depois avisa o portal para registrar. Motivo prático — a
// função do Vercel tem limite de ~4,5 MB no corpo da requisição, e um PDF de
// CRLV passa disso com facilidade.
//
// Quem pode: quem preenche o formulário do módulo (envia os seus) e quem
// acompanha o painel (lê e exporta).
// --------------------------------------------------------------------------

/** Deixa passar quem preenche o formulário OU quem acompanha o painel. */
function exigirAcessoAoModulo(slug) {
  const doFormulario = exigirFormulario(slug);
  const doPainel = exigirPainel(slug);
  return (req, res, next) => {
    const u = req.session && req.session.usuario;
    if (u && papeis.podePainel(u.papel, slug)) return doPainel(req, res, next);
    return doFormulario(req, res, next);
  };
}

/**
 * Acesso a UMA solicitação — a segunda pergunta, que faltava.
 *
 * exigirAcessoAoModulo responde "esta pessoa mexe neste MÓDULO?". Não responde
 * "pode mexer NESTE cadastro?". Sem a segunda, quem só preenche formulário
 * (papéis terceiro/agregado/candidato/solicitante) alcançava qualquer :id do
 * módulo trocando o número na URL — e, com ele, os anexos de qualquer pessoa:
 * CNH, CPF, CRLV. Também dava para apagar.
 *
 * A regra é a mesma que a rota .../detalhe já usava: DONO do cadastro, ou quem
 * acompanha o painel do módulo. Quem acompanha o painel continua vendo tudo,
 * que é o trabalho dele.
 *
 * Guarda a solicitação em req.solicitacao — quem já a leu aqui não precisa
 * buscar de novo no handler.
 */
function exigirAcessoASolicitacao(slug) {
  return wrap(async (req, res, next) => {
    const u = req.session.usuario;
    if (papeis.podePainel(u.papel, slug)) return next();

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const dados = dadosDe(slug);
    const s = dados && (await dados.buscarPorId(id));
    if (!s) return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });

    const dono =
      String(s.solicitante_email || '').toLowerCase() === String(u.email || '').toLowerCase();
    if (!dono) return res.status(403).json({ ok: false, erro: 'Sem permissão para este cadastro.' });

    req.solicitacao = s;
    return next();
  });
}

/**
 * Este documento é DESTE módulo e DESTA solicitação?
 *
 * A tabela "documentos" é uma só para os três módulos, e buscarPorId lê por id
 * puro. Sem esta conferência o :id da URL era enfeite: qualquer docId de
 * qualquer módulo respondia na rota de qualquer outro — inclusive no DELETE.
 */
function documentoDaSolicitacao(d, slug, id) {
  return !!d && String(d.modulo) === String(slug) && Number(d.solicitacao_id) === Number(id);
}

/**
 * O comprovante do RDO é de quem ACOMPANHA o painel, nunca do solicitante.
 *
 * As listagens já filtram o tipo, mas listagem não é controle de acesso: as
 * rotas /:docId/url e /:docId/baixar recebem o id do documento direto, e sem
 * esta conferência o dono do cadastro baixava a própria pesquisa trocando o
 * número na URL — justamente o documento que a regra esconde dele.
 */
function podeVerDocumento(d, slug, usuario) {
  if (!fluxo.ehRdo(d && d.tipo)) return true;
  return papeis.podeRdo(usuario.papel, slug);
}

for (const m of MODULOS) {
  const base = `/api/modulos/${m.slug}/solicitacoes/:id/documentos`;
  const dados = dadosDe(m.slug);

  /**
   * Dono do cadastro: define o nome da pasta (ID_NOME_CPF).
   *
   * O condutor é procurado em três lugares, nesta ordem — e a ordem importa:
   *
   *   1. solicitacao_cadastro, quando o cadastro veio do formulário NATIVO;
   *   2. o texto "detalhes", quando veio do Microsoft Forms pelo webhook —
   *      que é o caso de quase tudo (401 solicitações para 2 vínculos);
   *   3. o solicitante, como último recurso.
   *
   * O passo 2 faltava, e era o que jogava todo anexo do Forms numa pasta
   * batizada com o e-mail de quem abriu o chamado e terminada em "_SEM_CPF".
   */
  async function donoDaSolicitacao(id) {
    const s = await dados.buscarPorId(id);
    if (!s) return null;

    // Cada módulo guarda o condutor num lugar: o terceiro nas tabelas
    // estruturadas, os demais no JSON "dados".
    if (m.slug === 'terceiro') {
      const e = await cadastros.buscarPorSolicitacao(id);
      if (e && e.condutor_nome) return { nome: e.condutor_nome, cpf: e.condutor_cpf };

      const doTexto = cadastros.condutorDosDetalhes(s.detalhes);
      if (doTexto.nome) return doTexto;

      return { nome: s.solicitante_nome, cpf: '' };
    }

    const d = s.dados || {};
    if (d.condutor_nome) return { nome: d.condutor_nome, cpf: d.condutor_cpf || d.cpf || '' };

    const doTexto = cadastros.condutorDosDetalhes(s.detalhes);
    if (doTexto.nome) return doTexto;

    return { nome: s.solicitante_nome, cpf: d.cpf || '' };
  }

  // ------------------------------------------------------------------------
  // Atendimento: quem está cuidando deste cadastro
  //
  // Vale para os três módulos. A tela pergunta ANTES de abrir a solicitação,
  // então estas rotas são chamadas na hora do clique, não no fim do trabalho.
  // ------------------------------------------------------------------------
  const baseAt = `/api/modulos/${m.slug}/solicitacoes/:id/atendimento`;

  app.get(
    baseAt,
    exigirLogin,
    exigirPainel(m.slug),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const u = req.session.usuario;
      res.json({
        ok: true,
        ...(await atendimentos.resumo(m.slug, id)),
        // O front usa para decidir se mostra o modal ou abre direto.
        minhaParticipacao: (await atendimentos.minhaParticipacao(m.slug, id, u.id)) || null,
        historico: await atendimentos.historico(m.slug, id),
      });
    })
  );

  app.post(
    baseAt,
    exigirLogin,
    exigirPainel(m.slug),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const u = req.session.usuario;
      const r = await atendimentos.entrar({
        modulo: m.slug,
        solicitacaoId: id,
        usuario: u,
        papel: (req.body || {}).papel,
        // Só o admin tira o atendimento de outra pessoa, e mesmo assim
        // precisa pedir de propósito — não acontece por clique distraído.
        forcar: papeis.ehAdmin(u.papel) && (req.body || {}).forcar === true,
      });
      res.status(r.ok ? 200 : 409).json(r);
    })
  );

  app.delete(
    baseAt,
    exigirLogin,
    exigirPainel(m.slug),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const r = await atendimentos.sair({
        modulo: m.slug,
        solicitacaoId: id,
        usuarioId: req.session.usuario.id,
      });
      res.status(r.ok ? 200 : 400).json(r);
    })
  );

  // ---- Lista os documentos ----
  app.get(
    base,
    exigirLogin,
    exigirAcessoAoModulo(m.slug),
    exigirAcessoASolicitacao(m.slug),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      let lista = await documentos.listar(m.slug, id);

      // O comprovante do RDO é de quem acompanha o painel (mesma regra da rota
      // /detalhe). Para o SOLICITANTE ele sai da lista: a pesquisa é
      // conferência interna sobre ele, e sem esta linha o resultado vazaria
      // pelo nome do anexo.
      if (!papeis.podeRdo(req.session.usuario.papel, m.slug)) {
        lista = lista.filter((d) => !fluxo.ehRdo(d.tipo));
      }

      // A URL vem junto: sem ela o painel precisaria de uma requisição por
      // documento só para conseguir abrir cada um — e a miniatura da foto,
      // que é o que o analista olha primeiro, nem apareceria.
      //
      // Assinadas em LOTE: o custo é latência, não volume. Medido, uma
      // assinatura leva ~900ms; sete em paralelo, 1023ms; sete em lote saem
      // no mesmo ~900ms de uma requisição só.
      const comUrl = await documentos.comUrls(lista, {
        rotaDeDownload: (d) => `${base.replace(':id', id)}/${d.id}/baixar`,
      });

      res.json({ ok: true, documentos: comUrl });
    })
  );

  // ---- Pede a URL assinada para enviar ----
  app.post(
    `${base}/preparar`,
    exigirLogin,
    exigirAcessoAoModulo(m.slug),
    exigirAcessoASolicitacao(m.slug),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const dono = await donoDaSolicitacao(id);
      if (!dono) return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });

      const { tipo, nomeArquivo, contentType, tamanho } = req.body || {};
      if (!tipo) return res.status(400).json({ ok: false, erro: 'Informe o tipo do documento.' });

      const r = await documentos.prepararEnvio({
        modulo: m.slug,
        solicitacaoId: id,
        tipo,
        nomeArquivo,
        contentType,
        tamanho,
        dono,
      });
      if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });

      // Provedor sem URL de gravação (pasta em disco): o arquivo passa por
      // aqui. O navegador envia para a nossa própria rota, com o mesmo PUT.
      if (!r.url) {
        r.url = `${base.replace(':id', id)}/enviar?caminho=${encodeURIComponent(r.caminho)}`;
        r.metodo = 'PUT';
        r.direto = false;
      }
      res.json({ ok: true, ...r });
    })
  );

  // ---- Recebe o arquivo, quando o provedor grava em disco ----
  //
  // express.raw porque o corpo é o arquivo em si, não JSON. O limite é o mesmo
  // da validação; rodando local não há o teto de 4,5 MB do Vercel no caminho.
  app.put(
    `${base}/enviar`,
    exigirLogin,
    exigirAcessoAoModulo(m.slug),
    exigirAcessoASolicitacao(m.slug),
    express.raw({ type: () => true, limit: require('./src/storage').TAMANHO_MAXIMO }),
    wrap(async (req, res) => {
      const caminho = String(req.query.caminho || '');
      if (!caminho) return res.status(400).json({ ok: false, erro: 'Caminho não informado.' });
      if (!req.body || !req.body.length) return res.status(400).json({ ok: false, erro: 'Corpo vazio.' });

      const armazenamento = require('./src/storage');

      // O caminho foi calculado por /preparar, mas volta pelo navegador e pode
      // ter sido trocado. A forma é conferida aqui, e não no provedor: gravando
      // em disco um caminho torto escreve fora da pasta do canal; no Supabase
      // escreve em qualquer lugar do bucket, porque lá toda chave é válida.
      try {
        armazenamento.validarCaminhoLogico(caminho);
      } catch (e) {
        return res.status(400).json({ ok: false, erro: e.message });
      }

      // Extensão e tipo também: a pasta é sincronizada pelo OneDrive para a
      // equipe, e um .lnk ou .exe gravado ali chegaria na máquina de todo mundo.
      const valido = armazenamento.validarArquivo({
        nome: caminho,
        contentType: req.get('content-type'),
        tamanho: req.body.length,
      });
      if (!valido.ok) return res.status(400).json({ ok: false, erro: valido.erro });

      const prov = armazenamento.provedor();
      try {
        // O provedor valida o caminho (prefixo obrigatório e travessia de
        // diretório) — ele volta do navegador e não é confiável.
        await prov.enviar(caminho, req.body, req.get('content-type'));
      } catch (e) {
        return res.status(400).json({ ok: false, erro: e.message });
      }
      res.json({ ok: true, caminho, tamanho: req.body.length });
    })
  );

  // ---- Baixa um documento pelo servidor ----
  //
  // Usado quando o provedor não tem URL pública (pasta em disco). Com Supabase,
  // a rota /url devolve link assinado e o navegador baixa direto, sem passar
  // por aqui.
  app.get(
    `${base}/:docId/baixar`,
    exigirLogin,
    exigirAcessoAoModulo(m.slug),
    exigirAcessoASolicitacao(m.slug),
    wrap(async (req, res) => {
      const docId = Number(req.params.docId);
      if (!Number.isInteger(docId)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const d = await documentos.buscarPorId(docId);
      if (!documentoDaSolicitacao(d, m.slug, req.params.id) || !d.caminho) {
        return res.status(404).json({ ok: false, erro: 'Documento não encontrado.' });
      }
      // Mesma resposta de "não existe": dizer "sem permissão" já confirmaria
      // ao solicitante que a pesquisa do RDO dele está anexada.
      if (!podeVerDocumento(d, m.slug, req.session.usuario)) {
        return res.status(404).json({ ok: false, erro: 'Documento não encontrado.' });
      }

      const prov = documentos.armazenamentoDe(d);
      if (!prov) return res.status(409).json({ ok: false, erro: documentos.motivoIndisponivel(d) });

      try {
        // Na pasta do canal a leitura pode demorar: o OneDrive guarda o arquivo
        // só na nuvem e o baixa sob demanda quando alguém lê.
        const buffer = await prov.baixar(d.caminho);
        res.type(d.content_type || 'application/octet-stream');
        res.set('Content-Disposition', `inline; filename="${d.nome_arquivo}"`);
        res.send(buffer);
      } catch (e) {
        res.status(404).json({ ok: false, erro: 'Arquivo não encontrado no armazenamento.' });
      }
    })
  );

  // ---- Confirma que o arquivo chegou ao storage ----
  app.post(
    `${base}/registrar`,
    exigirLogin,
    exigirAcessoAoModulo(m.slug),
    exigirAcessoASolicitacao(m.slug),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const { tipo, caminho, nomeOriginal, contentType, tamanho, provedor, validade } = req.body || {};
      if (!tipo || !caminho) return res.status(400).json({ ok: false, erro: 'Dados incompletos.' });

      let r;
      try {
        r = await documentos.registrar({
          modulo: m.slug,
          solicitacaoId: id,
          tipo,
          caminho,
          nomeOriginal,
          contentType,
          tamanho,
          provedor,
          validade,
          // Autoria do anexo. O documento traz CPF e endereço de terceiro;
          // "quem anexou isto aqui" precisava ter resposta.
          criadoPor: req.session.usuario.id,
        });
      } catch (e) {
        // Caminho recusado é erro do pedido, não falha do servidor.
        if (/Caminho inválido/.test(e.message)) {
          return res.status(400).json({ ok: false, erro: e.message });
        }
        throw e;
      }
      res.status(201).json(r);
    })
  );

  // ---- URL temporária para abrir/baixar um documento ----
  app.get(
    `${base}/:docId/url`,
    exigirLogin,
    exigirAcessoAoModulo(m.slug),
    exigirAcessoASolicitacao(m.slug),
    wrap(async (req, res) => {
      const docId = Number(req.params.docId);
      if (!Number.isInteger(docId)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const d = await documentos.buscarPorId(docId);
      if (!documentoDaSolicitacao(d, m.slug, req.params.id)) {
        return res.status(404).json({ ok: false, erro: 'Documento não encontrado.' });
      }
      // Ver podeVerDocumento: sem isto, a URL assinada do comprovante do RDO
      // sairia para o próprio solicitante.
      if (!podeVerDocumento(d, m.slug, req.session.usuario)) {
        return res.status(404).json({ ok: false, erro: 'Documento não encontrado.' });
      }

      // O arquivo pode estar num armazenamento que este ambiente não alcança
      // (gravado na pasta do canal, portal rodando no Vercel). Dizer isso vale
      // mais que devolver um link que só falha depois de clicado.
      if (!documentos.armazenamentoDe(d)) {
        return res.status(409).json({ ok: false, erro: documentos.motivoIndisponivel(d) });
      }

      // Com Supabase, devolve link assinado e o navegador baixa direto. Com
      // pasta em disco não existe link, então aponta para a rota deste
      // servidor, que lê o arquivo e devolve.
      const assinada = await documentos.urlDeLeitura(docId);
      res.json({
        ok: true,
        url: assinada || `${base.replace(':id', d.solicitacao_id)}/${docId}/baixar`,
      });
    })
  );

  // ---- Exclui um documento ----
  app.delete(
    `${base}/:docId`,
    exigirLogin,
    exigirAcessoAoModulo(m.slug),
    exigirAcessoASolicitacao(m.slug),
    wrap(async (req, res) => {
      const docId = Number(req.params.docId);
      if (!Number.isInteger(docId)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      // Confere ANTES de apagar: excluir() recebe só o id e não sabe de qual
      // cadastro o arquivo é.
      const d = await documentos.buscarPorId(docId);
      if (!documentoDaSolicitacao(d, m.slug, req.params.id)) {
        return res.status(404).json({ ok: false, erro: 'Documento não encontrado.' });
      }

      const r = await documentos.excluir(docId);
      if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
      res.json({ ok: true });
    })
  );

  // ---- Manifesto para exportação em ZIP ----
  //
  // Devolve a lista de arquivos com URL temporária de cada um. O ZIP é montado
  // NO NAVEGADOR: a função do Vercel tem limite de tempo e memória, e baixar
  // dezenas de arquivos para compactar do lado do servidor estouraria os dois.
  app.post(
    `/api/modulos/${m.slug}/exportar`,
    exigirLogin,
    exigirPainel(m.slug),
    wrap(async (req, res) => {
      const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
      if (!ids.length) return res.status(400).json({ ok: false, erro: 'Selecione ao menos um cadastro.' });

      const arquivos = await documentos.listarDeVarias(m.slug, ids);

      // A pasta de cada cadastro vem do caminho já gravado, não é remontada:
      // assim a exportação reflete exatamente como os arquivos foram salvos.
      // 30 min de validade: tempo de sobra para baixar tudo, sem deixar link
      // vivo à toa. Em lote, porque a exportação de vários cadastros pode
      // passar de cem arquivos — uma assinatura por arquivo seria proibitivo.
      const assinados = await documentos.comUrls(arquivos.filter((a) => a.caminho), {
        rotaDeDownload: (a) =>
          `/api/modulos/${m.slug}/solicitacoes/${a.solicitacao_id}/documentos/${a.id}/baixar`,
      });

      const itens = [];
      const indisponiveis = [];
      for (const a of assinados) {
        const partes = a.caminho.split('/');
        const pasta = partes[partes.length - 2] || 'CADASTRO';
        const nome = partes[partes.length - 1];

        // Um ZIP que simplesmente omite o que não alcançou parece completo e
        // não é — o que falta vai declarado, não sumido.
        if (!a.url) {
          indisponiveis.push({ pasta, nome, motivo: a.indisponivel || documentos.motivoIndisponivel(a) });
          continue;
        }

        itens.push({ solicitacaoId: a.solicitacao_id, pasta, nome, tamanho: a.tamanho, url: a.url });
      }

      // ---- Anexos ANTIGOS, do Microsoft Forms ----
      //
      // Ficam no SharePoint e o navegador NÃO consegue baixá-los: exigem
      // autenticação M365 e a requisição bateria em CORS. Mas ignorá-los faria
      // a exportação de um cadastro antigo devolver nada, sem explicar por quê.
      // Então vão como LISTA DE LINKS, que o analista abre logado no M365.
      const legados = [];
      for (const id of ids.map(Number).filter(Number.isInteger)) {
        const s = await dados.buscarPorId(id);
        if (!s || !Array.isArray(s.anexos) || !s.anexos.length) continue;
        legados.push({
          solicitacaoId: id,
          solicitante: s.solicitante_email,
          criadoEm: s.criado_em,
          assunto: s.assunto,
          arquivos: s.anexos.filter((a) => a && a.url).map((a) => ({ nome: a.nome, url: a.url })),
        });
      }

      res.json({
        ok: true,
        total: itens.length,
        itens,
        indisponiveis,
        legados,
        totalLegados: legados.reduce((n, l) => n + l.arquivos.length, 0),
      });
    })
  );
}

// --------------------------------------------------------------------------
// PERGUNTAS (campos) do formulário
//
// Incluir e editar é de quem opera o painel (exigirConfigurarFormulario);
// EXCLUIR é só do admin, mais abaixo.
//
// A configuração vale para os três módulos, mas quem se DESENHA a partir dela
// hoje é só a tela genérica (agregado, candidato). O módulo terceiro ainda tem
// formulário escrito à mão em views/cadastro.html — editar um rótulo dele aqui
// muda o painel e a validação, não a tela que o time preenche.
// --------------------------------------------------------------------------
app.post(
  '/api/admin/perguntas',
  exigirLogin,
  exigirConfigurarFormulario,
  wrap(async (req, res) => {
    const { modulo, rotulo, tipo, secao, obrigatorio, opcoes, maxTamanho, escopo } = req.body || {};
    const r = await configFormulario.criarPergunta({
      modulo: modulo || 'agregado',
      rotulo,
      tipo,
      secao,
      obrigatorio: !!obrigatorio,
      opcoes,
      maxTamanho,
      escopo,
    });
    if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    res.status(201).json(r);
  })
);

// Nova ordem das perguntas de um módulo (a lista completa de ids, na ordem).
app.post(
  '/api/admin/perguntas/ordem',
  exigirLogin,
  exigirConfigurarFormulario,
  wrap(async (req, res) => {
    const { modulo, ids } = req.body || {};
    const r = await configFormulario.reordenarPerguntas(modulo, ids);
    if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    res.json(r);
  })
);

app.patch(
  '/api/admin/perguntas/:id',
  exigirLogin,
  exigirConfigurarFormulario,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const b = req.body || {};
    const r = await configFormulario.atualizarPergunta(id, {
      rotulo: b.rotulo,
      obrigatorio: b.obrigatorio,
      ativo: b.ativo,
      tipo: b.tipo,
      secao: b.secao,
      opcoes: b.opcoes,
      maxTamanho: b.maxTamanho,
      ordem: b.ordem,
      escopo: b.escopo,
    });
    if (!r.ok) {
      return res.status(r.naoEncontrada ? 404 : 400).json({ ok: false, erro: r.erro });
    }
    res.json({ ok: true });
  })
);

// --------------------------------------------------------------------------
// EXCLUSÕES na configuração — somente admin
//
// Excluir é diferente de desativar: desativar tira do formulário e volta com
// um clique; excluir apaga a configuração para sempre. Em nenhum dos casos as
// solicitações já enviadas são alteradas.
// --------------------------------------------------------------------------
app.delete(
  '/api/admin/operacoes/:id',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });
    const r = await configFormulario.excluirOperacao(id);
    if (!r.ok) return res.status(404).json({ ok: false, erro: r.erro || 'Não foi possível excluir.' });
    res.json({ ok: true, nome: r.nome });
  })
);

app.delete(
  '/api/admin/documentos/:id',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });
    const r = await configFormulario.excluirDocumento(id);
    if (!r.ok) return res.status(404).json({ ok: false, erro: r.erro || 'Não foi possível excluir.' });
    res.json({ ok: true, rotulo: r.rotulo });
  })
);

app.delete(
  '/api/admin/perguntas/:id',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });
    const r = await configFormulario.excluirPergunta(id);
    if (!r.ok) return res.status(404).json({ ok: false, erro: r.erro || 'Não foi possível excluir.' });
    res.json({ ok: true, rotulo: r.rotulo });
  })
);

// --------------------------------------------------------------------------
// Cadastro pelo formulário NATIVO do Portal
//
// O corpo é revalidado aqui com o MESMO módulo usado no navegador. A validação
// do front é conveniência (feedback imediato); esta é a que vale — qualquer um
// pode enviar um POST direto, sem passar pela tela.
//
// O solicitante NÃO vem do corpo: é sempre quem está logado. Assim ninguém
// registra cadastro em nome de outra pessoa.
//
// RESTRITO A ADMIN, junto com a página /cadastro — não basta esconder o botão:
// sem esta restrição, qualquer solicitante poderia gravar chamando a API direto.
// --------------------------------------------------------------------------
app.post(
  '/api/cadastros',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const resultado = await cadastros.validarECriar(req.body || {}, {
      nome: req.session.usuario.nome,
      email: req.session.usuario.email,
    });

    if (!resultado.ok) {
      return res.status(400).json({ ok: false, erros: resultado.erros });
    }

    res.status(201).json({ ok: true, id: resultado.id });
  })
);

/**
 * Remove o resultado da pesquisa RDO de uma solicitação.
 *
 * A SITUAÇÃO continua: quem conduz o cadastro precisa saber que ele está
 * parado ou encerrado, senão fica cobrando um andamento que não vai vir. O que
 * sai é o CONTEÚDO — se aprovou, quem respondeu, a observação e o comprovante.
 */
function semRdo(s) {
  const copia = { ...s };
  copia.rdo = { aprovado: null, por: null, em: null, obs: null, restrito: true };
  return copia;
}

// Solicitações do próprio usuário, de TODOS os módulos a que ele tem acesso.
//
// Junta os módulos em uma lista só, cada linha marcada com o módulo de origem —
// para o agregado e o candidato acompanharem o que enviaram sem precisar de uma
// tela por módulo.
app.get(
  '/api/minhas-solicitacoes',
  exigirLogin,
  wrap(async (req, res) => {
    const u = req.session.usuario;
    const slugs = papeis.formulariosDoPapel(u.papel);

    const porModulo = await Promise.all(
      slugs.map(async (slug) => {
        const dados = dadosDe(slug);
        const modulo = acharModulo(slug);
        if (!dados || !modulo) return [];
        const linhas = await dados.listarPorEmail(u.email);
        return linhas.map((s) => ({
          ...s,
          modulo: slug,
          moduloRotulo: modulo.rotuloCurto,
        }));
      })
    );

    // Mais recentes primeiro, misturando os módulos.
    const lista = porModulo.flat().sort((a, b) => {
      const d = String(b.criado_em).localeCompare(String(a.criado_em));
      return d !== 0 ? d : b.id - a.id;
    });

    // O RESULTADO do RDO não é do solicitante — é conferência interna sobre
    // ele mesmo. Esta rota devolvia a resposta inteira (aprovou, quem, quando,
    // a observação): a tela não mostrava, mas o dado viajava e aparecia no
    // inspetor do navegador. A SITUAÇÃO continua, para ele saber que o cadastro
    // está parado ou encerrado.
    const podeVerRdo = papeis.podeRdo(u.papel);
    const visiveis = podeVerRdo ? lista : lista.map(semRdo);

    res.json({ ok: true, podeVerRdo, solicitacoes: visiveis });
  })
);

// --------------------------------------------------------------------------
// API GENÉRICA DOS MÓDULOS
//
// Um conjunto de rotas por módulo, geradas do registro. O módulo terceiro tem
// as rotas antigas (/api/solicitacoes, /api/cadastros), que continuam
// funcionando — as genéricas abaixo servem os módulos novos e qualquer um que
// venha depois, sem escrever rota nova.
//
// A permissão é resolvida na REGISTRO (exigirFormulario/exigirPainel com o slug
// fixo), não em tempo de requisição: não há como pedir dados de um módulo
// passando outro slug na URL.
// --------------------------------------------------------------------------
for (const m of MODULOS) {
  const base = `/api/modulos/${m.slug}/solicitacoes`;
  const dados = dadosDe(m.slug);

  // ---- Leitura do painel ----
  app.get(
    base,
    exigirLogin,
    exigirPainel(m.slug),
    wrap(async (req, res) => {
      const [resumo, lista, anexos] = await Promise.all([
        dados.contarPorStatus(),
        dados.listar(),
        documentos.contarPorSolicitacao(m.slug),
      ]);

      const porAtendimento = await atendimentos.resumoDeVarias(m.slug, lista.map((s) => s.id));

      // O RESULTADO do RDO é de quem ACOMPANHA o painel, e o filtro é feito
      // AQUI, não na tela: esconder no HTML deixaria o dado viajando na
      // resposta, visível a quem abrisse o inspetor do navegador.
      const podeVerRdo = m.temRdo && papeis.podeRdo(req.session.usuario.papel, m.slug);

      // A SITUAÇÃO vem montada do servidor (src/fluxo.js) para não existir uma
      // segunda tabela de nomes na tela, envelhecendo por conta própria.
      const comComprovante = m.temRdo
        ? await documentos.idsComTipo(m.slug, fluxo.DOC_RDO)
        : new Set();

      // Módulo sem RDO não ganha "situacao": o status simples já diz tudo, e
      // anunciar uma etapa que não existe seria inventar processo. Hoje os
      // três módulos passam pelo RDO, mas a condição fica — ela é o que
      // permite criar um módulo sem essa etapa sem mexer aqui.
      const visiveis = !m.temRdo
        ? lista
        : lista.map((s) => {
            const at = porAtendimento[s.id];
            return {
              ...s,
              situacao: fluxo.situacaoSimplesDe({
                rdoAprovado: s.rdo ? s.rdo.aprovado : null,
                status: s.status,
                assumido: !!(at && at.emAtendimento),
              }),
              rdo: podeVerRdo
                ? { ...s.rdo, temComprovante: comComprovante.has(Number(s.id)) }
                : { aprovado: null, por: null, em: null, obs: null, restrito: true },
            };
          });

      res.json({
        ok: true,
        modulo: m.slug,
        temRdo: !!m.temRdo,
        podeVerRdo,
        resumo,
        solicitacoes: visiveis,
        // Quantos anexos cada solicitação tem — o painel usa para o marcador
        // na lista e para o usuário saber o que a exportação vai trazer.
        anexos,
        podeExcluir: papeis.ehAdmin(req.session.usuario.papel),
        usuarioId: req.session.usuario.id,
        // Quem está cuidando de cada cadastro, para a coluna "Em atendimento".
        atendimentos: porAtendimento,
        // Estado do teste prático de cada cadastro, para o ícone da linha.
        // Devolve {} sem ir ao banco nos módulos que não têm teste.
        testes: await testePratico.resumoDeVarias(m.slug, lista.map((s) => s.id)),
      });
    })
  );

  // ---- Teste prático de direção ----
  //
  // REGISTRADAS SÓ PARA O MÓDULO QUE TEM TESTE. Não é um "if" dentro do
  // handler: para agregado e terceiro estas rotas simplesmente NÃO EXISTEM, e
  // trocar o slug na URL devolve 404 — que é a regra "o teste só existe para
  // candidato" valendo também para quem monta a requisição na mão.
  //
  // Quem preenche é quem ACOMPANHA o painel (exigirPainel). O candidato não
  // lê a própria avaliação: é julgamento interno sobre ele, e a rota de
  // detalhe também o deixa de fora (ver /detalhe, acima).
  if (testePratico.permite(m.slug)) {
    app.get(
      `${base}/:id/teste`,
      exigirLogin,
      exigirPainel(m.slug),
      wrap(async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

        const solicitacao = await dados.buscarPorId(id);
        if (!solicitacao) {
          return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
        }

        res.json({
          ok: true,
          // A ficha (critérios, conceitos, resultados) vem do servidor para a
          // tela não manter uma segunda cópia da lista, que envelheceria
          // separada da validação que cobra o preenchimento.
          config: testePratico.configuracao(),
          teste: await testePratico.atual(m.slug, id),
          // Tentativas anteriores. Hoje sempre no máximo uma; a estrutura
          // existe para o reteste não exigir migração depois.
          historico: await testePratico.historico(m.slug, id),
        });
      })
    );

    app.post(
      `${base}/:id/teste`,
      exigirLogin,
      exigirPainel(m.slug),
      wrap(async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

        const solicitacao = await dados.buscarPorId(id);
        if (!solicitacao) {
          return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
        }

        // O avaliador vem SEMPRE da sessão, nunca do corpo — ninguém assina
        // uma avaliação em nome de outra pessoa.
        const r = await testePratico.salvar(m.slug, id, req.body || {}, req.session.usuario);
        if (!r.ok) return res.status(400).json(r);
        res.json(r);
      })
    );
  }

  // ---- Impressão digital, para a atualização automática ----
  app.get(
    `${base}/versao`,
    exigirLogin,
    exigirPainel(m.slug),
    wrap(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ ok: true, ...(await dados.versao()) });
    })
  );

  // ---- Criação ----
  // Só para os módulos SEM API própria: o terceiro grava por /api/cadastros,
  // que preenche também as tabelas estruturadas. Expor a rota genérica nele
  // permitiria criar solicitação sem passar pela validação do módulo.
  if (!m.apiPropria) {
    app.post(
      base,
      exigirLogin,
      exigirFormulario(m.slug),
      wrap(async (req, res) => {
        const b = req.body || {};

        // ---- Campos, validados pela especificação de src/campos.js ----
        // A validação do navegador é conveniência; esta é a que vale — dá para
        // enviar um POST direto, sem passar pela tela.
        const cfgForm = await configFormulario.paraFormulario(m.slug);
        const { ok, dados: valores, erros } = campos.validarSecoes(cfgForm.secoes, b);

        // ---- Operações (clientes) ----
        // Cada módulo define quais oferece; candidato não usa nenhuma.
        const cfg = cfgForm;
        let operacoes = [];

        if (cfg.operacoes.length) {
          const enviadas = Array.isArray(b.operacoes) ? b.operacoes : [];
          const permitidas = cfg.operacoes.map((o) => o.toUpperCase());
          const vistas = new Set();

          for (const item of enviadas) {
            const nome = String(item || '').trim().toUpperCase();
            if (!nome || vistas.has(nome)) continue;
            if (!permitidas.includes(nome)) {
              erros.operacoes = `Operação não disponível neste formulário: "${nome}".`;
              break;
            }
            vistas.add(nome);
            operacoes.push(nome);
          }

          if (!erros.operacoes && cfg.operacoesObrigatorias && operacoes.length === 0) {
            erros.operacoes = 'Selecione pelo menos um cliente.';
          }
        }

        if (!ok || Object.keys(erros).length) {
          return res.status(400).json({ ok: false, erros });
        }

        // ---- Blacklist Geomed ----
        // Aqui os campos são criados na tela de configuração e não têm nome
        // fixo, então quem procura o documento do proprietário é a própria
        // blacklist (ver verificarRespostas): campo que fale de proprietário e
        // contenha CPF ou CNPJ válido.
        const barrado = await blacklist.verificarRespostas(valores);
        if (barrado.bloqueado) {
          return res.status(400).json({
            ok: false,
            erros: { [barrado.campo]: blacklist.mensagemDeBloqueio(barrado.registro) },
          });
        }

        // O resumo aparece na lista do painel; os detalhes, no formato
        // "Rótulo: valor | ..." que as telas já sabem exibir campo a campo.
        const detalhes = [
          operacoes.length ? `Operações: ${operacoes.join(', ')}` : null,
          campos.detalhesDeSecoes(cfgForm.secoes, valores),
        ]
          .filter(Boolean)
          .join(' | ');

        // O solicitante vem SEMPRE da sessão, nunca do corpo — ninguém envia
        // solicitação em nome de outra pessoa.
        const criada = await dados.criar({
          solicitante_nome: req.session.usuario.nome,
          solicitante_email: req.session.usuario.email,
          assunto: campos.resumoDe(m.slug, valores),
          detalhes,
          dados: { ...valores, operacoes },
          origem: 'portal',
        });

        res.status(201).json({ ok: true, id: criada.id });
      })
    );
  }

  // ---- Pesquisa RDO, nos módulos que passam por ela ----
  //
  // Mesma regra do terceiro: reprovar exige o comprovante JÁ ANEXADO e o
  // MOTIVO escrito, e a conferência é feita no servidor. Um "reprovado"
  // gravado sem prova é exatamente o registro que falta quando alguém audita
  // meses depois.
  //
  // A rota só existe onde a etapa existe. Hoje os três módulos passam pelo
  // RDO; num módulo criado sem ela, a rota simplesmente não é registrada, e
  // não há como chamá-la por engano nem de propósito.
  if (m.temRdo) {
    app.post(
      `${base}/:id/rdo`,
      exigirLogin,
      exigirPainel(m.slug),
      wrap(async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

        const { aprovado, observacao } = req.body || {};
        if (aprovado !== true && aprovado !== false) {
          return res.status(400).json({ ok: false, erro: 'Responda se o RDO foi aprovado.' });
        }

        // O comprovante é procurado entre os documentos já enviados: o upload
        // usa o mesmo caminho de qualquer outro anexo, então não há um fluxo
        // especial para manter e o arquivo já nasce no histórico do cadastro.
        const docs = await documentos.listar(m.slug, id);
        const temComprovante = docs.some((d) => fluxo.ehRdo(d.tipo));

        const r = await dados.registrarRdo(id, {
          aprovado,
          observacao,
          por: req.session.usuario.nome,
          temComprovante,
        });

        if (!r.ok) return res.status(409).json(r);
        res.json(r);
      })
    );

    // ---- Desfazer a resposta do RDO ----
    //
    // Mesma razão do terceiro: os dois botões gravam no primeiro clique, e
    // sem isto o engano só se desfazia no banco. Permissão igual à de
    // responder — quem errou corrige sozinho.
    app.delete(
      `${base}/:id/rdo`,
      exigirLogin,
      exigirPainel(m.slug),
      wrap(async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

        const r = await dados.desfazerRdo(id, { por: req.session.usuario.nome });
        if (!r.ok) return res.status(409).json(r);
        res.json(r);
      })
    );
  }

  // ---- Decisão do responsável ----
  app.post(
    `${base}/:id/decisao`,
    exigirLogin,
    exigirPainel(m.slug),
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ ok: false, erro: 'Id inválido.' });
      }
      const { status, observacao } = req.body || {};
      if (!['aprovado', 'reprovado'].includes(status)) {
        return res.status(400).json({ ok: false, erro: 'Status inválido.' });
      }

      const atualizada = await dados.registrarDecisao(id, {
        status,
        observacao,
        revisadoPor: req.session.usuario.nome,
      });
      // 409: o pedido faz sentido, mas o processo não está nesse ponto — é o
      // caso de decidir antes de responder o RDO. Distinguir de 404 importa
      // para a tela dizer o que fazer em vez de "não encontrado".
      if (atualizada && atualizada.erro) {
        return res.status(409).json({ ok: false, erro: atualizada.erro });
      }
      if (!atualizada) {
        return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
      }
      res.json({ ok: true, solicitacao: atualizada });
    })
  );

  // ---- Exclusão — somente admin ----
  app.delete(
    `${base}/:id`,
    exigirLogin,
    exigirAdmin,
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) {
        return res.status(400).json({ ok: false, erro: 'Id inválido.' });
      }
      const removido = await dados.excluir(id);
      if (!removido) {
        return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
      }
      res.json({ ok: true });
    })
  );
}

// Registra a decisão (aprovar / reprovar) — apenas responsável/admin.
app.post(
  '/api/solicitacoes/:id/decisao',
  exigirLogin,
  exigirPainel('terceiro'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { status, observacao } = req.body;

    if (!['aprovado', 'reprovado'].includes(status)) {
      return res.status(400).json({ ok: false, erro: 'Status inválido.' });
    }

    const atualizada = await solicitacoes.registrarDecisao(id, {
      status,
      observacao,
      revisadoPor: req.session.usuario.nome,
    });

    if (!atualizada) {
      return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
    }

    res.json({ ok: true, solicitacao: atualizada });
  })
);

// Decisão de UM cliente/operação da solicitação (aprovar/reprovar individual).
app.post(
  '/api/solicitacoes/:id/cliente-decisao',
  exigirLogin,
  exigirPainel('terceiro'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { cliente, status, observacao } = req.body;

    if (!cliente || !String(cliente).trim()) {
      return res.status(400).json({ ok: false, erro: 'Cliente não informado.' });
    }
    // 'pendente' é o LIMPAR: desfaz a decisão e devolve o cliente à fila.
    // Decisão tomada por engano acontece, e sem isso a correção só sairia
    // mexendo no banco na mão.
    if (!['aprovado', 'reprovado', 'pendente'].includes(status)) {
      return res.status(400).json({ ok: false, erro: 'Status inválido.' });
    }

    const atualizada = await solicitacoes.registrarDecisaoCliente(id, {
      cliente,
      status,
      observacao,
      revisadoPor: req.session.usuario.nome,
    });

    if (atualizada && atualizada.erro) {
      // 409: o pedido faz sentido, mas o processo não está nesse ponto ainda.
      return res.status(409).json({ ok: false, erro: atualizada.erro });
    }
    if (!atualizada) {
      return res.status(404).json({ ok: false, erro: 'Solicitação ou cliente não encontrado.' });
    }
    res.json({ ok: true, solicitacao: atualizada });
  })
);

// Aplica a mesma decisão a TODOS os clientes (Aprovar todos / Reprovar todos).
app.post(
  '/api/solicitacoes/:id/decisao-todos',
  exigirLogin,
  exigirPainel('terceiro'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    const { status, observacao } = req.body;

    if (!['aprovado', 'reprovado'].includes(status)) {
      return res.status(400).json({ ok: false, erro: 'Status inválido.' });
    }

    const atualizada = await solicitacoes.registrarDecisaoTodos(id, {
      status,
      observacao,
      revisadoPor: req.session.usuario.nome,
    });

    if (atualizada && atualizada.erro) {
      return res.status(409).json({ ok: false, erro: atualizada.erro });
    }
    if (!atualizada) {
      return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
    }
    res.json({ ok: true, solicitacao: atualizada });
  })
);

// --------------------------------------------------------------------------
// Pesquisa RDO — a etapa que vem ANTES das gerenciadoras
//
// Reprovar exige o comprovante JÁ ANEXADO. A conferência é feita aqui, e não
// só na tela: um "reprovado" gravado sem prova é exatamente o registro que
// falta quando alguém audita a decisão meses depois.
// --------------------------------------------------------------------------
app.post(
  '/api/solicitacoes/:id/rdo',
  exigirLogin,
  // Quem ACOMPANHA o painel responde a pesquisa RDO — antes era só admin, e
  // isso deixava o responsável travado: ele via a pendência e não tinha como
  // resolvê-la. O middleware vem DEPOIS de exigirLogin para quem não está
  // logado receber 401, e não 403 — a diferença importa para o front decidir
  // entre mandar para o login ou avisar sem permissão.
  exigirPainel('terceiro'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const { aprovado, observacao } = req.body || {};
    if (aprovado !== true && aprovado !== false) {
      return res.status(400).json({ ok: false, erro: 'Responda se o RDO foi aprovado.' });
    }

    // O comprovante é procurado entre os documentos já enviados — o upload usa
    // o mesmo caminho de qualquer outro anexo, então não há um fluxo especial
    // para manter, e o arquivo já nasce visível no histórico do cadastro.
    const docs = await documentos.listar('terceiro', id);
    const temComprovante = docs.some((d) => fluxo.ehRdo(d.tipo));

    const r = await solicitacoes.registrarRdo(id, {
      aprovado,
      observacao,
      por: req.session.usuario.nome,
      temComprovante,
    });

    if (!r.ok) return res.status(409).json(r);
    res.json(r);
  })
);

// ---- Desfazer a resposta do RDO ----
//
// "RDO aprovado?" grava no primeiro clique, sem confirmação — é um par de
// botões, e errar o lado é fácil. Sem esta rota o engano não tinha conserto
// pela tela: o cadastro seguia liberado para as gerenciadoras (ou encerrado)
// e só um UPDATE no banco desfazia.
//
// Mesma permissão de quem RESPONDE a pesquisa: quem errou o próprio clique
// corrige sozinho. Restringir a admin faria o responsável parar o trabalho
// para procurar alguém por causa de um clique torto.
app.delete(
  '/api/solicitacoes/:id/rdo',
  exigirLogin,
  exigirPainel('terceiro'),
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const r = await solicitacoes.desfazerRdo(id, { por: req.session.usuario.nome });
    if (!r.ok) return res.status(409).json(r);
    res.json(r);
  })
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
//     "solicitante_email": "fulano@jomedlog...",   (obrigatório)
//     "assunto":           "Cadastro de ...",       (obrigatório)
//     "solicitante_nome":  "Fulano de Tal",        (opcional — cai p/ o e-mail)
//     "detalhes":          "texto livre",           (opcional)
//     "anexo":             "https://.../arquivo",   (opcional — link na nuvem)
//     "origem_id":         "id-da-resposta-forms"   (opcional, evita duplicar)
//   }
// Qualquer campo cujo nome comece com "anexo" (ex.: "anexo cnh",
// "anexo placa 1") é reunido na lista de documentos. O valor de cada um pode
// ser um link, texto, ou o JSON do campo de upload do Microsoft Forms.
// --------------------------------------------------------------------------
app.post(
  '/api/forms/webhook',
  express.json({ type: () => true, strict: false, verify: capturarRaw }),
  wrap(async (req, res) => {
    // O express.json acima (type: () => true) garante que o corpo seja lido como
    // JSON mesmo que o Power Automate não envie o cabeçalho Content-Type.
    const segredoEsperado = process.env.FORMS_WEBHOOK_SECRET;

    if (!segredoEsperado) {
      return res
        .status(503)
        .json({ ok: false, erro: 'Webhook não configurado (defina FORMS_WEBHOOK_SECRET no .env).' });
    }

    // Comparação em TEMPO CONSTANTE. Com "!==", o tempo de resposta cresce
    // conforme o número de caracteres iniciais que já batem, e isso permite
    // descobrir o segredo caractere a caractere sem nunca acertá-lo inteiro.
    // timingSafeEqual gasta o mesmo tempo em qualquer caso.
    if (!segredoConfere(req.get('x-webhook-secret'), segredoEsperado)) {
      return res.status(401).json({ ok: false, erro: 'Segredo inválido.' });
    }

    // Normaliza o corpo: alguns fluxos do Power Automate enviam o JSON como
    // TEXTO (string) em vez de objeto. Nesse caso, o req.body vem como string —
    // então reinterpretamos como JSON aqui para não "perder" os campos.
    let b = req.body || {};
    if (typeof b === 'string') {
      try {
        b = JSON.parse(b);
      } catch {
        b = {};
      }
    }
    if (typeof b !== 'object' || b === null) b = {};

    const solicitante_email = String(b.solicitante_email || '').trim();
    const assunto = String(b.assunto || '').trim();
    let solicitante_nome = String(b.solicitante_nome || '').trim();

    // Obrigatórios: e-mail e assunto. O nome é opcional — se não vier, usamos a
    // parte antes do "@" do e-mail (o Forms nem sempre coleta o nome de quem responde).
    if (!solicitante_email || !assunto) {
      // O diagnóstico vai para o LOG, não para a resposta: o corpo cru do
      // Forms carrega dado de pessoa (nome, CPF, link de anexo), e devolvê-lo
      // ao chamador o entrega a quem disparou a requisição. No log ele fica
      // onde já se olha quando o fluxo do Power Automate quebra.
      console.warn('[webhook] campos obrigatórios ausentes:', {
        tipo_corpo: typeof req.body,
        chaves_recebidas: b && typeof b === 'object' ? Object.keys(b) : null,
        raw_tamanho: req.rawBody ? req.rawBody.length : 0,
        raw_amostra: (req.rawBody || '').slice(0, 400),
        content_type: req.get('content-type') || null,
      });

      return res.status(400).json({
        ok: false,
        erro: 'Campos obrigatórios ausentes: solicitante_email e assunto.',
        // O que chegou fica no log do servidor (Vercel > Logs), não aqui.
        chaves_recebidas: b && typeof b === 'object' ? Object.keys(b) : null,
      });
    }
    if (!solicitante_nome) {
      solicitante_nome = solicitante_email.split('@')[0] || solicitante_email;
    }

    // Reúne anexos de QUALQUER campo cujo nome comece com "anexo" — assim o fluxo
    // pode ter um campo por upload ("anexo cnh", "anexo placa 1", ...), além de
    // "anexo"/"anexos". Cada valor pode ser link, texto ou o JSON do Forms.
    let anexos = [];
    for (const [chave, valor] of Object.entries(b)) {
      if (/^anexo/i.test(chave)) {
        anexos = anexos.concat(solicitacoes.normalizarAnexos(valor));
      }
    }

    const { solicitacao, duplicada } = await solicitacoes.registrarDoForms({
      solicitante_nome,
      solicitante_email,
      assunto,
      detalhes: b.detalhes,
      anexos,
      origem_id: b.origem_id,
    });

    // ---- Blacklist Geomed ----
    // Aqui o cadastro NÃO é recusado, ao contrário do formulário do Portal, e
    // a diferença é de momento: quem responde o Forms já respondeu. Devolver
    // erro ao Power Automate faria a resposta desaparecer — nem chegaria ao
    // Portal, nem voltaria para quem preencheu. Então ela entra, já reprovada
    // e com o motivo escrito, e quem analisa vê o que aconteceu.
    //
    // O documento pode vir como campo próprio (fluxo novo) ou dentro do texto
    // de "detalhes" (o formato que o Forms produz hoje).
    const docProprietario =
      blacklist.normalizar(b.proprietario_documento) || blacklist.documentoDoTexto(b.detalhes);

    let bloqueado = false;
    if (!duplicada && docProprietario) {
      const barrado = await blacklist.verificar(docProprietario);
      if (barrado.bloqueado) {
        bloqueado = true;
        const r = barrado.registro;
        await solicitacoes.registrarDecisao(solicitacao.id, {
          status: 'reprovado',
          observacao:
            `BLOQUEADO — Blacklist Geomed. ${blacklist.tipoDe(r.documento)} ` +
            `${blacklist.formatar(r.documento)} bloqueado por ${r.bloqueado_por} em ${r.criado_em}. ` +
            `Motivo: ${r.motivo}`,
          revisadoPor: 'Blacklist Geomed',
        });
      }
    }

    // 200 mesmo quando duplicada: o Power Automate considera sucesso e não reenvia.
    res.json({ ok: true, duplicada, bloqueado, id: solicitacao.id });
  })
);

// --------------------------------------------------------------------------
// Tratamento de corpo JSON malformado (ex.: Power Automate quebrando o JSON
// ao injetar o campo de upload do Forms). Devolve mensagem clara em vez de erro.
// --------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ ok: false, erro: 'Corpo JSON inválido (verifique o campo de anexo no fluxo).' });
  }
  // Qualquer outro erro (ex.: falha ao falar com o banco): loga e devolve 500.
  console.error('Erro não tratado:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, erro: 'Erro interno.' });
});

// --------------------------------------------------------------------------
// Sobe o servidor SOMENTE quando executado direto (desenvolvimento local).
// No Vercel, este arquivo é apenas IMPORTADO (por api/index.js), então o
// listen não roda — o Vercel cuida de receber as requisições.
// --------------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  TRÁFEGO — Cadastro rodando em  http://localhost:${PORT}\n`);
  });
}

module.exports = app;
