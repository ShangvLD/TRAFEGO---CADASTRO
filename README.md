# TRÁFEGO — Cadastro

Sistema interno da **Jomed** para solicitação e aprovação de cadastros de tráfego.
Possui login com dois perfis de acesso e identidade visual institucional.

## Perfis

| Perfil | O que faz |
| --- | --- |
| **Solicitante** | Faz login, preenche o formulário (Microsoft Forms) e acompanha suas solicitações. |
| **Responsável** | Faz login e revisa as solicitações (respostas + anexos), aprovando ou reprovando. |
| **Admin** | Controla os logins. |

## Stack

- **Node.js + Express** — servidor web e API.
- **PostgreSQL no Supabase** — banco de logins e solicitações, acessado pelo
  driver `pg` (100% JavaScript, sem dependência nativa).
- **express-session** com store próprio na tabela `sessoes` — sessão por cookie.
- **bcryptjs** — senhas criptografadas.
- Front-end em HTML/CSS puro (pasta `public` + `views`).

## Estrutura

| Caminho | Descrição |
| --- | --- |
| `server.js` | Servidor Express: rotas, sessão e proteção por perfil. |
| `src/db.js` | Conexão PostgreSQL (Supabase), criação do schema e tradução do SQL. |
| `src/usuarios.js` | Consultas de usuário e validação de senha. |
| `src/auth.js` | Middlewares de login e autorização por papel. |
| `src/session-store.js` | Store de sessão sobre o PostgreSQL. |
| `src/seed.js` | Cria usuários de teste (`npm run seed`). |
| `src/criar-usuario.js` | Cria um usuário via linha de comando. |
| `views/` | Páginas: `login.html`, `solicitante.html`, `responsavel.html`. |
| `public/` | CSS, imagens e JS do front-end. |

## Como rodar

```bash
npm install          # instala as dependências
cp .env.example .env # cria o arquivo de ambiente
                     # -> preencha DATABASE_URL (Supabase) e SESSION_SECRET
npm start            # sobe em http://localhost:3000
```

O banco é **sempre** o Supabase (não há mais banco em arquivo): sem
`DATABASE_URL` o app não sobe. A connection string sai do painel do Supabase em
**Connect > Connection string > Transaction pooler** — veja
[docs/MIGRACAO-SUPABASE.md](docs/MIGRACAO-SUPABASE.md).

> Requer **Node.js 22+**. Não precisa de admin: pode usar a versão portátil do Node.

## Controlando os logins

Enquanto não há tela de administração, os usuários são criados por comando:

```bash
npm run criar-usuario -- "Nome Completo" email@jomedlog.com.br senha papel
# papel: solicitante | responsavel | admin
```

## Status / próximos passos

- **Fase 1 (concluída):** login, banco de usuários, dois perfis e proteção de rotas.
- **Fase 2/3:** "Minhas solicitações" (solicitante) e painel de aprovação com dados reais.
- **Fase 4 (concluída):** integração Microsoft Forms → banco (via Power Automate).
- **Hospedagem:** **Vercel** (serverless) + **Supabase** (PostgreSQL).
  Guias: [docs/MIGRACAO-VERCEL.md](docs/MIGRACAO-VERCEL.md) (Railway → Vercel) e
  [docs/MIGRACAO-SUPABASE.md](docs/MIGRACAO-SUPABASE.md) (Turso → Supabase).

## Identidade visual

Azul institucional (`#005a9e`), layout limpo, tipografia Inter e cards bem definidos.
