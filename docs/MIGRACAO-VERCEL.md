# Migração Railway → Vercel + Turso

Guia passo a passo para colocar o sistema no Vercel (padrão dos parceiros),
usando o **Turso** (SQLite na nuvem) como banco — já que o disco do Vercel é
efêmero e não serve para banco de dados.

O **código já foi adaptado** (camada de dados assíncrona, sessão no banco,
entrada serverless em `api/index.js`, `vercel.json`). Falta a parte de
infraestrutura, que é o que este guia cobre.

> **Regra de ouro:** só desligue o Railway no final (Fase 5), depois de
> confirmar que o Vercel está funcionando e o Power Automate já aponta para lá.

---

## Fase 0 — Criar o banco no Turso (tudo pelo site, sem instalar nada)

1. Acesse **https://app.turso.tech** e crie a conta (pode entrar com o GitHub).
2. **Create Database** → nome `trafego-cadastro` → região mais próxima
   (ex.: `gru` / São Paulo, se disponível).
3. Na página do banco, copie os dois valores (guarde num bloco de notas):
   - **Database URL** → começa com `libsql://trafego-cadastro-....turso.io`
   - **Create Token** (aba *Tokens* ou botão *Generate Token*) → um texto longo.
     Esse é o `TURSO_AUTH_TOKEN`.

> O plano gratuito do Turso é folgado para este uso (bilhões de leituras/mês).

---

## Fase 1 — Enviar o código novo para o GitHub

O deploy do Vercel puxa do repositório `ShangvLD/TRAFEGO---CADASTRO`.
No terminal do projeto:

```powershell
git add -A
git commit -m "Migracao para Vercel + Turso (banco libSQL, serverless)"
git push
```

---

## Fase 2 — Popular o banco do Turso (usuários + histórico)

O banco novo começa **vazio**. Como você já ia limpar os registros de teste,
o caminho mais limpo é **recriar** os dados reais direto no Turso, usando os
scripts que já existem — sem precisar puxar o arquivo do Railway.

1. **Temporariamente**, aponte seu ambiente local para o Turso. No arquivo
   `.env` (na sua máquina), adicione as duas linhas com os valores da Fase 0:

   ```
   TURSO_DATABASE_URL=libsql://trafego-cadastro-....turso.io
   TURSO_AUTH_TOKEN=cole-o-token-aqui
   ```

2. Crie os usuários reais (um comando por pessoa):

   ```powershell
   npm run criar-usuario -- "Nome Completo" email@jomedlog.com.br SenhaForte papel
   ```
   `papel` = `solicitante`, `responsavel` ou `admin`.

3. (Opcional) Reimporte o histórico do Forms a partir do CSV — é idempotente,
   não duplica:

   ```powershell
   npm run importar -- caminho\do\arquivo.csv --confirmar
   ```

4. Confira o que entrou:

   ```powershell
   npm run consultar
   ```

5. **Volte o `.env` ao normal**: comente/remova as duas linhas `TURSO_...`
   para o desenvolvimento local voltar a usar o arquivo SQLite local.

> Prefere migrar o banco **exatamente** como está no Railway (com IDs e datas
> originais)? Veja o Apêndice A no fim deste guia.

---

## Fase 3 — Deploy no Vercel

1. Em **vercel.com**, clique em **Adicionar novo… → Projeto** (ou o card
   **Projeto de Importação → Importar**).
2. Escolha o repositório **TRAFEGO---CADASTRO** do GitHub.
3. Nas configurações do projeto, o Vercel detecta Node automaticamente.
   **Não precisa** mudar build command nem output — o `vercel.json` já roteia
   tudo para `api/index.js`.
4. Abra **Environment Variables** e cadastre as 4 variáveis (ambiente
   *Production* e também *Preview*, se quiser testar em branches):

   | Nome | Valor |
   |------|-------|
   | `TURSO_DATABASE_URL` | a URL `libsql://...` da Fase 0 |
   | `TURSO_AUTH_TOKEN`   | o token da Fase 0 |
   | `SESSION_SECRET`     | um texto longo e aleatório (novo) |
   | `FORMS_WEBHOOK_SECRET` | **o mesmo** segredo que você já usa hoje (está no seu `.env` local) |

   > `PORT` **não** é necessário no Vercel (ele gerencia isso sozinho).
   > `NODE_ENV=production` o Vercel já define automaticamente.

5. Clique em **Deploy**. Ao terminar, você recebe uma URL tipo
   `https://trafego-cadastro.vercel.app`.
6. Teste no navegador: abra a URL → deve cair na tela de **/login**. Faça login
   com um usuário real e confirme que o painel carrega.

---

## Fase 4 — Atualizar o Power Automate (a parte fácil)

No fluxo do Power Automate que envia as respostas do Forms:

1. Abra a ação **HTTP** (a que faz o POST do webhook).
2. Troque **apenas a URL**:
   - De: `https://SEU-APP.up.railway.app/api/forms/webhook`
   - Para: `https://trafego-cadastro.vercel.app/api/forms/webhook`
3. **Não mude mais nada**: o cabeçalho `x-webhook-secret` e o corpo JSON
   continuam idênticos.
4. Salve e rode um **teste do fluxo** (ou responda o Forms de propósito).
   Confira se a solicitação apareceu no painel do responsável no Vercel.

---

## Fase 5 — Verificar e desligar o Railway

Só depois que tudo acima estiver confirmado:

- [ ] Login/logout funcionando no Vercel
- [ ] Painel do responsável lista as solicitações e os indicadores
- [ ] Aprovar/reprovar uma solicitação funciona
- [ ] Uma nova resposta do Forms chega pelo webhook no Vercel
- [ ] (Opcional) Domínio próprio configurado no Vercel

Aí sim: no Railway, **pause/remova** o serviço para não gastar recurso à toa.
Sugestão: deixe pausado por alguns dias antes de excluir de vez.

---

## Dicas / solução de problemas

- **Login não gruda (fica pedindo login):** confira `SESSION_SECRET` e que o
  deploy é HTTPS (o Vercel é). O cookie usa `secure` só em produção — isso é
  automático via `NODE_ENV=production`.
- **500 nas rotas / "Erro interno":** quase sempre é `TURSO_DATABASE_URL` ou
  `TURSO_AUTH_TOKEN` errados/ausentes. Veja os logs em **Vercel → Deployments →
  (deploy) → Functions/Logs**.
- **Webhook responde 503:** faltou `FORMS_WEBHOOK_SECRET` nas variáveis do Vercel.
- **Webhook responde 401:** o segredo do Vercel está diferente do que o Power
  Automate envia. Devem ser idênticos.

---

## Apêndice A — Migrar o banco exato do Railway (opcional)

Se quiser trazer os dados **exatamente** como estão no Railway (mesmos IDs e
datas), em vez de recriar:

1. No Railway, abra o serviço → aba de **Volume/Console**, e gere um dump do
   banco (o arquivo fica em `DATA_DIR`, ex.: `/data/trafego.db`):
   ```bash
   sqlite3 /data/trafego.db .dump > dump.sql
   ```
   Baixe o `dump.sql`.
2. Instale a CLI do Turso (Windows via Scoop: `scoop install turso`, ou use o
   WSL) e rode:
   ```bash
   turso db shell trafego-cadastro < dump.sql
   ```
3. Rode `npm run consultar` (com o `.env` apontando ao Turso) para conferir.

> Observação: o dump inclui `CREATE TABLE`; se as tabelas já existirem (porque
> o app rodou antes), remova do `dump.sql` as linhas `CREATE TABLE`/`CREATE
> INDEX` e mantenha só os `INSERT`, ou comece com um banco Turso limpo.
