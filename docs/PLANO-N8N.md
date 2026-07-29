# Substituição do Power Automate Premium por n8n Self-Hosted

**Documento técnico de arquitetura e decisão — Jomed Logística**
Elaborado em 29/07/2026 · Base: código e dados de produção do Portal de Cadastro

---

## Sumário executivo

**A substituição é viável e recomendada.** O Power Automate cumpre hoje uma função
estreita — pegar a resposta do Microsoft Forms e fazer um `POST` para o Portal — e
o n8n faz isso com folga. O custo de infraestrutura fica entre **R$ 30 e R$ 200/mês**,
contra a licença Premium.

**Porém: a maior descoberta desta análise não é sobre o n8n.** Ao inspecionar os
dados de produção, encontrei quatro problemas que representam risco maior que o
vencimento da licença. Dois deles podem causar **perda definitiva de documentos**
e **duplicação de toda a base**. Estão na seção 0 e devem ser tratados antes da
migração.

**O ponto técnico central:** o Microsoft Forms **não possui API pública oficial**.
Não existe "n8n conecta no Forms". Qualquer arquitetura que mantenha o Forms vai
depender de um intermediário (Excel sincronizado ou lista do SharePoint) e de
*polling*, nunca de um gatilho instantâneo. Isso torna o **abandono do Forms** não
uma evolução futura opcional, mas a decisão que de fato resolve o problema.

**Recomendação em uma linha:** use os 90 dias para migrar o gatilho para o n8n
via SharePoint (mantendo o Forms como fachada), e em paralelo construa o
formulário nativo no Portal — que é o destino final e elimina a dependência.

---

## 0. Achados críticos no ambiente atual

Estes quatro pontos vieram da leitura do código e dos 51 registros reais em
produção. Não fazem parte do escopo que você pediu, mas seria negligência
projetar a arquitetura nova sem apontá-los.

### 0.1 🔴 CRÍTICO — Os 200 documentos estão no OneDrive pessoal de um funcionário

Todos os 200 anexos das 51 solicitações apontam para:

```
https://jomedlog-my.sharepoint.com/personal/operacional_01_jomedlog_com_br/...
                                   └──────── OneDrive PESSOAL de uma conta ────┘
```

Isso é uma consequência do funcionamento do Microsoft Forms: os uploads vão para
o OneDrive de **quem criou o formulário**, não para um local corporativo.

**O risco:** se essa conta for desativada (demissão, reestruturação, troca de
licença), o OneDrive entra em retenção e depois é **excluído**. Os 200 documentos
— CNHs, comprovantes de residência, certificados ANTT — vão com ele. O Portal
guarda apenas os *links*, então ficariam 51 solicitações com 200 links quebrados,
sem cópia em nenhum outro lugar.

**Agravante já observado:** as miniaturas de imagem no painel só renderizam se o
usuário estiver logado no M365, porque o SharePoint exige autenticação. Ou seja,
o Portal já *depende* dessa conta para exibir documento.

**Correção:** mover os arquivos para uma **biblioteca de documentos de um site do
SharePoint** (propriedade da organização, não de uma pessoa). Isso é exatamente
uma das tarefas que o n8n vai executar bem — ver seção 3.2.

### 0.2 🔴 CRÍTICO — A anti-duplicação não está funcionando

O Portal tem um mecanismo de deduplicação baseado no campo `origem_id` (o id da
resposta do Forms), com índice único no banco. Está correto no código.

Mas nos 51 registros de produção:

```
com origem_id:  0
sem origem_id: 51
```

O fluxo do Power Automate **nunca envia esse campo**. A proteção existe e está
desligada na prática.

**Por que isso é grave agora:** o plano de migração prevê rodar Power Automate e
n8n **em paralelo** durante os testes — é o que torna a migração segura. Sem
`origem_id`, rodar os dois em paralelo **duplica cada solicitação**. E hoje, se o
Power Automate reexecutar um fluxo por falha transitória, ele já duplica.

**Correção:** incluir `origem_id` no fluxo (campo `responseId` do gatilho do
Forms). É uma alteração de 1 minuto no Power Automate, e deve ser feita **antes**
de qualquer teste em paralelo. No n8n será obrigatório desde o primeiro dia.

### 0.3 🟠 ALTO — Banco de produção em plano gratuito que hiberna

O Supabase recém-configurado está no plano **Free**, que:

- **pausa o projeto após ~1 semana sem atividade** — o sistema sai do ar até
  alguém clicar em *Restore* no painel;
- limita o banco a 500 MB;
- **não tem backup automático** (o plano Pro tem *Point-in-Time Recovery*).

Para um sistema que guarda CPF, CNH e dados de condutores de uma operação real,
o plano gratuito não é adequado. **Supabase Pro custa US$ 25/mês** e resolve os
três pontos.

### 0.4 🟡 MÉDIO — Região do banco do outro lado do continente

O deploy do Vercel roda em **`gru1` (São Paulo)** — confirmado pelo id de erro
capturado durante a migração. O banco Supabase foi criado em **`us-west-2`
(Oregon)**.

Cada consulta ao banco atravessa o continente: ~180 ms de ida e volta. Uma página
do painel que faça 3 consultas gasta ~0,5 s só em rede. O Supabase **não permite
trocar a região** de um projeto existente — exige criar outro projeto em
`sa-east-1` (São Paulo) e migrar (o que agora é trivial: os scripts
`exportar-turso` / `importar-supabase` servem de modelo).

Há também um argumento de **LGPD**: dados pessoais de condutores (CPF, CNH)
hospedados no exterior exigem base legal de transferência internacional. Manter
em São Paulo simplifica a conformidade.

### 0.5 ⚪ Verificar — Plano do Vercel

O plano **Hobby** do Vercel proíbe uso comercial. Se o Portal está em Hobby,
há exposição contratual. O plano **Pro** custa US$ 20/mês.

---

## 1. É possível substituir o Power Automate pelo n8n?

**Sim, com uma ressalva estrutural importante.**

Para o que vocês fazem hoje, sim, e com sobra. O fluxo atual é simples: gatilho
do Forms → montar um JSON → `POST` autenticado. O n8n faz isso nativamente.

A ressalva: o Power Automate tem um **gatilho nativo do Microsoft Forms** que o
n8n não tem e **não pode ter**, porque a limitação não é do n8n — é da Microsoft,
que não publica API para o Forms. Isso está detalhado na seção 2.

### Comparativo

| Dimensão | Power Automate Premium | n8n Self-Hosted |
|---|---|---|
| **Modelo** | SaaS, licença por usuário/fluxo | Software próprio, você hospeda |
| **Custo** | ~US$ 15/usuário/mês (Premium) ou ~US$ 150/mês (Process, por fluxo) | Infra: R$ 30–200/mês, ilimitado em usuários e execuções |
| **Gatilho do Forms** | ✅ Nativo e instantâneo | ❌ Inexistente (limitação da Microsoft) |
| **Conectores M365** | ✅ Nativos, autenticação delegada pronta | ⚠️ Via Microsoft Graph — precisa registrar app no Entra ID |
| **Chamada HTTP externa** | 💰 Conector **premium** (é o que expira) | ✅ Nativo e gratuito |
| **Lógica complexa** | Limitada; expressões verbosas | ✅ **JavaScript/Python nativo** — vantagem grande |
| **Versionamento em Git** | ❌ Não | ⚠️ Manual na Community; nativo só no Enterprise |
| **Execuções/mês** | Limitadas por licença | Ilimitadas (limite = seu hardware) |
| **Governança/SSO/RBAC** | ✅ Integrado ao tenant | ⚠️ Enterprise (pago) |
| **Responsabilidade operacional** | Microsoft | **Vocês** |
| **Curva de aprendizado** | Baixa (low-code) | Média (precisa entender API/JSON/auth) |
| **Auditoria e retenção** | Nativa, compliance M365 | Configurável, por sua conta |

### Vantagens do n8n para o caso da Jomed

1. **Elimina o gargalo de licença.** O bloqueio hoje é o conector HTTP premium.
   No n8n, HTTP é o comportamento padrão.
2. **Código de verdade.** O tratamento de dados de vocês é razoavelmente
   sofisticado — o campo `assunto` concatena até 8 operações separadas por `|`, o
   `detalhes` é uma string de ~307 caracteres com 11 subcampos (`Condutor:`,
   `CPF:`, `Placa Cavalo:`...). Fazer isso com expressões do Power Automate é
   penoso; um nó Code em JavaScript resolve com clareza e fica testável.
3. **Custo marginal zero para crescer.** Os fluxos de GR, SAC, RH, Expedição
   (seção 7) não custam licença adicional. No Power Automate, cada novo fluxo
   premium é custo novo.
4. **Portabilidade.** Fluxos são JSON. Podem ir para o Git, para outro servidor,
   para outra cloud.
5. **Integração com sistemas legados.** Rodopar e ELOG dificilmente terão
   conector oficial no Power Automate. No n8n, qualquer API REST, SOAP, banco ou
   FTP é acessível — inclusive consulta direta ao banco, se for o caso.

### Limitações e riscos honestos

| Risco | Gravidade | Mitigação |
|---|---|---|
| **Sem gatilho nativo do Forms** — vira *polling*, com latência de 1–5 min | Alta | Aceitar a latência (cadastro não é tempo real) ou abandonar o Forms (seção 9) |
| **Vocês passam a ser o time de infra** — atualizações, backup, monitoramento | Alta | Coolify + backup automatizado + monitoramento externo (seção 5) |
| **Ponto único de falha** — n8n fora do ar = automação parada | Alta | Fila persistente no Postgres; o Portal continua funcionando (a entrada de dados não depende do n8n na arquitetura proposta) |
| **Perda da `N8N_ENCRYPTION_KEY`** = todas as credenciais irrecuperáveis | Crítica | Guardar em cofre separado do backup do banco |
| **Conhecimento concentrado em uma pessoa** | Alta | Documentar cada fluxo; nomes descritivos nos nós; treinar um segundo |
| **Registro de app no Entra ID depende do TI/admin M365** | Média | Envolver o administrador do tenant na Etapa 1, não na Etapa 5 |
| **Licença fair-code** (Sustainable Use License) | Baixa | Uso interno é permitido. Proibido revender como serviço a terceiros |
| **SSO, RBAC e Git nativo são Enterprise** | Baixa | Community atende; disciplinar exportação manual para o Git |
| **Atualizações podem quebrar fluxo** (*breaking changes* entre versões) | Média | Fixar versão da imagem Docker; testar em *staging* antes |

### Diferença conceitual que importa

O Power Automate é **orientado a conectores**: você escolhe uma ação pronta e
preenche campos. O n8n é **orientado a dados**: cada nó recebe e devolve um array
de itens JSON, e você tem controle total do que passa entre eles.

Isso significa mais poder e mais responsabilidade. Quem hoje mantém o fluxo do
Power Automate clicando em campos dinâmicos vai precisar entender o que é um
payload JSON. É uma mudança de perfil de manutenção, não só de ferramenta — e
deve entrar na conta da decisão.

---

## 2. Como o n8n receberia os dados do Microsoft Forms?

### O fato que determina toda a arquitetura

> **O Microsoft Forms não tem API pública oficial.** Não existe endpoint no
> Microsoft Graph para ler respostas de formulário, e o Forms não emite webhooks
> nem notificações de mudança.

Existem endpoints internos (`forms.office.com/formapi/api/...`) usados pela
própria interface web. Eles **não são documentados nem suportados**, exigem token
de sessão do usuário e podem mudar sem aviso. **Não use isso em produção.**

Toda integração com Forms passa, portanto, por um **intermediário**.

### Opção A — Excel sincronizado + Graph API (Workbook)

O Forms pode manter uma planilha do Excel sincronizada com as respostas. A API de
Workbook do Graph é **oficial, estável e documentada**.

```
Forms → Excel (OneDrive/SharePoint) → Graph Workbook API → n8n (polling)
```

- ✅ API oficial e estável; n8n tem nó nativo do Microsoft Excel
- ⚠️ A sincronização contínua só existe se o formulário for criado como
  **"Forms para Excel"** a partir de uma biblioteca do SharePoint. Um formulário
  autônomo oferece apenas exportação pontual — **isso precisa ser validado no
  tenant de vocês antes de decidir** (é o item nº 1 da prova de conceito)
- ⚠️ Excel como fila é frágil: linha editada à mão, planilha aberta por alguém,
  limite de tamanho
- ⚠️ *Polling* — latência de 1 a 5 minutos
- ⚠️ **Não resolve os anexos**: a planilha traz o link, e o arquivo continua no
  OneDrive pessoal (problema 0.1)

### Opção B — Lista do SharePoint como fila ⭐ recomendada com Forms

Um fluxo do Power Automate **gratuito** (só conectores *standard*) grava cada
resposta em uma lista do SharePoint. O n8n lê a lista via Graph.

```
Forms → Power Automate (STANDARD, sem custo) → Lista SharePoint
                                                     ↓
                                        n8n (Graph: delta / subscription)
```

- ✅ **Contorna exatamente o problema da licença.** O que expira é o conector
  **premium** (HTTP). Gravar em lista do SharePoint é conector *standard*,
  incluído no M365 E3/E5 sem custo adicional
- ✅ Graph API para SharePoint é **oficial e robusta**, e **suporta notificações
  de mudança** (webhook de verdade, não *polling*)
- ✅ A lista serve de **fila durável e auditável**: se o n8n cair, nada é perdido —
  ao voltar, ele processa o que ficou para trás
- ✅ O mesmo fluxo *standard* pode mover os anexos para uma biblioteca
  corporativa, resolvendo o problema 0.1
- ⚠️ Mantém uma dependência residual do Power Automate — mas **na faixa gratuita**,
  que não expira
- ⚠️ Notificação de mudança exige endpoint HTTPS público e **renovação periódica
  da assinatura** (limite na ordem de ~30 dias; confirmar na documentação vigente
  para o recurso `list`). Um fluxo agendado no próprio n8n cuida disso

### Opção C — Polling de arquivos via Graph (driveItem delta)

O n8n monitora a pasta do SharePoint/OneDrive onde caem os anexos, usando a
consulta *delta* do Graph (só o que mudou desde a última verificação).

- ✅ Sem assinatura para renovar; muito simples e resiliente
- ✅ Ótimo **complemento** — é assim que se detecta e reorganiza documento
- ⚠️ Insuficiente sozinho: o arquivo não traz os dados do formulário

### Opção D — Zero Power Automate, com Logic Apps ou script

Substituir o fluxo *standard* por um Azure Logic App (consumo, centavos por
execução) ou um script agendado. Tecnicamente possível, mas troca uma dependência
Microsoft por outra, com mais complexidade. **Não vejo ganho.**

### Opção E — Abandonar o Forms: formulário no Portal ⭐⭐ recomendada como destino

O Portal já tem autenticação, papéis, banco e sessão. Falta um formulário nativo.

```
Portal (formulário nativo) → POST direto → Banco → evento → n8n (webhook real)
```

- ✅ **Elimina a dependência inteira** — sem Forms, sem Power Automate, sem polling
- ✅ **Instantâneo**, sem latência de fila
- ✅ **Validação na origem**: CPF conferido, placa no formato certo, campo
  obrigatório de verdade. Hoje o `detalhes` chega como texto livre concatenado —
  campos vazios (`TAG: | Placa Cavalo: | Placa Carreta:`) são comuns nos dados reais
- ✅ **Resolve o problema 0.1 na raiz**: o upload vai direto para onde vocês
  decidirem (biblioteca do SharePoint via Graph, ou Supabase Storage)
- ✅ **Dados estruturados desde o início** — cada campo em sua coluna, não uma
  string com 11 subcampos separados por `|`. Isso muda a qualidade do BI
- ⚠️ Exige desenvolvimento (estimativa na seção 9)
- ⚠️ Perde a familiaridade do Forms para quem preenche
- ⚠️ Upload de arquivo em função *serverless* tem limite de payload — precisa de
  *upload* direto para o storage com URL assinada

### Qual é a abordagem mais profissional?

Depende do horizonte, e a resposta honesta tem duas partes:

**Para os próximos 90 dias (prazo da licença): Opção B.**
É a que respeita a restrição real. Mantém o Forms que as pessoas já usam, usa
apenas conector gratuito do Power Automate, ganha uma fila durável e auditável no
SharePoint, e permite rodar em paralelo com o fluxo atual sem risco.

**Como arquitetura definitiva: Opção E.**
Enquanto o Forms estiver no caminho, vocês vão conviver com *polling*, dados
semiestruturados e anexos no lugar errado. Nenhuma dessas três coisas se resolve
com n8n — só se resolve tirando o Forms do caminho.

A boa notícia é que **as duas convivem**: o Portal pode aceitar as duas entradas
simultaneamente, e a migração dos usuários acontece por operação, sem *big bang*.

---

## 3. Arquitetura recomendada

### 3.1 Situação atual

```text
 Pessoa preenche o Microsoft Forms
             │
             ├── arquivos ──► OneDrive PESSOAL de operacional_01  ⚠️ PROBLEMA 0.1
             │
             ▼  gatilho "nova resposta"
 ┌───────────────────────────────────┐
 │  POWER AUTOMATE  (PREMIUM)        │  ⚠️ EXPIRA EM ~90 DIAS
 │  · Obter detalhes da resposta     │
 │  · Concatenar campos              │
 │  · Ação HTTP  ◄── conector premium│
 └───────────────────────────────────┘
             │  POST + x-webhook-secret
             ▼
 ┌───────────────────────────────────┐
 │  PORTAL (Vercel, região gru1)     │
 │  POST /api/forms/webhook          │
 └───────────────────────────────────┘
             │                    ⚠️ PROBLEMA 0.4: gru1 → us-west-2 (~180ms)
             ▼
 ┌───────────────────────────────────┐
 │  SUPABASE PostgreSQL (Oregon)     │  ⚠️ PROBLEMA 0.3: plano free hiberna
 │  tabela solicitacoes              │
 └───────────────────────────────────┘
             │
             ▼
    Painel do responsável (aprova/reprova por operação)

    ❌ Sem notificação em Teams
    ❌ Sem e-mail automático
    ❌ Sem atualização de BI
    ❌ origem_id nunca preenchido  ⚠️ PROBLEMA 0.2
```

Vale registrar: o fluxo atual **para no painel**. Não há notificação, e-mail nem
BI. Portanto o n8n não é só substituição — é a primeira vez que essa cadeia vai
existir.

### 3.2 Arquitetura Fase 1 — n8n mantendo o Forms

```text
 Pessoa preenche o Microsoft Forms
             │
             ├── arquivos ──► OneDrive pessoal (origem)
             │
             ▼  gatilho "nova resposta"
 ┌────────────────────────────────────────────┐
 │  POWER AUTOMATE — FAIXA GRATUITA           │  ✅ não expira
 │  Conectores STANDARD apenas:               │
 │  · Obter detalhes da resposta (Forms)      │
 │  · Criar item (Lista SharePoint)  ◄─ fila  │
 │  · Copiar arquivo → Biblioteca corporativa │  ✅ resolve 0.1
 └────────────────────────────────────────────┘
             │
             ▼
 ┌────────────────────────────────────────────┐
 │  SHAREPOINT — site corporativo             │
 │  · Lista  "Cadastros-Entrada"  (fila)      │
 │  · Biblioteca "Documentos-Cadastro"        │
 │       /2026/07/<cpf>-<nome>/...            │
 └────────────────────────────────────────────┘
             │  Graph API (subscription + delta como rede de segurança)
             ▼
 ╔════════════════════════════════════════════╗
 ║           n8n SELF-HOSTED                  ║
 ║                                            ║
 ║  [1] Webhook / Schedule (2 min)            ║
 ║  [2] Graph: ler itens novos da lista       ║
 ║  [3] Code: NORMALIZAR                      ║
 ║        · assunto → array de operações      ║
 ║          (remove os "|" vazios)            ║
 ║        · detalhes → campos estruturados    ║
 ║          (Condutor, CPF, Placas, TAG...)   ║
 ║        · validar CPF, placa, e-mail        ║
 ║        · origem_id = responseId  ✅ 0.2     ║
 ║  [4] Graph: organizar/renomear documentos  ║
 ║  [5] HTTP POST → Portal (contrato atual)   ║
 ║  [6] IF: deu erro? → alerta + retry        ║
 ║  [7] Teams: avisar o responsável           ║
 ║  [8] E-mail: confirmar ao solicitante      ║
 ║  [9] Postgres: registrar log de execução   ║
 ╚════════════════════════════════════════════╝
             │
             ▼
 ┌────────────────────────────────────────────┐
 │  PORTAL — POST /api/forms/webhook          │
 │  ✅ CONTRATO INALTERADO                     │
 └────────────────────────────────────────────┘
             │
             ▼
 ┌────────────────────────────────────────────┐
 │  PostgreSQL (Supabase Pro, São Paulo)      │
 └────────────────────────────────────────────┘
             │
             ├──► Painel do responsável
             ├──► Teams (canal Tráfego)
             ├──► E-mail ao solicitante
             └──► BI (view de leitura)
```

**A decisão de projeto mais importante aqui:** o n8n entra **falando o mesmo
contrato** que o Power Automate já fala — `POST /api/forms/webhook` com
`x-webhook-secret`. Isso significa:

- **zero alteração no código do Portal** para a migração do gatilho;
- os dois podem rodar **em paralelo** (desde que o problema 0.2 seja corrigido);
- o *rollback* é reativar o fluxo antigo — segundos, não horas.

Esse é o mesmo princípio que tornou a migração Turso → Supabase segura: manter o
contrato e trocar a implementação por trás.

### 3.3 Arquitetura Fase 2 — Portal como porta de entrada

```text
 ┌──────────────────────────────────────────────────────┐
 │  PORTAL DE CADASTRO  (formulário nativo)             │
 │  · login M365 (SSO) — solicitante já autenticado     │
 │  · campos VALIDADOS: CPF, CNH, placa, ANTT           │
 │  · upload direto p/ storage (URL assinada)           │
 │  · rascunho salvo, edição antes de enviar            │
 └──────────────────────────────────────────────────────┘
             │  transação única
             ▼
 ┌──────────────────────────────────────────────────────┐
 │  PostgreSQL — dados ESTRUTURADOS                     │
 │  solicitacoes · condutores · veiculos · documentos   │
 │  operacoes_solicitadas (1 linha por operação)        │
 │  eventos  ◄── fila de saída (outbox)                │
 └──────────────────────────────────────────────────────┘
             │  evento publicado (webhook do Portal ou Supabase)
             ▼
 ╔══════════════════════════════════════════════════════╗
 ║  n8n — ORQUESTRADOR DE INTEGRAÇÕES                   ║
 ╚══════════════════════════════════════════════════════╝
      │        │         │        │        │        │
      ▼        ▼         ▼        ▼        ▼        ▼
 SharePoint  Teams    E-mail    BI     Rodopar    ELOG
 (arquivo)  (aviso)  (retorno) (dados) (cadastro) (cadastro)
```

Aqui o n8n assume seu papel natural: **não é mais o caminho por onde o dado
entra, e sim o distribuidor do que já entrou.** Se o n8n cair, o cadastro
continua sendo registrado — só a distribuição fica em fila. Essa separação entre
*captura* e *distribuição* é a diferença mais importante entre as duas fases.

O padrão **outbox** (tabela `eventos`) é o que garante isso: o Portal grava o
evento na mesma transação do cadastro, e o n8n consome. Nada se perde por
indisponibilidade.

---

## 4. Hospedagem

### Dimensionamento antes de comparar

Números reais medidos na base de produção:

| Métrica | Valor |
|---|---|
| Solicitações em 8 dias | 51 |
| Média por dia | 6,4 |
| **Pico em um dia** | **17** |
| Anexos por solicitação | 3,9 (máx. 9) |
| Total de anexos | 200 |
| Projeção mensal | **~190 solicitações** |

**Isto é um volume muito baixo.** Mesmo com 10 fluxos novos e uma folga de 10×
para crescimento, estamos falando de algo como 2.000 execuções/mês. O n8n roda
isso confortavelmente em **1 vCPU e 2 GB de RAM**.

A consequência prática é importante: **não gastem com hardware.** O critério de
escolha deve ser **confiabilidade e facilidade de operação**, não capacidade.

### Comparativo

| Opção | Custo/mês | Facilidade | Segurança | Escala | Veredito |
|---|---|---|---|---|---|
| **VPS + Coolify** (Hetzner CX22, Contabo) | € 4–6 (~R$ 30–40) | 🟢 Alta *com* Coolify | 🟢 Boa (você controla) | 🟢 Vertical fácil | ⭐ **Recomendado** |
| **VPS Brasil** (Vultr/DO São Paulo, Hostinger) | US$ 6–12 (~R$ 35–70) | 🟢 Alta | 🟢 Boa | 🟢 Boa | ⭐ **Recomendado se LGPD pesar** |
| **n8n Cloud** (oficial) | € 20–50 (~R$ 120–300) | 🟢🟢 Máxima (zero ops) | 🟢🟢 Gerenciada | 🟢 Automática | ⭐ **Recomendado se não houver quem cuide** |
| **Oracle Cloud Free** (ARM 4 vCPU/24 GB) | R$ 0 | 🟡 Média (setup chato) | 🟢 Boa | 🟡 Presa ao free | ⚠️ Ver ressalva abaixo |
| **Azure Container Apps** | US$ 15–35 (~R$ 90–200) | 🟡 Média | 🟢🟢 Dentro do tenant | 🟢🟢 Excelente | ✅ Se o TI exigir Azure |
| **Servidor interno** (on-premises) | R$ 0 (CapEx já feito) | 🔴 Baixa | 🟡 Depende da rede | 🔴 Limitada | ⚠️ Só com Cloudflare Tunnel |
| **Railway** | US$ 5–20 | 🟢 Alta | 🟢 Boa | 🟢 Boa | ⚠️ Vocês já saíram dele |
| **Render** | US$ 7+ | 🟢 Alta | 🟢 Boa | 🟡 Média | ❌ Free hiberna — inviável |
| **Docker puro em VPS** | = VPS | 🟡 Média | 🟢 Boa | 🟢 Boa | ✅ Base das opções acima |

### Notas por opção

**VPS + Coolify — a recomendação principal.** Coolify é um painel *self-hosted*
que dá a experiência de PaaS (deploy, SSL automático, backup, logs) sobre um VPS
seu. Instala em um comando, é gratuito, e tem *template* de n8n. Você ganha a
conveniência do Railway sem a fatura e sem *vendor lock-in*. Um Hetzner CX22
(2 vCPU, 4 GB, 40 GB) a € 4,51/mês é folgado para o volume de vocês.

**Oracle Cloud Free — cuidado.** Os 4 vCPU ARM e 24 GB de RAM são reais e
gratuitos "para sempre". Mas na prática: (a) a capacidade ARM em São Paulo vive
esgotada, e criar a instância pode levar dias de tentativa; (b) a Oracle **recupera
instâncias free consideradas ociosas**; (c) suporte inexistente. Para um
laboratório, ótimo. **Para o fluxo de cadastro de uma operação real, eu não
colocaria.** Se o orçamento é o problema, R$ 30/mês de VPS pago compra muito mais
tranquilidade.

**Servidor interno.** Tecnicamente possível e o dado nunca sai da empresa. Mas
exige IP público ou **Cloudflare Tunnel** (gratuito e resolve bem), energia,
link redundante, e alguém para cuidar. Para um serviço que precisa receber
webhook da Microsoft, a internet corporativa costuma ser o elo frágil. Considere
apenas se já houver virtualização madura e um responsável de infra.

**n8n Cloud — não descarte.** Se a Jomed não tem alguém com tempo para ser
responsável por um Linux em produção, pagar € 20–50/mês pela versão gerenciada
é mais barato que um incidente. Você continua tendo n8n, fluxos exportáveis e
zero *lock-in* — pode internalizar depois. **Esta é a opção honesta se a resposta
para "quem cuida do servidor?" for "ninguém especificamente".**

### Arquitetura de hospedagem recomendada

```text
        Internet
           │
           ▼
 ┌─────────────────────────────────────────┐
 │  Cloudflare  (DNS + WAF + rate limit)   │
 └─────────────────────────────────────────┘
           │  n8n.jomedlog.com.br
           ▼
 ┌─────────────────────────────────────────┐
 │  VPS  (2 vCPU · 4 GB · São Paulo)       │
 │  ┌───────────────────────────────────┐  │
 │  │ Traefik/Caddy — TLS Let's Encrypt │  │
 │  ├───────────────────────────────────┤  │
 │  │ n8n (imagem com versão FIXADA)    │  │
 │  ├───────────────────────────────────┤  │
 │  │ PostgreSQL — banco DO n8n         │  │
 │  ├───────────────────────────────────┤  │
 │  │ Coolify — deploy, logs, backup    │  │
 │  └───────────────────────────────────┘  │
 │  Firewall: só 22 (chave), 80, 443       │
 └─────────────────────────────────────────┘
           │
           ├──► Backup diário → S3/Backblaze/OneDrive
           └──► Uptime Kuma / Better Stack (monitor externo)
```

Duas observações de projeto:

1. **O banco do n8n é separado do banco do Portal.** O n8n guarda execuções e
   credenciais; o Portal guarda dados de negócio. Misturar os dois cria
   acoplamento e risco de um derrubar o outro. Instâncias separadas, ou no mínimo
   *schemas* e usuários distintos.
2. **Monitoramento tem que ser externo.** Um monitor rodando no mesmo VPS não
   avisa quando o VPS cai.

---

## 5. Segurança

### 5.1 HTTPS e TLS

- Traefik ou Caddy emitem e renovam certificado Let's Encrypt automaticamente
- Redirecionar todo HTTP → HTTPS; HSTS habilitado
- TLS 1.2 mínimo; TLS 1.3 preferido
- **`WEBHOOK_URL` do n8n deve ser a URL pública HTTPS** — senão a validação de
  assinatura do Graph falha

### 5.2 Autenticação e acesso ao n8n

- Conta *owner* com senha forte e **2FA obrigatório**
- Um usuário por pessoa — **nunca conta compartilhada** (destrói a auditoria)
- SSO/SAML é Enterprise. Na Community, mitigue restringindo o acesso ao painel
  por **IP da rede da Jomed** (Cloudflare Access ou regra no proxy) — os
  *webhooks* seguem públicos, o painel não precisa ser
- Desabilitar registro público de usuário

### 5.3 Autenticação com a Microsoft (Entra ID)

Ponto que exige atenção e envolvimento do administrador do tenant:

- Registrar um **App Registration** dedicado ("n8n-Integracao-Cadastro")
- Usar **permissões de aplicação** (*application*), não delegadas — o n8n é
  serviço, não usuário
- **Preferir certificado a client secret.** Secret expira e derruba a integração
  silenciosamente (foi exatamente o que aconteceu no incidente de 24/07 com o
  token do Turso: credencial venceu, produção caiu com erro genérico)
- **Menor privilégio — este é o ponto crítico:** use **`Sites.Selected`**, não
  `Sites.ReadWrite.All`. Com `Sites.Selected`, o app só acessa os sites que vocês
  autorizarem explicitamente. `Sites.ReadWrite.All` dá acesso a **todo o
  SharePoint da empresa** — inclusive RH, jurídico, financeiro. Se o n8n for
  comprometido, a diferença entre as duas permissões é a diferença entre perder
  uma biblioteca e perder a empresa
- Registrar no calendário a **data de expiração** da credencial, com alerta 30
  dias antes

### 5.4 Segurança dos webhooks

O padrão atual usa segredo compartilhado em cabeçalho — funciona, mas pode
melhorar:

| Nível | Mecanismo | Situação |
|---|---|---|
| Atual | `x-webhook-secret` fixo no cabeçalho | ✅ Em produção |
| Melhor | **HMAC-SHA256** sobre o corpo cru + *timestamp* | 🎯 Recomendado |
| Adicional | Rate limit + allowlist de IP no Cloudflare | 🎯 Recomendado |

Detalhe favorável: o Portal **já captura o corpo cru** da requisição
(`verify: capturarRaw` na rota do webhook). Isso significa que a infraestrutura
para validar HMAC já existe — falta apenas calcular e comparar a assinatura. O
`timestamp` protege contra *replay*, que o segredo fixo não cobre.

### 5.5 Variáveis de ambiente e segredos

- Nunca dentro do JSON do fluxo (vai para o Git e vaza)
- Credenciais no cofre do próprio n8n (criptografado com `N8N_ENCRYPTION_KEY`)
- **A `N8N_ENCRYPTION_KEY` é o segredo mais importante de todos.** Sem ela, o
  backup do banco é inútil — as credenciais são irrecuperáveis. **Guarde em local
  separado do backup** (cofre de senhas da empresa, envelope físico no financeiro)
- Rotação anual de segredos, documentada
- Rotacionar o `FORMS_WEBHOOK_SECRET` ao desativar o Power Automate

### 5.6 Backups

| O que | Frequência | Retenção | Onde |
|---|---|---|---|
| Postgres do n8n (`pg_dump`) | Diário | 30 dias | Off-site (S3/Backblaze) |
| Fluxos exportados em JSON | A cada alteração | Ilimitada | **Git** |
| `N8N_ENCRYPTION_KEY` | Uma vez | Permanente | **Cofre separado** |
| Banco do Portal | PITR (Supabase Pro) | 7 dias | Gerenciado |
| Documentos | Versionamento do SharePoint | Política de retenção | M365 |

**Backup que nunca foi restaurado não é backup.** Agende um teste de restauração
trimestral em ambiente separado.

### 5.7 Logs, auditoria e retenção

- `EXECUTIONS_DATA_PRUNE=true` com retenção de ~30 dias. Sem isso o banco cresce
  indefinidamente — é a causa nº 1 de disco cheio em n8n *self-hosted*
- ⚠️ **LGPD:** o log de execução do n8n guarda o **payload completo**, incluindo
  CPF, CNH e endereço. Isso é dado pessoal em local não previsto. Duas medidas:
  (a) reduzir a retenção; (b) usar `$hideDataFromUI` / não persistir dados
  sensíveis nos nós que os manipulam
- Alerta de falha: um *error workflow* global que avisa no Teams a cada execução
  que falhar. Automação que falha em silêncio é pior que automação inexistente
- Monitoramento externo de disponibilidade (Uptime Kuma, Better Stack)

### 5.8 Controle de acesso e LGPD

Vocês tratam **CPF, CNH, comprovante de residência e certificado ANTT** de
terceiros. É dado pessoal, e parte dele sensível.

- Manter documento no M365 (já sob a conformidade do tenant) e no banco apenas
  metadado + link — a arquitetura atual já faz isso, e está certo
- Definir **política de retenção**: por quanto tempo guardar documento de
  condutor reprovado?
- Registrar a **finalidade** do tratamento e a base legal
- Restringir a biblioteca do SharePoint aos grupos Tráfego e GR
- Trilha de auditoria de quem aprovou o quê — o Portal já grava `revisado_por` e
  `revisado_em`, inclusive por operação
- Reavaliar a hospedagem no exterior (problema 0.4)

### 5.9 Hardening do servidor

- SSH só por chave; senha e root desabilitados; porta não padrão
- `ufw`: apenas 80/443 abertos (e 22 restrito por IP)
- `fail2ban`
- Atualizações automáticas de segurança (`unattended-upgrades`)
- **Versão da imagem Docker fixada** (`n8nio/n8n:1.xx.y`), nunca `latest` —
  `latest` faz o fluxo mudar de comportamento sem você ter pedido
- Docker: container sem `--privileged`, com limite de memória

---

## 6. Banco de dados

### Recomendação: PostgreSQL

Vocês já escolheram certo — a migração para Supabase acabou de ser feita. Vale
consolidar o porquê.

| Critério | PostgreSQL | MySQL/MariaDB | SQL Server |
|---|---|---|---|
| **Custo de licença** | 🟢 Zero | 🟢 Zero | 🔴 Alto (Standard ~US$ 4k/core) |
| **JSON/JSONB** | 🟢🟢 JSONB indexável — ideal p/ `anexos`, `decisoes` | 🟡 JSON sem índice equivalente | 🟡 Razoável |
| **Suporte oficial n8n** | 🟢🟢 **Recomendado pelo projeto** | 🔴 Não suportado | 🔴 Não suportado |
| **Ecossistema BI** | 🟢 Todos conectam | 🟢 Todos conectam | 🟢🟢 Nativo em Power BI |
| **Extensões** | 🟢🟢 PostGIS, pg_cron, TimescaleDB | 🔴 Poucas | 🟡 Limitado |
| **SQL analítico** | 🟢🟢 CTE, window, lateral | 🟡 Mais recente | 🟢 Bom |
| **Cloud gerenciada** | 🟢 Supabase, Neon, RDS | 🟢 Várias | 🟡 Azure SQL |
| **Geoespacial** (rotas, cercas) | 🟢🟢 PostGIS | 🔴 Fraco | 🟡 Razoável |

**Decisivo:** o n8n **só suporta PostgreSQL e SQLite** como banco próprio. MySQL
não é opção — mesmo que o Portal usasse MySQL, você precisaria de um Postgres
para o n8n. Padronizar em Postgres elimina um banco da conta.

**PostGIS merece destaque para o negócio de vocês.** Empresa de logística
eventualmente vai querer cercas geográficas, distância de rota, região de
atuação de agregado. Postgres tem isso de graça; os outros dois, não.

### Sobre o SQL Server

Vale a pergunta: **o Rodopar roda em SQL Server?** Muitos TMS brasileiros rodam.
Se sim, vocês já têm licença e conhecimento internos — e isso não muda a
recomendação (Postgres para Portal + n8n), mas muda a **estratégia de
integração**: o n8n pode ler o SQL Server do Rodopar direto, com nó nativo, sem
depender de API. Vale confirmar, porque simplifica bastante a seção 7.

### Topologia recomendada

```text
 ┌──────────────────────────────┐   ┌──────────────────────────────┐
 │  Postgres do PORTAL          │   │  Postgres do n8n             │
 │  (Supabase Pro, São Paulo)   │   │  (no VPS, junto do n8n)      │
 │                              │   │                              │
 │  · solicitacoes  · usuarios  │   │  · execution_entity          │
 │  · condutores    · veiculos  │   │  · credentials_entity        │
 │  · documentos    · eventos   │   │  · workflow_entity           │
 │                              │   │                              │
 │  DADO DE NEGÓCIO             │   │  DADO OPERACIONAL            │
 │  backup PITR · retenção longa│   │  descartável · poda 30 dias  │
 └──────────────────────────────┘   └──────────────────────────────┘
              ▲                                  │
              │  usuário read-only               │
              │  + usuário de escrita do n8n     │
              └──────────────────────────────────┘
```

**Separados de propósito.** Perfis de backup, retenção e criticidade são
diferentes. E o n8n gera muita escrita de log — não deve competir por I/O com o
banco que atende o painel.

**Para o BI:** crie um **usuário somente-leitura** e exponha **views**, não
tabelas. Assim o BI não depende do formato interno e vocês podem refatorar o
schema sem quebrar relatório. Se o volume crescer, uma *read replica* isola a
carga analítica.

### Ações concretas

1. **Subir para o Supabase Pro** (US$ 25/mês) — resolve hibernação, backup e
   limite de 500 MB (problema 0.3)
2. **Recriar em São Paulo** (`sa-east-1`) — latência e LGPD (problema 0.4). Os
   scripts de migração já existem e servem de modelo
3. **Postgres do n8n no próprio VPS** — mais barato e mais rápido
4. **Modelar as tabelas estruturadas** da Fase 2 (`condutores`, `veiculos`,
   `documentos`, `operacoes_solicitadas`) em vez de string com `|`
5. **Criar usuário read-only + views para o BI**

---

## 7. Fluxos que poderão ser criados

### 7.1 Tráfego — cadastro (substituição direta)

| Fluxo | Descrição | Prioridade |
|---|---|---|
| **Cadastro de terceiro/agregado** | Forms/Portal → normaliza → Portal → Teams → e-mail | 🔴 P0 — é a substituição |
| **Organização de documentos** | Move do OneDrive pessoal p/ biblioteca corporativa, renomeia `<CPF>-<nome>-<tipo>`, cria pasta por mês | 🔴 P0 — resolve 0.1 |
| **Notificação de decisão** | Aprovado/reprovado por operação → e-mail ao solicitante + Teams | 🟠 P1 |
| **Cobrança de pendência** | Solicitação parada há 48h → lembra o responsável; 5 dias → escala ao gestor | 🟠 P1 |
| **Documento faltando** | Detecta ausência de CNH/ANTT/comprovante → pede ao solicitante | 🟠 P1 |
| **Validação de CPF/CNPJ** | Dígito verificador + consulta a base pública | 🟡 P2 |
| **Vencimento de CNH/ANTT** | Varredura diária → avisa 30/15/7 dias antes | 🟡 P2 |
| **Sincronização Rodopar** | Aprovado → cria/atualiza cadastro no Rodopar | 🟡 P2 |
| **Sincronização ELOG** | Idem ELOG | 🟡 P2 |
| **Relatório semanal** | Segunda 8h: aprovados/reprovados/pendentes por operação → Teams | 🟢 P3 |

### 7.2 GR — Gerenciamento de Risco

- **Consulta automática de risco** ao aprovar condutor (Buonny, Apisul, etc.)
- **Bloqueio automático** de condutor com restrição, notificando o Tráfego
- **Checklist de rastreador** — valida ID informado (hoje chega como `.` ou vazio
  nos dados reais)
- **Alerta de desvio de rota** — telemetria → regra → Teams
- **Dossiê consolidado** do condutor em PDF, montado a partir da biblioteca
- **Reanálise periódica** de cadastro ativo (a cada 6 meses)

### 7.3 Programação

- **Disponibilidade de frota** — consolida Rodopar/ELOG → painel diário no Teams
- **Sugestão de alocação** por região, tipo de veículo e histórico
- **Aviso de janela de coleta** aos agregados (e-mail/WhatsApp)
- **Conferência de documento antes do embarque** — bloqueia veículo irregular
- **Reprogramação por atraso** — detecta e notifica cliente

### 7.4 SAC

- **Abertura de ocorrência por e-mail** — lê caixa compartilhada, classifica e
  registra
- **Distribuição por assunto/cliente** com SLA
- **Escalonamento por SLA** — 4h sem resposta → coordenação
- **Pesquisa de satisfação** automática no encerramento
- **Consulta de status** — cliente pergunta, n8n busca no Rodopar e responde
- **Resumo diário de reclamações** por operação (Mercado Livre, Shopee, Amazon)

### 7.5 Expedição

- **Conferência de volume** — divergência coleta × expedição → alerta
- **Emissão/validação de documento** (CT-e, MDF-e) com checagem prévia
- **Comprovante de entrega** — recebe foto, arquiva no SharePoint, vincula
- **Aviso de carga pronta** ao motorista
- **Controle de doca** — fila e tempo de permanência

### 7.6 RH

- **Onboarding** — admissão dispara: criação de conta M365, acessos, kit de
  boas-vindas, aviso ao gestor
- **Offboarding** — desliga acessos, transfere OneDrive (**exatamente o
  procedimento que protegeria os 200 documentos do problema 0.1**)
- **Documento admissional** via formulário → SharePoint organizado
- **Vencimento de ASO/treinamento (NR)** — alerta prévio
- **Aniversário e tempo de casa** — Teams
- **Aprovação de férias** — solicitação → gestor → RH → folha

### 7.7 Transversais

- **Monitor de saúde das integrações** — testa cada endpoint, avisa se cair
- **Backup dos fluxos para o Git** — diário
- **Renovação das assinaturas do Graph** — obrigatório na Opção B
- **ETL para BI** — consolidação noturna
- **Painel de KPI no Teams** — tempo médio de aprovação, taxa de reprovação por
  operação, documento mais devolvido

Vale reforçar: **cada um desses fluxos custaria licença nova no Power Automate
Premium.** No n8n, custam apenas o tempo de construir. É aí que a economia real
aparece — não na substituição do fluxo atual, mas nos vinte que vocês não fizeram
por causa do custo marginal.

---

## 8. Plano de migração

### Etapa 0 — Correções urgentes (Semana 1) 🔴

**Antes de tocar no n8n.** Estes itens são pré-requisito.

| # | Ação | Responsável | Por quê |
|---|---|---|---|
| 0.1 | Adicionar `origem_id` (`responseId`) no fluxo atual do PA | Quem mantém o fluxo | **Sem isso o teste em paralelo duplica a base** |
| 0.2a | **Quebrar a herança de permissão** nas duas pastas novas (grupo `GR - Cadastro`) | TI | Fazer com a pasta vazia, antes de mover arquivo |
| 0.2b | Levantar quantos dos 200 arquivos **ainda existem** no OneDrive pessoal | Tráfego | Links são de julho; se a pasta foi reorganizada, pode já haver perda |
| 0.2c | Copiar os 200 documentos p/ `Controle GR - Frota / FORMS REGISTROS - MICROSOFT` **e remapear os links no banco** | TI + Tráfego | Conta pessoal pode ser excluída. ⚠️ **Mover os arquivos quebra os 200 links atuais** — não é só copiar (ver 9.1) |
| 0.3 | Subir Supabase para Pro | Você | Free hiberna e não tem backup |
| 0.4 | Exportar backup completo (banco + documentos) | Você | Rede de segurança |
| 0.5 | Confirmar o plano do Vercel | Você | Uso comercial em Hobby |

> A Etapa 0.1 é a mais importante do plano inteiro. Rodar Power Automate e n8n em
> paralelo é o que torna a migração segura — e sem `origem_id` isso é impossível.

### Etapa 1 — Provisionar o n8n (Semana 2)

1. Contratar VPS (2 vCPU / 4 GB, São Paulo) ou assinar n8n Cloud
2. Instalar Coolify; subir n8n + Postgres + Traefik
3. DNS `n8n.jomedlog.com.br` no Cloudflare; TLS ativo
4. Gerar e **guardar a `N8N_ENCRYPTION_KEY` em cofre separado**
5. Criar contas com 2FA; restringir o painel ao IP da Jomed
6. **Solicitar ao TI o App Registration no Entra ID** com `Sites.Selected` —
   *comece por aqui, é o item de maior lead time*
7. Configurar backup diário off-site e monitor externo

**Entregável:** n8n acessível, seguro, com credencial Graph funcionando.
**Prova de conclusão:** um fluxo de teste lê um item de lista do SharePoint.

### Etapa 2 — Ambiente de testes (Semana 3)

1. Criar site SharePoint **`Cadastro-Homologacao`** (lista + biblioteca)
2. **Duplicar o Microsoft Forms** para uma versão de teste
3. Criar o fluxo *standard* do Power Automate (Forms teste → lista homologação)
4. **Decidir o destino do teste** — a instância local (`npm start`) ou um
   *Preview Deployment* do Vercel com banco separado. **Nunca produção.**
5. **Validar a premissa da Opção A** — verificar se o Forms de vocês sustenta
   planilha sincronizada. Isso confirma ou descarta a alternativa

**Entregável:** ambiente completo isolado, sem tocar produção.

### Etapa 3 — Migrar o primeiro fluxo (Semanas 4–5)

Reconstruir no n8n o fluxo de cadastro:

1. Gatilho (assinatura do Graph, com *schedule* de 2 min como rede de segurança)
2. Ler itens novos da lista
3. **Nó Code — normalização** (o coração do trabalho):
   - `assunto` → array de operações, descartando os `|` vazios
   - `detalhes` → objeto com `condutor`, `cpf`, `email`, `contato_mot`,
     `proprietario`, `contato_prop`, `tag`, `placa_cavalo`, `placa_carreta`,
     `rastreador_id`, `obs`
   - validar CPF (dígito verificador), placa (padrão antigo e Mercosul), e-mail
   - **`origem_id` obrigatório**
4. Organizar documentos na biblioteca corporativa
5. `POST` no Portal — **mesmo contrato atual**
6. Tratamento de erro com *retry* exponencial + alerta no Teams
7. Notificações (Teams + e-mail) — **funcionalidade nova**
8. **Exportar o fluxo em JSON e commitar no Git**

**Entregável:** fluxo completo em homologação.
**Critério:** 20 respostas de teste, incluindo casos difíceis — sem anexo, 9
anexos, campos vazios, CPF inválido, acento e caractere especial, reenvio da
mesma resposta (deve deduplicar).

### Etapa 4 — Testes e execução em paralelo (Semanas 6–8)

**A etapa que garante a migração.**

1. Apontar o n8n para a **produção**, com o Power Automate **ainda ligado**
2. Ambos gravam; a deduplicação por `origem_id` impede duplicata — **por isso a
   Etapa 0.1 é pré-requisito**
3. **Conciliação diária:** contar registros por origem, comparar campo a campo.
   É a mesma técnica usada na migração Turso → Supabase, que encontrou 100% de
   correspondência nos 51 registros
4. Duas semanas de operação real em paralelo
5. Medir: latência de ponta a ponta, taxa de erro, execuções falhas
6. **Treinar uma segunda pessoa** — não deixe o conhecimento em uma cabeça só

**Critério de aprovação:** 14 dias consecutivos com 100% de correspondência e
zero duplicata.

### Etapa 5 — Produção (Semana 9)

1. **Desativar o fluxo premium do Power Automate** (desativar, não excluir)
2. n8n passa a ser o único caminho
3. **Vigilância reforçada por 7 dias** — conferência diária
4. Documentar operação: como ver log, como reprocessar, quem chamar
5. **Testar o plano de rollback de verdade** (reativar o PA e confirmar) — não
   confie em rollback nunca exercitado

**Plano de rollback:** reativar o fluxo do Power Automate e desligar o do n8n.
Tempo estimado: menos de 5 minutos. Válido enquanto a licença durar — o que dá
uma janela real de segurança.

### Etapa 6 — Desativação do Power Automate (Semana 10+)

1. Confirmar 30 dias estáveis
2. Excluir o fluxo premium; manter o *standard* (gratuito, é parte da arquitetura)
3. **Rotacionar o `FORMS_WEBHOOK_SECRET`** — invalida o antigo
4. Cancelar/não renovar a licença Premium
5. Registrar a economia
6. Iniciar os fluxos P1 da seção 7

### Linha de tempo

```text
Semana:  1    2    3    4    5    6    7    8    9    10   11   12
         │    │    │    │    │    │    │    │    │    │    │    │
Etapa 0  ████                                    ← correções urgentes
Etapa 1       ████                               ← provisionar
Etapa 2            ████                          ← homologação
Etapa 3                 █████████                ← construir fluxo
Etapa 4                           ██████████████ ← PARALELO (crítico)
Etapa 5                                     ████ ← produção
Etapa 6                                          ████████ ← desativar
                                                      │
Licença Premium expira ──────────────────────────────────────────► ~sem 13
                                          margem de ~4 semanas ✅
```

**Folga de ~4 semanas** antes do vencimento. É apertado mas viável — desde que a
Etapa 1 comece já, porque o App Registration no Entra ID depende de terceiros.

Em paralelo, a partir da Semana 6, começar o **formulário nativo no Portal**
(Fase 2), que é o destino real.

---

## 9. Evolução futura — Portal como porta de entrada

### Arquitetura alvo

```text
 ┌────────────────────────────────────────────────────────────┐
 │  PORTAL DE CADASTRO — Vercel (São Paulo)                   │
 │                                                            │
 │  · Login M365 (SSO/Entra ID)                               │
 │  · Formulário multi-etapa, com rascunho salvo              │
 │  · Validação em tempo real: CPF, CNH, placa, ANTT          │
 │  · Upload direto p/ storage (URL assinada, sem passar      │
 │    pela função serverless)                                 │
 │  · Seleção de operação por checkbox (não string com "|")   │
 │  · Acompanhamento e histórico pelo solicitante             │
 └────────────────────────────────────────────────────────────┘
                          │  uma transação
                          ▼
 ┌────────────────────────────────────────────────────────────┐
 │  PostgreSQL — MODELO ESTRUTURADO                           │
 │                                                            │
 │  solicitacoes ──┬── condutores (cpf, cnh, validade...)     │
 │                 ├── veiculos (placa, tipo, ano...)         │
 │                 ├── proprietarios                          │
 │                 ├── documentos (tipo, url, validade)       │
 │                 ├── operacoes_solicitadas (1 por operação, │
 │                 │     com status/parecer individual)       │
 │                 └── eventos  ◄── OUTBOX                    │
 └────────────────────────────────────────────────────────────┘
                          │  evento publicado
                          ▼
 ╔════════════════════════════════════════════════════════════╗
 ║  n8n — ORQUESTRADOR                                        ║
 ║  consome a outbox; garante entrega; tenta de novo          ║
 ╚════════════════════════════════════════════════════════════╝
       │        │        │        │         │         │
       ▼        ▼        ▼        ▼         ▼         ▼
  SharePoint  Teams   E-mail    BI      Rodopar    ELOG
  (arquivo)  (aviso) (retorno) (dados) (cadastro) (cadastro)
                                 │
                                 ▼
                        Power BI / dashboards
```

### Vantagens

**1. Elimina a dependência inteira.**
Sem Forms, sem Power Automate (nem gratuito), sem *polling*, sem intermediário
que possa quebrar. Uma dependência a menos com a Microsoft para cada camada.

**2. Dado estruturado desde a origem — o ganho maior.**
Hoje, `detalhes` é uma string de ~307 caracteres com 11 subcampos separados por
`|`, e `assunto` concatena até 8 operações com separadores vazios
(`MERCADO LIVRE | SHOPEE | | | | | | |`). Nos registros reais aparecem campos
como `TAG: | Placa Cavalo: | Placa Carreta:` e `Rastreador ID: .` — vazios ou
com lixo, porque nada valida na entrada.

Com modelo estruturado:
- **BI direto no banco**, sem parsing frágil de string
- Consulta real: "quantos condutores com CNH vencendo em 30 dias?"
- Impossível gravar CPF inválido ou placa mal formada
- Histórico por condutor, por veículo, por proprietário

**3. Validação na origem, não na correção.**
Barato validar quando a pessoa está com o documento na mão. Caro descobrir
depois, com o cadastro já reprovado.

**4. Resolve o problema dos documentos definitivamente.**
Upload vai para onde vocês decidirem, com o nome que vocês definirem, na pasta
certa, sob a propriedade da organização.

**5. Latência zero.**
`POST` direto, sem fila nem *polling*.

**6. Experiência melhor.**
Rascunho salvo, retomar depois, ver histórico, corrigir e reenviar sem preencher
tudo de novo. O Forms não faz nada disso.

**7. Separação entre captura e distribuição.**
Este é o ponto arquitetural mais importante: **se o n8n cair, o cadastro continua
entrando.** Só a distribuição fica em fila, e se recupera sozinha. Na Fase 1, o
n8n está no caminho crítico; na Fase 2, não está mais.

**8. Base para o resto.**
Autenticado, estruturado e com histórico, o Portal deixa de ser "tela de
aprovação" e passa a ser o sistema de cadastro da Jomed — com API para os outros
sistemas consumirem.

### 9.1 Armazenamento dos documentos — decisão tomada

**Destino definido (29/07/2026): equipe `TRAFEGO - MATRIZ`, biblioteca
`Documentos`, pasta `Controle GR - Frota`.** Por baixo é uma biblioteca do
SharePoint, então herda conformidade do tenant, versionamento, retenção e DLP do
Purview — sem custo adicional e sem tirar o dado pessoal da guarda do M365.

```text
TRAFEGO - MATRIZ / Documentos / Controle GR - Frota /
  ├── FORMS REGISTROS - MICROSOFT/              ← 200 legados (Etapa 0.2)
  │       2026/07/<cpf>-<nome>/...
  └── FORMS REGISTRO - NATIVO PORTAL CADASTRO/  ← formulário nativo
          2026/07/31989919863-carlos-eduardo-moraes/
              CNH.pdf
              ANTT.pdf
              COMPROVANTE-RESIDENCIA.jpeg
              CRLV-CAVALO.pdf
```

A separação entre legado (`MICROSOFT`) e novo (`NATIVO PORTAL`) mantém a migração
dos 200 arquivos isolada do que o formulário nativo passar a gravar.

⚠️ **Limite de caminho:** o SharePoint aceita ~400 caracteres no caminho
completo. Os nomes de pasta escolhidos consomem ~200 antes do arquivo. Isso torna
a **normalização do nome de arquivo obrigatória, não opcional** — nomes originais
do Forms (`WhatsApp Image 2026-07-29 at 08.13.12_Melissa Pontes.jpeg`) chegam
perto do limite.

#### Fluxo de upload — o arquivo não passa pelo Vercel

```text
 1. navegador → Portal:  "quero enviar CNH.pdf"
 2. Portal (credencial de app) → Graph:  createUploadSession
 3. Graph → Portal:  uploadUrl temporária
 4. navegador → PUT direto na uploadUrl  ─────────────► SharePoint
 5. Portal → Postgres:  driveId + itemId + tipo + validade
```

Isso contorna o **limite de ~4,5 MB de corpo de requisição** das funções
serverless do Vercel: o arquivo vai do navegador direto para o SharePoint.

#### Fluxo de exibição — corrige o problema atual das miniaturas

```text
 1. navegador → Portal:  "mostra o documento 123"
 2. Portal:  confere sessão e papel
 3. Portal → Graph:  obtém @microsoft.graph.downloadUrl (pré-autenticada, ~1h)
 4. Portal → navegador:  302 redirect
```

Hoje o `img src` aponta direto para o SharePoint, e a miniatura só renderiza se a
pessoa estiver logada no M365. Com o Portal intermediando pela credencial de
aplicação, **qualquer usuário logado no Portal vê o documento** — sem sessão M365.

#### Cuidados obrigatórios

| Risco | Por quê | Mitigação |
|---|---|---|
| 🔴 **`Sites.Selected` é por SITE, não por pasta** | Limitação do Graph: autorizar o app em `TRAFEGO - MATRIZ` dá acesso a **toda** a biblioteca `Documentos` (abastecimento, notas e fichas, sensores, GERAL). Não há como escopar só em `Controle GR - Frota` | Decisão consciente, aceita em 29/07: conveniência sobre isolamento. **Único isolamento real seria um site/equipe dedicado.** Reforça a importância de usar certificado (não *secret*) e de rotacionar credencial |
| 🔴 **Todo membro de `TRAFEGO - MATRIZ` vê CNH e CPF** | A pasta herda permissão da biblioteca, onde trabalha gente de várias áreas | **Quebrar a herança** nas duas pastas novas: ⋯ → Gerenciar acesso → Avançado → Parar de herdar → remover "Membros de TRAFEGO - MATRIZ" → grupo `GR - Cadastro` (leitura) + app e 2 admins (edição). **Fazer ANTES de mover os 200 arquivos** — mexer em permissão de pasta cheia é mais arriscado |
| **Política de expiração de Grupo do M365** | Grupo sem atividade é excluído automaticamente, e o site vai com ele. Uma equipe usada só como repositório é exatamente o perfil "inativo" | Confirmar com o TI; **excluir esta equipe da política** ou marcar como permanente |
| **Membro pode excluir arquivo pelo Teams** | Interface dá o botão de excluir a qualquer membro | Versionamento + **política de retenção no Purview** (impede exclusão definitiva). Rigor maior: Tráfego só com leitura; escrita apenas para o app e 2 administradores |
| **URL como referência quebra** | Renomear ou mover invalida a URL | Guardar **`driveId` + `itemId`**, que sobrevivem a renomear e mover |

#### Consolidado

| Item | Decisão |
|---|---|
| Onde | `TRAFEGO - MATRIZ` / `Documentos` / `Controle GR - Frota` |
| Subpastas | `FORMS REGISTROS - MICROSOFT` (legado) e `FORMS REGISTRO - NATIVO PORTAL CADASTRO` (novo) |
| Permissão do app | `Sites.Selected` no site `TRAFEGO - MATRIZ` — ⚠️ alcança a biblioteca toda |
| Permissão das pastas | Herança quebrada; grupo `GR - Cadastro` |
| Referência no banco | `driveId` + `itemId` (**nunca** URL) |
| Upload | `createUploadSession` → PUT direto do navegador |
| Exibição | `@microsoft.graph.downloadUrl` + 302 do Portal |
| Proteção | Versionamento + retenção Purview + fora da política de expiração |

#### Alternativa, se o Graph travar

Se o App Registration com `Sites.Selected` não sair, ou se não houver apetite
para lidar com Graph, o **Supabase Storage** entrega o mesmo resultado funcional
com muito menos esforço (URL assinada, RLS, ao lado do banco). O preço é o dado
pessoal sair da guarda do M365 e ficar em Oregon — e nesse caso **a migração do
banco para São Paulo deixa de ser recomendação e passa a ser requisito** (0.4).

#### Volumetria e custo

~750 arquivos/mês (190 solicitações × 3,9 anexos). A ~400 KB de média
(*estimativa* — os arquivos exigem autenticação e não foram medidos), dá
**~300 MB/mês, ~3,6 GB/ano**. Irrelevante em qualquer opção: aqui o critério é
**conformidade, não custo**.

### Estimativa de esforço

| Item | Esforço |
|---|---|
| Modelagem e migração do schema | 3–5 dias |
| Configurar equipe/biblioteca + permissões + retenção | 1–2 dias |
| Formulário multi-etapa com validação | 8–12 dias |
| Upload direto com URL assinada + Graph | 4–6 dias |
| Login SSO M365 (substituir senha local) | 3–5 dias |
| Outbox + integração com n8n | 3–4 dias |
| Migrar dados existentes p/ modelo novo | 2–3 dias |
| Testes e implantação gradual | 5–7 dias |
| **Total** | **~30–40 dias úteis** |

Recomendo **migração por operação**, não por data: começar com uma (Jomed, que é
interna), validar, e ir movendo Mercado Livre, Shopee e Amazon. As duas entradas
convivem no mesmo painel durante a transição.

---

## 10. Análise crítica

### Vale a pena continuar usando o Microsoft Forms?

**No curto prazo, sim. Como plataforma definitiva, não.**

A favor: já está pago, as pessoas sabem usar, não exige desenvolvimento, e os
documentos ficam no M365 (bom para conformidade).

Contra — e o peso está aqui:

1. **Não tem API.** Isso não é detalhe: é o que obriga a existir um intermediário
   e um *polling* na arquitetura. Todo desenho fica pior por causa disso.
2. **Uploads vão para OneDrive pessoal.** O problema 0.1 é consequência direta do
   funcionamento do Forms, e não tem configuração que resolva.
3. **Sem validação.** Os dados reais mostram: `Rastreador ID: .`, TAG vazia,
   placas em branco. O Forms não valida CPF, placa nem data.
4. **Sem estrutura.** Forçou a gambiarra de concatenar com `|`, que agora precisa
   ser desmontada por código em toda leitura.
5. **Sem estado.** Não dá para salvar rascunho, corrigir ou reenviar.

**Veredito:** o Forms foi a escolha certa para começar rápido — e cumpriu esse
papel. Mas hoje ele é a origem de três dos quatro achados críticos deste
documento. Mantenha como fachada durante a migração do n8n, e substitua.

### Vale a pena migrar para formulário próprio?

**Sim, e eu trataria como prioridade — não como "futuro".**

O argumento não é técnico, é de qualidade de dado. Vocês estão construindo um
histórico de cadastro de terceiros que vai ser consultado por anos. Cada mês a
mais com dado semiestruturado é mais dívida para limpar depois. Os 51 registros
atuais já vão precisar de tratamento; 500 vão precisar de um projeto.

**Ressalva honesta:** são ~30–40 dias úteis de desenvolvimento. Não é trivial, e
compete com o prazo da licença. Por isso a recomendação é **sequencial e não
simultânea**: resolva o n8n primeiro (obrigatório, com prazo), e comece o
formulário em paralelo a partir da Semana 6, quando o n8n já estiver em teste.

### O n8n substitui o Power Automate neste cenário?

**Sim — com folga, e vai além.**

O uso atual do Power Automate é raso: um gatilho, uma transformação e um `POST`.
O n8n cobre isso com muito espaço sobrando, e habilita os ~30 fluxos da seção 7
que hoje não existem por causa do custo marginal de licença.

**O que o n8n não substitui:** o gatilho nativo do Forms. Mas isso é limitação da
Microsoft, e a Opção B contorna com conector gratuito.

**O que muda de verdade:** vocês deixam de ser usuários de um SaaS e passam a
operar um serviço. É a mudança mais significativa desta migração, e é
organizacional, não técnica.

### Dificuldades previstas

| Dificuldade | Probab. | Impacto | Como reduzir |
|---|---|---|---|
| **App Registration travar no TI/admin** | 🔴 Alta | 🔴 Alto | **Solicitar na Semana 1.** É o maior risco de cronograma — depende de terceiros |
| **Duplicação no teste em paralelo** | 🔴 Alta | 🔴 Alto | Etapa 0.1 (`origem_id`) é pré-requisito absoluto |
| **Premissa da planilha sincronizada não se confirmar** | 🟠 Média | 🟡 Médio | Por isso a recomendação é Opção B (lista SharePoint), que não depende disso |
| **Conhecimento concentrado em uma pessoa** | 🔴 Alta | 🔴 Alto | Treinar um segundo na Etapa 4; documentar cada fluxo |
| **Ninguém assumir a operação do servidor** | 🟠 Média | 🔴 Alto | **Se for o caso, escolha n8n Cloud.** Melhor pagar do que ter servidor órfão |
| **Prazo de 90 dias apertado** | 🟠 Média | 🔴 Alto | Cronograma tem 4 semanas de folga; começar já |
| **Credencial vencer em silêncio** | 🟠 Média | 🔴 Alto | Certificado em vez de secret + alerta 30 dias antes. **Já aconteceu com o token do Turso em 24/07** |
| **Disco cheio por log de execução** | 🟠 Média | 🟡 Médio | `EXECUTIONS_DATA_PRUNE` desde o primeiro dia |
| **Rodopar/ELOG sem API** | 🟠 Média | 🟡 Médio | Levantar antes de prometer; acesso a banco ou RPA como plano B |
| **Atualização do n8n quebrar fluxo** | 🟡 Baixa | 🟡 Médio | Versão fixada; testar em homologação |
| **Resistência dos usuários** | 🟡 Baixa | 🟢 Baixo | Na Fase 1 nada muda para quem preenche |

### Custos aproximados

*Câmbio de referência: US$ 1 ≈ R$ 5,40; € 1 ≈ R$ 6,30. Valores de lista em
jul/2026, conferir na contratação.*

**Cenário A — Econômico (recomendado para começar)**

| Item | US$/mês | R$/mês |
|---|---|---|
| VPS Hetzner CX22 (2 vCPU, 4 GB) | ~5 | ~30 |
| Supabase Pro | 25 | ~135 |
| Backup off-site (Backblaze B2) | ~1 | ~5 |
| Cloudflare | 0 | 0 |
| Monitoramento (Uptime Kuma no VPS) | 0 | 0 |
| Vercel (se Hobby atender) | 0 | 0 |
| **Total** | **~31** | **~170** |

**Cenário B — Recomendado (Brasil + conformidade)**

| Item | US$/mês | R$/mês |
|---|---|---|
| VPS São Paulo (Vultr/DO, 2 vCPU, 4 GB) | 12 | ~65 |
| Supabase Pro (`sa-east-1`) | 25 | ~135 |
| Vercel Pro (uso comercial) | 20 | ~110 |
| Backup off-site | ~2 | ~10 |
| Monitoramento (Better Stack) | ~0–8 | ~0–45 |
| **Total** | **~59–67** | **~320–365** |

**Cenário C — Zero operação (se não houver quem cuide)**

| Item | US$/mês | R$/mês |
|---|---|---|
| n8n Cloud (plano inicial) | ~24–54 | ~130–290 |
| Supabase Pro | 25 | ~135 |
| Vercel Pro | 20 | ~110 |
| **Total** | **~69–99** | **~375–535** |

**Comparação com o Power Automate Premium**

| Cenário | R$/mês (aprox.) |
|---|---|
| Power Automate Premium — 3 usuários × US$ 15 | ~245 |
| Power Automate Process — 1 fluxo × US$ 150 | ~810 |
| **n8n Cenário A** | **~170** |
| **n8n Cenário B** | **~320–365** |
| **n8n Cenário C** | **~375–535** |

**Leitura honesta dos números:** a economia direta é modesta — nos cenários B e C
o custo pode até **empatar ou subir** em relação a 3 licenças Premium. Boa parte
do valor no Cenário B não é n8n, é infraestrutura que vocês **já deveriam ter**
(Supabase Pro para não hibernar, Vercel Pro para uso comercial).

**Onde o ganho está de verdade:**

1. **Custo marginal zero para novos fluxos.** Os ~30 fluxos da seção 7 sairiam de
   graça em infraestrutura. No Power Automate Premium, cada fluxo novo é decisão
   orçamentária. **É aqui que mora o valor real.**
2. **Não depende de renovação de licença** — o problema que originou tudo isso.
3. **Capacidade técnica interna** — sem *lock-in*.

**Não vendam esta migração como economia de custo.** Vendam como **eliminação de
risco de licença + habilitação de automação em escala**. Se o argumento for só
preço, os números não sustentam sozinhos.

### Recomendação para a Jomed

**Migre para o n8n, mas trate os quatro achados da seção 0 primeiro.**

O raciocínio, em ordem de importância:

**1. O risco urgente não é a licença — são os 200 documentos.** A licença vence
em 90 dias com aviso. A conta do OneDrive pessoal pode ser desativada amanhã, sem
aviso, e não há cópia. **Comece por aí, esta semana**, independente do n8n.

**2. Corrija o `origem_id` antes de qualquer teste.** É a diferença entre uma
migração segura e duplicar a base inteira. Cinco minutos de trabalho.

**3. Sim ao n8n, pela Opção B.** Mantenha o Forms como fachada, use o Power
Automate *standard* (gratuito) como ponte para uma lista do SharePoint, e deixe o
n8n assumir dali. Contorna a licença, ganha uma fila durável, e permite o teste
em paralelo com rollback trivial.

**4. Decida quem cuida do servidor — de verdade.** Esta é a pergunta que define a
opção de hospedagem, e a resposta honesta importa mais que o preço. Se houver
alguém com tempo e disposição para operar um Linux, VPS + Coolify a R$ 30/mês é
excelente. **Se a resposta for "damos um jeito", escolha n8n Cloud.** Servidor
órfão em produção custa muito mais que a diferença de R$ 200/mês. Não há vergonha
nessa escolha — vocês continuam com n8n, fluxos portáveis e sem *lock-in*, e podem
internalizar quando houver equipe.

**5. Comece o formulário nativo em paralelo.** É o que resolve na raiz. Cada mês
de Forms é mais dado semiestruturado para limpar depois.

**6. Ajuste o básico da infraestrutura:** Supabase Pro, região São Paulo, plano do
Vercel. Não é glamouroso, mas é o que impede que um sistema de produção hiberne.

**7. Não deixe o conhecimento em uma pessoa.** É o risco mais subestimado. Uma
automação que ninguém além de você entende é uma dependência pior que a licença
que estamos eliminando.

### Roadmap

```text
2026
 JUL │ ██ Etapa 0 — correções críticas (documentos, origem_id, Supabase Pro)
 AGO │ ████████ Etapas 1–3 — n8n provisionado, homologação, fluxo construído
     │      └── App Registration no Entra ID (iniciar já — lead time)
 SET │ ████████ Etapa 4 — paralelo + conciliação diária
     │ ██ Etapa 5 — produção
     │ ░░░░ início do formulário nativo (Fase 2)
 OUT │ ██ Etapa 6 — desativa Power Automate Premium
     │ ░░░░░░░░ formulário nativo em desenvolvimento
     │ ██ fluxos P1: notificações, cobrança de pendência, documento faltando
 NOV │ ░░░░ formulário nativo em homologação
     │ ██ fluxos P2: validação de CPF, vencimento de CNH/ANTT
 DEZ │ ██ formulário nativo — piloto na operação Jomed
     │ ██ integração Rodopar
2027
 JAN │ ██ formulário nativo — Mercado Livre, Shopee, Amazon
 FEV │ ██ desativa Microsoft Forms
     │ ██ integração ELOG
 MAR │ ██ expansão: GR e Programação
 ABR │ ██ expansão: SAC e Expedição
 MAI │ ██ expansão: RH
 JUN │ ██ consolidação de BI sobre modelo estruturado
```

### Benefícios esperados

**Curto prazo (90 dias)**
- Risco de licença eliminado
- Documentos protegidos em local corporativo
- Deduplicação efetivamente funcionando
- Notificações em Teams e e-mail — inexistentes hoje
- Banco de produção com backup e sem hibernação

**Médio prazo (6 meses)**
- ~10 automações em produção, várias fora do Tráfego
- Dados estruturados e validados na origem
- BI direto no banco, sem parsing de string
- Redução do trabalho manual de conferência

**Longo prazo (12 meses)**
- Plataforma de automação para toda a empresa
- Integração com Rodopar e ELOG
- Cadastro como sistema de referência, com API
- Capacidade técnica interna, sem dependência de licença por fluxo

---

## Anexo A — Contrato atual do webhook

Mantido inalterado na Fase 1. O n8n deve reproduzi-lo exatamente.

```
POST /api/forms/webhook
x-webhook-secret: <FORMS_WEBHOOK_SECRET>
Content-Type: application/json
```

| Campo | Obrigatório | Observação |
|---|---|---|
| `solicitante_email` | ✅ | Deve casar com o e-mail de login |
| `assunto` | ✅ | Operações separadas por `\|` |
| `solicitante_nome` | — | Cai para o e-mail se ausente |
| `detalhes` | — | Texto livre |
| `anexo` | — | Link único (legado) |
| `anexos` | — | Lista `[{nome, url}]` — **preferir este** |
| `origem_id` | ⚠️ **usar sempre** | `responseId` do Forms. **Hoje nunca é enviado** |

Qualquer chave começando com `anexo` (ex.: `anexo cnh`, `anexo placa 1`) é
agregada à lista de documentos.

**Respostas:** `200` (`{ok, duplicada, id}`) · `400` campo obrigatório ausente ·
`401` segredo inválido · `503` webhook desligado no servidor.

---

## Anexo B — Formato real dos dados (produção)

Base para escrever o nó de normalização.

**Campo `assunto`** — operações concatenadas, com separadores vazios:
```
MERCADO LIVRE | SHOPEE |  |  |  |  |  |  |
```
Operações distintas encontradas: `MERCADO LIVRE`, `SHOPEE`, `AMAZON`, `JOMED`.

**Campo `detalhes`** — 11 subcampos em uma string (~307 caracteres):
```
Condutor: Carlos Eduardo de Moraes Henrique | CPF: 31989919863 |
EMAIL: carlos@gmail.com | Contato MOT: 47 8869-7821 | Proprietário: Rodrigo |
Contato Prop: 11 96304-0076 | TAG:  | Placa Cavalo:  | Placa Carreta:  |
Rastreador ID: . | OBS:
```
Observe: `TAG`, `Placa Cavalo` e `Placa Carreta` vazios; `Rastreador ID` com `.`.
Sintoma de ausência de validação na origem.

**Campo `anexos`** — JSON com `nome` e `url`:
```json
[
  { "nome": "CNH-e.pdf-4_Melissa Pontes.pdf",
    "url":  "https://jomedlog-my.sharepoint.com/personal/operacional_01_.../CNH%20CONDUTOR/..." },
  { "nome": "Certificado_057442055_Melissa Pontes.pdf",
    "url":  "https://jomedlog-my.sharepoint.com/personal/operacional_01_.../ANTT/..." }
]
```
**Todos os 200 anexos estão no OneDrive pessoal** — problema 0.1.

**Volumetria (21–29/07/2026):** 51 solicitações · pico 17/dia · média 6,4/dia ·
3,9 anexos por solicitação (máx. 9) · 5 solicitantes distintos.

---

## Anexo C — Checklist de decisão

Perguntas a responder antes de aprovar o projeto:

- [ ] **Quem será o responsável técnico pelo servidor do n8n?** (define VPS vs Cloud)
- [ ] Existe orçamento aprovado de ~R$ 200–400/mês de infraestrutura?
- [ ] O administrador do tenant M365 pode criar App Registration com `Sites.Selected`?
- [ ] O Rodopar tem API REST? Roda em SQL Server?
- [ ] O ELOG tem API ou integração por arquivo?
- [ ] Existe política de retenção definida para documento de condutor?
- [ ] O tenant tem **política de expiração de Grupo do M365** ativada? Se sim, a equipe de cadastro está excluída dela?
- [ ] Quem terá permissão de **escrita** na biblioteca (idealmente: só o app + 2 administradores)?
- [ ] Há aprovação para hospedar dado pessoal fora do Brasil, ou migrar para São Paulo?
- [ ] Qual o plano atual do Vercel?
- [ ] Quem será a segunda pessoa treinada nos fluxos?
- [ ] Há verba/tempo para os ~30–40 dias do formulário nativo?
```
