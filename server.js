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
const campos = require('./src/campos');
const documentos = require('./src/documentos');
const atendimentos = require('./src/atendimentos');
const fluxo = require('./src/fluxo');
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
    const podeVerRdo = papeis.ehAdmin(u.papel);
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

    // O comprovante do RDO é restrito a admin, aqui como em qualquer lugar.
    let docs = await documentos.listar(m.slug, id);
    if (!papeis.ehAdmin(u.papel)) {
      docs = docs.filter((d) => String(d.tipo).toUpperCase() !== fluxo.DOC_RDO);
    }

    res.json({
      ok: true,
      solicitacao: papeis.ehAdmin(u.papel) ? s : semRdo(s),
      documentos: await documentos.comUrls(docs, {
        rotaDeDownload: (d) => `/api/modulos/${m.slug}/solicitacoes/${id}/documentos/${d.id}/baixar`,
      }),
      // Quem passou pelo cadastro, inclusive quem já saiu — é o histórico que
      // responde "com quem eu falo sobre isso" depois que a pessoa trocou.
      historico: await atendimentos.historico(m.slug, id),
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
    const [resumo, lista, anexos] = await Promise.all([
      solicitacoes.contarPorStatus(),
      solicitacoes.listar(),
      documentos.contarPorSolicitacao('terceiro'),
    ]);
    // O resultado do RDO é restrito a admin. Filtrar AQUI, e não só na tela:
    // esconder no HTML deixaria o dado viajando na resposta, visível a quem
    // abrisse o inspetor do navegador.
    const podeVerRdo = papeis.ehAdmin(req.session.usuario.papel);
    const visiveis = podeVerRdo ? lista : lista.map(semRdo);

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
app.get(
  '/api/config-formulario',
  exigirLogin,
  wrap(async (req, res) => {
    res.json({ ok: true, ...(await configFormulario.paraFormulario('terceiro')) });
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
  exigirAdmin,
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
    const { modulo, codigo, rotulo, temValidade, obrigatorio } = req.body || {};
    const r = await configFormulario.criarDocumento({
      modulo: modulo || 'terceiro',
      codigo,
      rotulo,
      temValidade,
      obrigatorio: obrigatorio !== false,
    });
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
    if (typeof b.obrigatorio === 'boolean') {
      mexeu = (await configFormulario.definirDocumentoObrigatorio(id, b.obrigatorio)) || mexeu;
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

for (const m of MODULOS) {
  const base = `/api/modulos/${m.slug}/solicitacoes/:id/documentos`;
  const dados = dadosDe(m.slug);

  /** Dono do cadastro: define o nome da pasta (NOME_CPF). */
  async function donoDaSolicitacao(id) {
    const s = await dados.buscarPorId(id);
    if (!s) return null;

    // Cada módulo guarda o condutor num lugar: o terceiro nas tabelas
    // estruturadas, os demais no JSON "dados".
    if (m.slug === 'terceiro') {
      const e = await cadastros.buscarPorSolicitacao(id);
      if (e) return { nome: e.condutor_nome, cpf: e.condutor_cpf };
      return { nome: s.solicitante_nome, cpf: '' };
    }
    const d = s.dados || {};
    return { nome: d.condutor_nome || s.solicitante_nome, cpf: d.condutor_cpf || d.cpf || '' };
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
    exigirAcessoAoModulo(m.slug),
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
    exigirAcessoAoModulo(m.slug),
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
    exigirAcessoAoModulo(m.slug),
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
    wrap(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      let lista = await documentos.listar(m.slug, id);

      // O comprovante da reprovação no RDO é parte do RDO, e o RDO é restrito
      // a admin. Sem esta linha, o arquivo apareceria na lista de anexos e o
      // resultado vazaria pelo nome do documento.
      if (!papeis.ehAdmin(req.session.usuario.papel)) {
        lista = lista.filter((d) => String(d.tipo).toUpperCase() !== fluxo.DOC_RDO);
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
    wrap(async (req, res) => {
      const docId = Number(req.params.docId);
      if (!Number.isInteger(docId)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const d = await documentos.buscarPorId(docId);
      if (!d || !d.caminho) return res.status(404).json({ ok: false, erro: 'Documento não encontrado.' });

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
    wrap(async (req, res) => {
      const docId = Number(req.params.docId);
      if (!Number.isInteger(docId)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

      const d = await documentos.buscarPorId(docId);
      if (!d) return res.status(404).json({ ok: false, erro: 'Documento não encontrado.' });

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
    wrap(async (req, res) => {
      const docId = Number(req.params.docId);
      if (!Number.isInteger(docId)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

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
// PERGUNTAS (campos) do formulário — somente admin
//
// Valem para os módulos que usam a tela genérica (agregado, candidato). O
// módulo terceiro tem formulário próprio, escrito à mão, e não é montado a
// partir desta configuração.
// --------------------------------------------------------------------------
app.post(
  '/api/admin/perguntas',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const { modulo, rotulo, tipo, secao, obrigatorio, opcoes } = req.body || {};
    const r = await configFormulario.criarPergunta({
      modulo: modulo || 'agregado',
      rotulo,
      tipo,
      secao,
      obrigatorio: !!obrigatorio,
      opcoes,
    });
    if (!r.ok) return res.status(400).json({ ok: false, erro: r.erro });
    res.status(201).json(r);
  })
);

app.patch(
  '/api/admin/perguntas/:id',
  exigirLogin,
  exigirAdmin,
  wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ ok: false, erro: 'Id inválido.' });

    const b = req.body || {};
    const mexeu = await configFormulario.atualizarPergunta(id, {
      rotulo: b.rotulo,
      obrigatorio: b.obrigatorio,
      ativo: b.ativo,
    });
    if (!mexeu) return res.status(404).json({ ok: false, erro: 'Pergunta não encontrada ou nada a alterar.' });
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
      const [resumo, lista, anexos] = await Promise.all([
        dados.contarPorStatus(),
        dados.listar(),
        documentos.contarPorSolicitacao(m.slug),
      ]);
      res.json({
        ok: true,
        modulo: m.slug,
        resumo,
        solicitacoes: lista,
        // Quantos anexos cada solicitação tem — o painel usa para o marcador
        // na lista e para o usuário saber o que a exportação vai trazer.
        anexos,
        podeExcluir: papeis.ehAdmin(req.session.usuario.papel),
        usuarioId: req.session.usuario.id,
        // Quem está cuidando de cada cadastro, para a coluna "Em atendimento".
        atendimentos: await atendimentos.resumoDeVarias(m.slug, lista.map((s) => s.id)),
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
  // Só admin responde a pesquisa RDO. exigirAdmin vem DEPOIS de exigirLogin
  // para quem não está logado receber 401, e não 403 — a diferença importa
  // para o front decidir entre mandar para o login ou avisar sem permissão.
  exigirAdmin,
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
    const temComprovante = docs.some((d) => String(d.tipo).toUpperCase() === fluxo.DOC_RDO);

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
