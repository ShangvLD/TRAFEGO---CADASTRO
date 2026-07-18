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
- **SQLite embutido** (`node:sqlite`, sem dependência nativa) — banco dos logins, em `/data`.
- **express-session** com store próprio em SQLite — sessão por cookie.
- **bcryptjs** — senhas criptografadas.
- Front-end em HTML/CSS puro (pasta `public` + `views`).

## Estrutura

| Caminho | Descrição |
| --- | --- |
| `server.js` | Servidor Express: rotas, sessão e proteção por perfil. |
| `src/db.js` | Conexão SQLite e criação do schema. |
| `src/usuarios.js` | Consultas de usuário e validação de senha. |
| `src/auth.js` | Middlewares de login e autorização por papel. |
| `src/session-store.js` | Store de sessão sobre o SQLite. |
| `src/seed.js` | Cria usuários de teste (`npm run seed`). |
| `src/criar-usuario.js` | Cria um usuário via linha de comando. |
| `views/` | Páginas: `login.html`, `solicitante.html`, `responsavel.html`. |
| `public/` | CSS, imagens e JS do front-end. |

## Como rodar

```bash
npm install          # instala as dependências
cp .env.example .env # cria o arquivo de ambiente (ajuste o SESSION_SECRET)
npm run seed         # cria os usuários de teste (rodar uma vez)
npm start            # sobe em http://localhost:3000
```

> Requer **Node.js 22.5+** (SQLite embutido). Não precisa de admin: pode usar a
> versão portátil do Node.

## Controlando os logins

Enquanto não há tela de administração, os usuários são criados por comando:

```bash
npm run criar-usuario -- "Nome Completo" email@jomedlog.com.br senha papel
# papel: solicitante | responsavel | admin
```

## Status / próximos passos

- **Fase 1 (concluída):** login, banco de usuários, dois perfis e proteção de rotas.
- **Fase 2/3:** "Minhas solicitações" (solicitante) e painel de aprovação com dados reais.
- **Fase 4:** integração Microsoft Forms → banco (via Power Automate).
- **Hospedagem:** a definir (Vercel + Turso, ou Azure para manter o dado na Microsoft).
  Em serverless (Vercel) o SQLite em arquivo não persiste — trocar por banco hospedado.

## Identidade visual

Azul institucional (`#005a9e`), layout limpo, tipografia Inter e cards bem definidos.
