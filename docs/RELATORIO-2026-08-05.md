# Relatório — 5 de agosto de 2026

Portal TRÁFEGO — Cadastro · Jomed Transportes e Logística

Nove commits, todos em produção. Este documento registra o que mudou, as
decisões que valem revisão, e o que fica pendente.

---

## Resumo

| Entrega | Situação |
|---|---|
| Etapa RDO com anexo obrigatório na reprovação | pronto |
| Painel "Minhas solicitações" reconstruído | pronto |
| Grau de importância e fila por prioridade | pronto |
| Tempos operacionais e previsão de conclusão | pronto |
| Espelho automático no canal do Teams | pronto |
| Anexos aparecendo no painel | pronto |
| Quatro defeitos corrigidos | detalhados abaixo |
| **Perda de dados causada por um teste meu** | **7 anexos apagados** |

---

## 1. O que aconteceu de errado

**Apaguei os 7 anexos do cadastro #114.** Um teste de anexos tinha a limpeza
escrita como `DELETE FROM documentos` sem filtro, e varreu a tabela inteira em
vez de apagar só o que ele mesmo criou. Os arquivos saíram do banco e do
Supabase Storage.

Não houve recuperação: o Supabase não tem versionamento, e o espelho para o
canal ainda não rodava naquele momento — não existia cópia em lugar nenhum.

Corrigido em dois testes que tinham o mesmo defeito. Agora cada um guarda os
ids do que criou, e a limpeza só alcança esses. O espelho automático (seção 5)
faz com que um erro assim deixe de ser perda definitiva.

**Pendente:** reenviar os 7 documentos do #114.

---

## 2. Etapa RDO

O processo tem duas etapas, e até hoje só a segunda existia no sistema:

1. **Pesquisa RDO** — consulta interna, antes de acionar as gerenciadoras.
2. **Gerenciadoras** — decisão por cliente, como já era.

Reprovar no RDO encerra o cadastro: não vai às gerenciadoras, e as rotas de
decisão passam a recusar. Decisões que já existissem deixam de valer.

**Reprovar exige o comprovante já anexado.** A conferência acontece antes de
gravar — gravar primeiro e cobrar o anexo depois deixaria cadastros reprovados
sem prova, que é exatamente o registro que uma auditoria procura. Ficam
gravados quem reprovou, quando, a observação e o documento.

A regra vive na camada de dados, não só na tela. A tela é uma cópia da regra;
aquela é a original.

---

## 3. Painel "Minhas solicitações"

Deixou de ser um histórico de cinco colunas e virou o acompanhamento do ciclo
completo: **12 indicadores**, **7 filtros** e **13 colunas**.

### Status

| | Quando |
|---|---|
| Em análise | enviado, ninguém assumiu |
| Aguardando RDO | assumido, falta responder o RDO |
| Em andamento | RDO liberado, decidindo os clientes |
| Pendente Shopee / Amazon | esperando retorno externo |
| Reprovado no RDO | parou na pesquisa interna |
| Aprovado / Reprovado / **Aprovado em parte** | terminado |

Sobre o "Parcial": **ele já existia e já funcionava** exatamente como pedido —
todos aprovados dá Aprovado, todos reprovados dá Reprovado, misturado dá o
terceiro estado. Mudou só o rótulo, para *Aprovado em parte*.

*Pendente Shopee* só aparece quando a Shopee é o **único** cliente sem decisão.
Com outros em aberto, o gargalo está aqui dentro, e apontar a Shopee mandaria
cobrar a pessoa errada.

### Previsão de conclusão

Base de 60 min (RDO 30 + Opentech/BRK/Shopee 30), mais 10 min por item
adicional:

```
motorista                       → 1 h
motorista + 1 veículo           → 1 h 10 min
motorista + 2 veículos          → 1 h 20 min
motorista + 3 veículos          → 1 h 30 min
motorista + 2 veículos + Shopee → 1 h 20 min  + até 24 h (externo)
```

O Rodopar não entra na conta: roda em paralelo ao RDO e não empurra o total.

**A dependência externa fica separada, não somada.** Somar 24 h daria uma
previsão de 25 horas para um trabalho de uma hora, e esconderia que o atraso
não é interno — que é justamente o que o painel existe para mostrar.

### Tempos

Conferidos com o exemplo do pedido (08:00 → 08:15 → 09:05): 15 min para
assumir, 50 min operacional, 1 h 5 min total. Mais decorrido, restante e um
alerta em vermelho quando estourou a previsão.

O campo `finalizado_em` é novo. Não deu para usar `revisado_em`: ele muda a
cada decisão por cliente, então carimbaria o último clique e não o
encerramento. Grava uma vez só — mexer de novo no cadastro não reescreve
quando ele fechou.

**"Tempo médio" conta só cadastro finalizado.** Incluir os em curso puxaria a
média para baixo e faria o número melhorar sozinho a cada envio novo.

### Filtros

No navegador, por decisão sua. São cem cadastros; filtrar aqui responde no
mesmo quadro, sem ida ao servidor a cada tecla. **Ponto de virada: por volta de
dois mil registros**, vale mover para o servidor com paginação.

O filtro de data compara a data **local**, não o texto UTC do banco — pelo
texto cru, um cadastro das 23 h cairia no dia seguinte.

---

## 4. Grau de importância

Campo obrigatório no formulário de terceiros:

| | |
|---|---|
| 🔴 | Vai carregar em instantes |
| 🟡 | Urgente |
| 🟢 | Pode aguardar |

Obrigatório **sem valor padrão**, de propósito: com um padrão silencioso todo
mundo deixa no padrão e a informação some. Quem envia sabe se o motorista vai
carregar em seguida; a fila não tem como adivinhar.

### Ordem da lista

A lista chega **por data, da mais recente para a mais antiga** — é como ela é
lida no dia a dia. Um botão nos dois painéis alterna para a **fila**:
"Ordenar por prioridade" ⇄ "Ordenar por chegada".

Impor a prioridade sempre escondia o cadastro que acabou de chegar atrás de uma
fila de urgentes antigos, e nem toda leitura da lista é "quem atendo agora".
Com o botão, quem quer a fila pede a fila.

Na fila, o grau que o solicitante preencheu manda, e dentro do mesmo grau quem
esperou mais vem primeiro. Cadastro enviado antes do campo existir vai para o
fim e mostra um traço, em vez de fingir "pode aguardar" — seria inventar uma
escolha que ninguém fez.

---

## 5. Espelho no canal do Teams

A pasta do canal ficava vazia porque o espelho era um comando que alguém
precisava lembrar de rodar. Ficou uma ponta solta quando os documentos
voltaram para o Supabase.

Agora existe a tarefa agendada **`TRAFEGO - Espelhar canal`**, a cada 10
minutos, sem janela aberta. Verificado com um anexo real: apareceu na pasta em
~14 s, conteúdo idêntico, e a segunda passada não recopia.

Copia só **terceiro e agregado** — candidato é RH e não pertence à pasta da
operação de frota, que é compartilhada.

Log em `logs/espelho.log`.

---

## 6. Defeitos corrigidos

**Anexos não apareciam no painel.** O detalhe lia só a coluna dos links do
Microsoft Forms. Um cadastro nativo, com sete arquivos no storage, exibia
"Nenhum documento anexado". Os dois blocos agora aparecem separados — um mora
no SharePoint, outro no nosso storage, e saber a origem importa no meio de uma
análise.

**Todas as datas apareciam 3 horas adiantadas.** O banco grava em UTC e as
telas mostravam o valor cru. Passava despercebido porque a diferença é
constante; o caso feio era o fim do dia, quando um registro das 23:30 aparecia
como 02:30 **do dia seguinte**. A conversão foi para um lugar só.

**A validação ficava até 1 hora desatualizada no navegador.** O arquivo era
servido com cache fixo de 3600 s, então após um deploy o formulário rodava com
a regra anterior — sem erro visível. Foi o que fez as listas de TAG e
rastreador aparecerem vazias. Agora o navegador revalida e recebe 304.

**Storage desligado em produção.** A variável `SUPABASE_SERVICE_KEY` existia na
Vercel mas **estava sem valor**. O diagnóstico agora diz qual parte falta — a
chave ou a URL do projeto — em vez de um "não configurado" genérico.

---

## 7. Anexos mais rápidos

O custo era latência, não volume:

| | |
|---|---|
| 1 URL assinada | ~900 ms |
| 7 em paralelo (antes) | 1023 ms |
| **7 em lote (agora)** | **573 ms** |

Além disso o painel adianta a busca quando o modal de atendimento abre — o
tempo gasto escolhendo cobre o carregamento.

---

## 8. Verificações

| Suíte | Itens |
|---|---|
| Validação (CPF, CNPJ, PIS, placa, telefone, datas, CNH, prioridade) | 139 |
| Fluxo RDO → gerenciadoras | 15 |
| Grau de importância e ordem da fila | 10 |
| Atendimento (disputa entre duas pessoas) | 18 |
| Anexos nos três módulos | 12 |
| Espelho no canal | 9 |
| Tarefa agendada | 8 |

---

## 9. Pendências

### Da Jomed

- **Reenviar os 7 documentos do #114** (apagados pelo meu teste).
- **Rotacionar a `SUPABASE_SERVICE_KEY`** — circulou em texto puro.
- **Quebrar a herança de permissão** da pasta do canal antes que ela encha de
  CPF e CNH; hoje é visível para toda a equipe `TRAFEGO - MATRIZ`.
- Consentimento do `Sites.Selected` com o TI.
- Copiar os ~200 documentos antigos do OneDrive pessoal do `operacional_01`.
- Criar os logins de melissa.pontes, fabio.alves, ellen.karine e
  renan.vasconcelos.

### Do sistema

- **Cota do Supabase**: ~670 MB/mês contra 1 GB do plano free — cerca de 6
  semanas até encher. Decisão adiada, mas não passa do mês.
- Cron para evitar a hibernação do Supabase.
- Remapear os 200 links antigos depois da cópia.
- Mover os filtros para o servidor quando passar de ~2 mil cadastros.
