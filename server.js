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
const express = require('express');
const session = require('express-session');
const SessaoStore = require('./src/session-store')(session);

const usuarios = require('./src/usuarios');
const solicitacoes = require('./src/solicitacoes');
const cadastros = require('./src/cadastros');
const configFormulario = require('./src/config-formulario');
const { MODULOS, acharModulo, rotaFormulario, rotaPainel } = require('./src/modulos');
const papeis = require('./src/papeis');
const { dadosDe } = require('./src/modulo-servico');
const { menuPara, menuDaConta } = require('./src/menu');
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

// --------------------------------------------------------------------------
// Middlewares base
// --------------------------------------------------------------------------
// Guarda o corpo cru (para diagnóstico do webhook).
function capturarRaw(req, res, buf) {
  req.rawBody = buf && buf.length ? buf.toString('utf8') : '';
}

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
  // Em produção o arquivo só muda com um deploy novo, então pode ser cacheado.
  res.set('Cache-Control', EM_PRODUCAO ? 'public, max-age=3600' : 'no-store');
  res.send(validacaoParaNavegador);
});

app.use(express.urlencoded({ extended: true })); // formulários HTML
app.use(express.json({ strict: false, verify: capturarRaw })); // requisições fetch (login via JS) — strict:false aceita corpo em string

app.use(
  session({
    store: new SessaoStore(),
    secret: process.env.SESSION_SECRET || 'segredo-de-desenvolvimento-troque-me',
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
app.post(
  '/api/login',
  wrap(async (req, res) => {
    const email = (req.body.email || '').trim();
    const senha = req.body.senha || '';

    if (!email || !senha) {
      return res.status(400).json({ ok: false, erro: 'Informe e-mail e senha.' });
    }

    const usuario = await usuarios.validarCredenciais(email, senha);
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

// Área do solicitante (formulário do Microsoft Forms embutido). Pertence ao
// fluxo de terceiro, então usa a mesma permissão do módulo.
app.get('/solicitante', exigirLogin, exigirFormulario('terceiro'), (req, res) => {
  res.sendFile(path.join(VIEWS, 'solicitante.html'));
});

// Acompanhamento das próprias solicitações, de todos os módulos liberados.
app.get('/minhas-solicitacoes', exigirLogin, (req, res) => {
  res.sendFile(path.join(VIEWS, 'minhas-solicitacoes.html'));
});

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

// --------------------------------------------------------------------------
// API de solicitações
// --------------------------------------------------------------------------

// Lista para o painel do responsável (com os indicadores).
app.get(
  '/api/solicitacoes',
  exigirLogin,
  exigirPainel('terceiro'),
  wrap(async (req, res) => {
    const [resumo, lista] = await Promise.all([
      solicitacoes.contarPorStatus(),
      solicitacoes.listar(),
    ]);
    res.json({
      ok: true,
      papel: req.session.usuario.papel, // o front usa para mostrar o botão de excluir só ao admin
      resumo,
      solicitacoes: lista,
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
app.get(
  '/api/config-formulario',
  exigirLogin,
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await configFormulario.paraFormulario()) });
  })
);

// Matriz completa (inclui itens desativados) — para a tela de administração.
app.get(
  '/api/admin/formulario',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await configFormulario.paraAdmin()) });
  })
);

// Cria uma operação (cliente novo).
app.post(
  '/api/admin/operacoes',
  exigirLogin,
  exigirAdmin,
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
  exigirAdmin,
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
  exigirAdmin,
  wrap(async (req, res) => {
    const { codigo, rotulo, temValidade } = req.body || {};
    const r = await configFormulario.criarDocumento({ codigo, rotulo, temValidade });
    if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    res.status(201).json(r);
  })
);

// Atualiza um documento: ativo, rótulo e/ou para quais operações ele vale.
app.patch(
  '/api/admin/documentos/:id',
  exigirLogin,
  exigirAdmin,
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
    if (typeof b.todas === 'boolean') {
      const ids = Array.isArray(b.operacaoIds) ? b.operacaoIds.map(Number).filter(Number.isInteger) : [];
      mexeu = (await configFormulario.definirOperacoesDoDocumento(id, { todas: b.todas, operacaoIds: ids })) || mexeu;
    }

    if (!mexeu) return res.status(404).json({ ok: false, erro: 'Documento não encontrado ou nada a alterar.' });
    res.json({ ok: true });
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

    res.json({ ok: true, solicitacoes: lista });
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
      const [resumo, lista] = await Promise.all([dados.contarPorStatus(), dados.listar()]);
      res.json({
        ok: true,
        modulo: m.slug,
        resumo,
        solicitacoes: lista,
        podeExcluir: papeis.ehAdmin(req.session.usuario.papel),
      });
    })
  );

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
        const assunto = String(b.assunto || '').trim();

        if (!assunto) {
          return res.status(400).json({
            ok: false,
            erros: { assunto: 'Informe um resumo da solicitação.' },
          });
        }

        // O solicitante vem SEMPRE da sessão, nunca do corpo — ninguém envia
        // solicitação em nome de outra pessoa.
        const criada = await dados.criar({
          solicitante_nome: req.session.usuario.nome,
          solicitante_email: req.session.usuario.email,
          assunto,
          detalhes: String(b.detalhes || '').trim() || null,
          dados: b.dados && typeof b.dados === 'object' ? b.dados : null,
          origem: 'portal',
        });

        res.status(201).json({ ok: true, id: criada.id });
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
    if (!['aprovado', 'reprovado'].includes(status)) {
      return res.status(400).json({ ok: false, erro: 'Status inválido.' });
    }

    const atualizada = await solicitacoes.registrarDecisaoCliente(id, {
      cliente,
      status,
      observacao,
      revisadoPor: req.session.usuario.nome,
    });

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

    if (!atualizada) {
      return res.status(404).json({ ok: false, erro: 'Solicitação não encontrada.' });
    }
    res.json({ ok: true, solicitacao: atualizada });
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

    if (req.get('x-webhook-secret') !== segredoEsperado) {
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
      return res.status(400).json({
        ok: false,
        erro: 'Campos obrigatórios ausentes: solicitante_email e assunto.',
        // Diagnóstico: mostra o que realmente chegou, para ajustar o fluxo.
        _debug: {
          tipo_corpo: typeof req.body,
          chaves_recebidas: b && typeof b === 'object' ? Object.keys(b) : null,
          raw_tamanho: req.rawBody ? req.rawBody.length : 0,
          raw_amostra: (req.rawBody || '').slice(0, 400),
          content_type: req.get('content-type') || null,
        },
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

    // 200 mesmo quando duplicada: o Power Automate considera sucesso e não reenvia.
    res.json({ ok: true, duplicada, id: solicitacao.id });
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
