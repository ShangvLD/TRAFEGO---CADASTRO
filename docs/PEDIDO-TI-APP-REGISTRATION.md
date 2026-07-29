# Solicitação ao TI — App Registration para o Portal de Cadastro

> **Para encaminhar ao administrador do Microsoft 365 / Entra ID da Jomed.**
> Texto pronto: pode copiar o conteúdo abaixo em um e-mail ou chamado.

---

## 📌 SITUAÇÃO EM 29/07/2026

O TI informou que a liberação vai **demorar**. Decisão tomada:

- **O Power Automate (premium) continua operando** até o fim do período de teste.
  Nada é migrado às pressas.
- O **formulário nativo** segue em uso paralelo, **sem upload de arquivo** — os
  dados entram validados pelo Portal, os documentos continuam indo pelo Forms.
- Quando o consentimento for concedido, o upload é ligado (é configuração, não
  reescrita: a estrutura no banco e a camada de dados já estão prontas).

⚠️ **Atenção ao prazo:** a licença Premium vence em ~90 dias (≈ out/2026). Se o
período de teste passar disso, o consentimento deixa de ser bloqueio apenas do
upload e passa a ser bloqueio do **webhook** — o caminho por onde as respostas
do Forms entram hoje. Revisar em setembro.

✅ **Não bloqueado pelo TI:** mover os 200 documentos do OneDrive pessoal para a
equipe usando um fluxo do Power Automate com **conectores gratuitos** e a
conexão do próprio usuário. Continua sendo o item mais urgente do plano.

---

## ⚡ O pedido ficou MUITO menor (29/07/2026)

O App Registration **já foi criado** por `victor.diniz@jomedlog.com.br`, que tem
permissão para registrar aplicativos. A permissão `Sites.Selected` **já foi
adicionada**, do tipo correto (Aplicativo).

**Falta uma única ação, que exige papel de administrador:** clicar em
**"Conceder consentimento do administrador"**.

| Item | Situação |
|---|---|
| App Registration `Portal-Cadastro-Trafego` | ✅ criado |
| Tipo: locatário único (somente Jomed) | ✅ configurado |
| Permissão `Sites.Selected` (Aplicativo) | ✅ adicionada |
| **Consentimento do administrador** | ⏳ **PENDENTE — é só isto** |
| Segredo do cliente | ⏳ depois do consentimento |
| Autorizar o app no site do canal GR | ⏳ depois do consentimento |

**Dados do app já criado:**

```
Nome:        Portal-Cadastro-Trafego
Client ID:   2a1d84dd-ca05-4841-8b8c-338f00f94f31
Tenant ID:   8f68facf-7252-415b-9a94-2e3ddc6551a2
Object ID:   7ce4cf90-64d1-41f3-b1bf-b40c3bcfb60a
```

**Link direto para a página do consentimento:**

```
https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/2a1d84dd-ca05-4841-8b8c-338f00f94f31
```

Quem pode conceder: `Administrador Global`, `Administrador de Aplicativos` ou
`Administrador de Aplicativos de Nuvem`.

> **Nota para quem vai conceder:** `Sites.Selected` é a permissão **mais
> restritiva** disponível para acesso ao SharePoint. Por si só ela **não dá
> acesso a nenhum site** — após o consentimento, o aplicativo ainda precisa ser
> autorizado site por site, individualmente. Foi escolhida deliberadamente em
> vez de `Sites.ReadWrite.All`, que daria ao app acesso a todo o SharePoint da
> organização (RH, jurídico, financeiro). O escopo pretendido é **um único
> site**: o do canal privado `GR` da equipe `TRAFEGO - MATRIZ`.

O restante deste documento é o contexto completo, caso seja útil.

---

## Assunto do pedido

Criação de um **App Registration** no Entra ID para o Portal de Cadastro do
Tráfego gravar documentos em uma biblioteca do SharePoint.

## Por que é necessário

O Portal de Cadastro (sistema interno do Tráfego, hospedado em
`trafego-cadastro.vercel.app`) vai passar a receber os cadastros de terceiros
por formulário próprio, substituindo o Microsoft Forms — cuja licença **Power
Automate Premium** vence em ~90 dias.

Os documentos enviados (CNH, ANTT, comprovante de residência, CRLV) precisam ser
gravados em uma biblioteca do SharePoint. Para isso o sistema precisa de uma
identidade de aplicação própria.

**Hoje esses documentos vão para o OneDrive pessoal de um funcionário**
(`operacional_01@jomedlog.com.br`), porque é assim que o Microsoft Forms
funciona. São **200 arquivos** nessa situação. Se essa conta for desativada, os
documentos são perdidos — o sistema guarda apenas os links. Este pedido também
resolve esse risco.

Não é possível usar a conta de uma pessoa: contas pessoais têm MFA (que um
programa não consegue responder), senha que expira, e sua desativação quebraria
a integração. Além disso, a auditoria do SharePoint registraria as ações do
sistema como se fossem daquela pessoa.

## O que precisamos

### 1. App Registration

| Campo | Valor |
|---|---|
| **Nome** | `Portal-Cadastro-Trafego` |
| **Tipo de conta** | Somente contas neste diretório organizacional (single tenant) |
| **Redirect URI** | Não é necessário (o app não faz login de usuário) |

### 2. Permissão de API — Microsoft Graph, tipo **Application**

| Permissão | Tipo | Para quê |
|---|---|---|
| `Sites.Selected` | Application | Ler e gravar arquivos **apenas** nos sites explicitamente autorizados |

⚠️ **Importante:** solicitamos deliberadamente `Sites.Selected` e **não**
`Sites.ReadWrite.All`. Com `Sites.Selected`, o aplicativo só acessa os sites que
vocês autorizarem individualmente — não tem visibilidade do resto do SharePoint
da empresa. É o princípio de menor privilégio.

A permissão exige **"Grant admin consent"**, que só um administrador pode dar.

### 3. Autorizar o app no site específico

Após conceder `Sites.Selected`, é preciso autorizar o app **naquele site**:

- **Site:** o site do **canal privado `GR`** da equipe **`TRAFEGO - MATRIZ`**
  (canal privado tem site próprio no SharePoint, separado do site da equipe)
- **Pasta de destino:** `Documentos / REGISTRO - NATIVO PORTAL CADASTRO`
- **Nível de acesso:** `write`

Isso é feito por uma chamada ao Microsoft Graph:

```http
POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions
Content-Type: application/json

{
  "roles": ["write"],
  "grantedToIdentities": [{
    "application": {
      "id":          "{application-client-id}",
      "displayName": "Portal-Cadastro-Trafego"
    }
  }]
}
```

O `site-id` do canal privado pode ser obtido com:

```http
GET https://graph.microsoft.com/v1.0/teams/{team-id}/channels/{channel-id}/filesFolder
```

### 4. Credencial — **certificado, de preferência**

Pedimos **certificado** em vez de *client secret*. Motivo: já tivemos uma
indisponibilidade em produção (24/07/2026) causada por credencial vencida sem
aviso. Certificado tem validade mais longa e gestão mais previsível.

Se for *client secret*, pedimos:
- validade de **24 meses**
- **a data de expiração informada**, para entrarmos com alerta no calendário

---

## O que devolver para nós

| Item | Onde usaremos |
|---|---|
| **Directory (tenant) ID** | variável de ambiente `AZURE_TENANT_ID` |
| **Application (client) ID** | variável de ambiente `AZURE_CLIENT_ID` |
| **Certificado (.pfx) ou client secret** | variável de ambiente `AZURE_CLIENT_SECRET` |
| **Data de expiração da credencial** | alerta de renovação |
| **Site ID do canal privado GR** | variável `SHAREPOINT_SITE_ID` |
| **Confirmação do "admin consent"** | — |

As credenciais serão guardadas como variáveis de ambiente secretas (Vercel
Environment Variables, marcadas como *Sensitive*), nunca no código nem no
repositório do GitHub.

---

## Perguntas adicionais ao TI

Aproveitando o mesmo chamado, precisamos confirmar três coisas:

1. **O tenant tem política de expiração de Grupo do M365 ativada?**
   Se sim, pedimos que a equipe `TRAFEGO - MATRIZ` seja **excluída da política**.
   Um grupo excluído automaticamente levaria o site do SharePoint — e os
   documentos — com ele.

2. **É possível aplicar política de retenção (Purview)** na biblioteca do canal
   GR, para impedir exclusão definitiva de documento por engano?

3. **Existe convenção de nomenclatura** para App Registrations e grupos de
   segurança na Jomed? Se sim, usamos a de vocês em vez de
   `Portal-Cadastro-Trafego`.

---

## Contexto de segurança e LGPD

Os documentos tratados contêm **dado pessoal** (CPF, CNH, comprovante de
residência de terceiros). A arquitetura foi desenhada para que:

- os **arquivos permaneçam no M365**, sob a conformidade do tenant — o sistema
  guarda apenas metadados e a referência (`driveId` + `itemId`);
- o acesso seja restrito a **quem participa do canal privado GR**;
- o aplicativo tenha o **menor privilégio possível** (`Sites.Selected` em um
  único site).

---

*Documento gerado em 29/07/2026. Contexto técnico completo em
`docs/PLANO-N8N.md`, seção 9.1.*
