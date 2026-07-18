# Integração Microsoft Forms → sistema (via Power Automate)

Este guia explica como fazer cada resposta do **Microsoft Forms** virar,
automaticamente, uma solicitação registrada no sistema (histórico +
painel do responsável). Os **documentos continuam no Microsoft 365** — o
sistema guarda apenas os dados e o **link** de cada anexo.

```
Pessoa preenche o Forms
        │
        ▼
Microsoft Forms (respostas + arquivos ficam na nuvem M365)
        │  gatilho "nova resposta"
        ▼
Power Automate  ──HTTP POST──►  /api/forms/webhook  ──►  banco do sistema
        (com o segredo)                                  (histórico + painel)
```

---

## Pré-requisitos

1. **O sistema precisa estar hospedado com uma URL pública** (https), porque
   a nuvem do Power Automate não alcança `localhost`. Ex.:
   `https://cadastro.jomedlog.com.br`
2. Você precisa ser **dona ou coautora** do formulário no Microsoft Forms.
3. Licença de **Power Automate** (normalmente já incluída no M365 empresarial).
   > ⚠️ A ação **HTTP** usada aqui é um *conector premium*. Se a sua licença
   > não tiver, veja a seção "Alternativa sem conector premium" no fim.
4. O segredo `FORMS_WEBHOOK_SECRET` definido no `.env` do servidor (o mesmo
   valor será colado no Power Automate).

---

## Passo 1 — Definir o segredo no servidor

No arquivo `.env` do servidor hospedado, defina um valor longo e aleatório:

```
FORMS_WEBHOOK_SECRET=<cole-aqui-um-valor-longo-e-aleatorio>
```

Para gerar um valor no PowerShell:

```powershell
[guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
```

Reinicie o servidor depois de alterar o `.env`. **Enquanto esse valor estiver
vazio, o webhook fica desligado** (responde 503) — de propósito, para ninguém
gravar solicitações anonimamente.

---

## Passo 2 — Criar o fluxo no Power Automate

1. Acesse <https://make.powerautomate.com> com a conta Microsoft da Jomed.
2. **Criar → Fluxo de nuvem automatizado**.
3. Nome: `Forms → Cadastro Tráfego`.
4. Gatilho: **"Quando uma nova resposta é enviada"** (Microsoft Forms).
   - Selecione o **formulário de cadastro** correto.
5. Adicione a ação **"Obter os detalhes da resposta"** (Microsoft Forms):
   - **Form Id**: o mesmo formulário.
   - **Response Id**: selecione o dinâmico *"Response Id"* do gatilho.

> Isso disponibiliza cada pergunta do formulário como um "campo dinâmico"
> para usar no próximo passo.

---

## Passo 3 — Enviar a resposta para o sistema (ação HTTP)

Adicione a ação **HTTP** e configure:

- **Método**: `POST`
- **URI**: `https://SEU-DOMINIO/api/forms/webhook`
- **Cabeçalhos (Headers)**:
  | Chave | Valor |
  |-------|-------|
  | `Content-Type` | `application/json` |
  | `x-webhook-secret` | *(o mesmo valor do `FORMS_WEBHOOK_SECRET`)* |
- **Corpo (Body)** — JSON. Substitua os `@{...}` pelos **campos dinâmicos**
  da ação "Obter os detalhes da resposta":

```json
{
  "solicitante_nome":  "@{outputs('Obter_os_detalhes_da_resposta')?['body/responder']}",
  "solicitante_email": "@{outputs('Obter_os_detalhes_da_resposta')?['body/responder']}",
  "assunto":           "<selecione a pergunta de assunto>",
  "detalhes":          "<selecione a pergunta de detalhes>",
  "anexo":             "<link do arquivo enviado>",
  "origem_id":         "@{triggerOutputs()?['body/resourceData/responseId']}"
}
```

Na prática, você não digita esses caminhos à mão — clica no campo e escolhe o
**valor dinâmico** correspondente na lista que o Power Automate mostra. O que
importa é o **nome de cada chave** do JSON (à esquerda), que o sistema espera:

| Chave (fixa) | O que colocar (dinâmico do Forms) | Obrigatório |
|---|---|---|
| `solicitante_nome` | Nome de quem respondeu | ✅ |
| `solicitante_email` | E-mail de quem respondeu | ✅ |
| `assunto` | Resposta da pergunta de assunto/tipo de cadastro | ✅ |
| `detalhes` | Resposta com as informações do cadastro | — |
| `anexo` | **Link** do arquivo enviado no Forms (fica no M365) | — |
| `origem_id` | Id da resposta do Forms (evita gravar duplicado) | recomendado |

> **Sobre o e-mail:** para a solicitação aparecer em "Minhas solicitações" da
> pessoa, o `solicitante_email` precisa ser **o mesmo e-mail com que ela faz
> login** no sistema. O ideal é o Forms estar configurado para **registrar
> automaticamente o e-mail** de quem responde (só para a organização).

> **Sobre o anexo:** quando o Forms tem upload de arquivo, o campo vem como uma
> lista com um `link` para o arquivo no OneDrive/SharePoint. Use esse `link`.
> Se houver mais de um arquivo, comece com o primeiro; dá para evoluir depois.

---

## Passo 4 — Salvar e testar

1. **Salvar** o fluxo.
2. Envie uma resposta de teste pelo formulário.
3. No Power Automate, veja o **histórico de execuções** do fluxo: a ação HTTP
   deve terminar com **status 200** e corpo `{"ok":true,...}`.
4. No sistema, abra o **painel do responsável** — a solicitação de teste deve
   estar lá.

Se a ação HTTP retornar:

| Código | Significado | O que fazer |
|--------|-------------|-------------|
| `401` | Segredo inválido | Confira se `x-webhook-secret` é idêntico ao `.env` |
| `503` | Webhook desligado | `FORMS_WEBHOOK_SECRET` não está definido no servidor |
| `400` | Faltou campo obrigatório | Confira `solicitante_nome`, `solicitante_email`, `assunto` |
| `200` + `"duplicada":true` | Resposta já registrada | Normal em reenvios; nada é duplicado |

---

## Testar sem hospedar (durante o desenvolvimento)

Como a nuvem não alcança o `localhost`, use o simulador incluso, que faz
exatamente o mesmo POST que o Power Automate faria:

```powershell
# terminal 1
npm start

# terminal 2
npm run testar-webhook
```

Rode duas vezes para ver a anti-duplicidade em ação (a 2ª responde
`"duplicada": true`).

---

## Alternativa sem conector premium (HTTP)

Se a licença não permitir a ação **HTTP**, o caminho mais comum é o fluxo
**gravar cada resposta numa lista do SharePoint ou numa planilha do Excel**
(conectores padrão) e o sistema ler dali periodicamente. Isso é mais trabalho
e fica para uma fase seguinte — o webhook (`/api/forms/webhook`) continua sendo
o método recomendado assim que a ação HTTP estiver disponível.

---

## Referência técnica do webhook

- **Rota:** `POST /api/forms/webhook`
- **Autenticação:** cabeçalho `x-webhook-secret` == `FORMS_WEBHOOK_SECRET`
- **Corpo:** JSON com as chaves da tabela acima
- **Respostas:** `200` (ok, com `duplicada: true|false` e `id`), `400`
  (campos faltando), `401` (segredo inválido), `503` (não configurado)
- **Anti-duplicidade:** baseada em `origem_id` (id da resposta do Forms)
