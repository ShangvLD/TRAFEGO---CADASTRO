# Roteiro — Conectar o Microsoft Forms ao sistema de Cadastro (Power Automate)

> **Para quem vai montar o fluxo.** Siga na ordem. Não precisa saber programar —
> é tudo clique e preencher campo. Tempo estimado: 15–20 min.

## O que vamos fazer

Fazer com que **cada resposta enviada no Microsoft Forms** seja registrada
automaticamente no sistema de Cadastro do Tráfego. Os arquivos anexados
continuam no Microsoft 365 (nada é copiado) — mandamos só os dados e o **link**
de cada anexo.

```
Pessoa responde o Forms  →  Power Automate  →  (HTTP POST)  →  sistema de Cadastro
```

---

## ⚠️ Antes de começar — pegue estas 3 informações

Preencha aqui (peça ao responsável pelo sistema):

| Informação | Valor |
|---|---|
| **URL do webhook** | `https://trafego-cadastro-production.up.railway.app/api/forms/webhook` |
| **Segredo (x-webhook-secret)** | *(enviado à parte — pedir ao Victor)* |
| **Qual formulário** | Formulário de cadastro do Tráfego |

Requisitos:
- Você precisa ser **dono ou coautor** do formulário no Microsoft Forms.
- Precisa ter licença de **Power Automate** (normalmente já vem no M365).
  A ação **HTTP** usada no Passo 4 é *premium* — se a sua conta não tiver, avise
  o responsável pelo sistema (há um caminho alternativo).

---

## Passo 1 — Criar o fluxo

1. Acesse **https://make.powerautomate.com** (conta Microsoft da empresa).
2. Menu à esquerda → **Criar** → **Fluxo de nuvem automatizado**.
3. **Nome do fluxo:** `Forms → Cadastro Tráfego`
4. No campo de gatilho, pesquise **Forms** e escolha
   **"Quando uma nova resposta é enviada"** → **Criar**.

## Passo 2 — Escolher o formulário

1. No bloco do gatilho, clique em **"ID do Formulário"**.
2. Selecione o **formulário de cadastro do Tráfego** na lista.

## Passo 3 — Obter os detalhes da resposta

1. Clique em **+ Nova etapa**.
2. Pesquise **Forms** → escolha **"Obter os detalhes da resposta"**.
3. **ID do Formulário:** o mesmo formulário do Passo 2.
4. **ID da Resposta:** clique no campo e escolha o valor dinâmico
   **"ID da Resposta"** (aparece com um raio ⚡, vem do gatilho).

## Passo 4 — Enviar para o sistema (ação HTTP)

1. Clique em **+ Nova etapa** → pesquise e escolha **HTTP**.
2. Preencha:

   - **Método:** `POST`
   - **URI:** cole a **URL do webhook** da tabela lá em cima.
   - **Cabeçalhos (Headers):** adicione duas linhas:

     | Chave | Valor |
     |-------|-------|
     | `Content-Type` | `application/json` |
     | `x-webhook-secret` | *(cole o **Segredo** da tabela lá em cima)* |

   - **Corpo (Body):** cole o texto abaixo. Onde estiver escrito
     `[[ escolher: ... ]]`, **apague o texto e clique no valor dinâmico**
     correspondente da lista (os campos vêm da etapa "Obter os detalhes"):

```json
{
  "solicitante_nome":  "[[ escolher: Nome de quem respondeu ]]",
  "solicitante_email": "[[ escolher: E-mail de quem respondeu ]]",
  "assunto":           "[[ escolher: pergunta de assunto / tipo de cadastro ]]",
  "detalhes":          "[[ escolher: pergunta com as informações do cadastro ]]",
  "anexo":             "[[ escolher: link do arquivo anexado ]]",
  "origem_id":         "[[ escolher: ID da Resposta ]]"
}
```

   > **Importante:** os **nomes à esquerda** (`solicitante_nome`, `assunto`...)
   > são fixos — **não mude**. Só troque o `[[ escolher: ... ]]` pelo campo
   > dinâmico certo. As 3 primeiras chaves são obrigatórias.

## Passo 5 — Salvar e testar

1. Clique em **Salvar**.
2. Abra o formulário e **envie uma resposta de teste**.
3. Volte ao Power Automate → **Histórico de execuções** (Run history) do fluxo.
4. A ação **HTTP** deve terminar com **status 200** e corpo começando com
   `{"ok":true`. ✅ Deu certo — a resposta já está no sistema.

---

## Se der erro na ação HTTP

| Código | O que significa | O que fazer |
|--------|-----------------|-------------|
| **401** | Segredo inválido | Confira se o valor de `x-webhook-secret` está **idêntico** ao segredo recebido (sem espaços). |
| **503** | Webhook desligado no servidor | Avise o responsável pelo sistema (falta configurar o segredo lá). |
| **400** | Faltou um campo obrigatório | Confira se `solicitante_nome`, `solicitante_email` e `assunto` estão preenchidos com um campo dinâmico. |
| **200** com `"duplicada":true` | Resposta já tinha sido registrada | Normal em reenvios — nada é duplicado. |
| Não achou o campo de e-mail | O Forms não está coletando o e-mail | Peça para o dono do formulário ativar o registro automático do e-mail de quem responde. |

---

## Detalhes que ajudam

- **E-mail:** para a pessoa ver a própria solicitação no sistema, o
  `solicitante_email` precisa ser o **mesmo e-mail de login** dela. O ideal é o
  Forms registrar automaticamente o e-mail de quem responde (só para a
  organização).
- **Anexo:** quando o Forms tem upload de arquivo, o campo dinâmico é uma lista
  com um **link** para o arquivo no OneDrive/SharePoint. Use esse link — o
  arquivo continua guardado na nuvem, o sistema só aponta para ele.

---

*Dúvidas sobre a URL ou o segredo: falar com o responsável pelo sistema de Cadastro.*
