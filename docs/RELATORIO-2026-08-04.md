# Relatório — 4 de agosto de 2026

Portal TRÁFEGO — Cadastro · Jomed Transportes e Logística

Sete commits, todos no ar em `trafego-cadastro.vercel.app`. Este documento
registra o que mudou, o que foi verificado e o que fica pendente.

---

## Resumo

| Entrega | Situação |
|---|---|
| Anexos nos três formulários (terceiro, agregado, candidato) | pronto e testado |
| Módulo terceiro liberado para o time (não é mais só admin) | pronto |
| Sistema de atendimento (responsável / colaborador) | pronto e testado |
| Espelho dos documentos no canal do Teams | pronto e testado |
| Diagnóstico do armazenamento na tela de admin | pronto |
| Três defeitos encontrados e corrigidos | detalhados abaixo |

**Onde os documentos ficam:** no Supabase Storage, que é o que o site alcança
de qualquer lugar. O canal do Teams recebe cópia pelo espelho. A decisão de
gravar direto no canal foi revertida — funcionava só com o portal rodando na
máquina do Victor, e em produção o arquivo não abria.

---

## 1. Anexos nos três formulários

O envio já funcionava; o que estava errado era o texto da tela, que dizia "o
envio de arquivos ainda não está ligado" — sobra de quando realmente não
estava. As duas telas agora explicam o comportamento real.

**A área de anexos aparece depois de salvar.** Não é limitação: o envio precisa
do id da solicitação para saber a que cadastro o arquivo pertence, e esse id só
existe depois que o cadastro é gravado.

Verificado pelas rotas reais:

| Módulo | Documentos configurados | Resultado |
|---|---|---|
| Terceiro | 7 | `foto do whatsapp 2026.pdf` → `CNH_DO_CONDUTOR.pdf` |
| Agregado | 6 | idem |
| Candidato | 4 | `foto do whatsapp 2026.pdf` → `CNH.pdf` |

Em todos: pasta `NOME_CPF`, renomeação pelo tipo do documento, e a exportação
em ZIP enxergando o arquivo.

### Módulo terceiro liberado

Estava restrito a admin enquanto o upload era construído. Com os anexos
funcionando, o time inteiro usa.

---

## 2. Sistema de atendimento

Antes de abrir um cadastro, aparece o modal **"Como você deseja participar
deste cadastro?"**, com três opções: assumir o atendimento, participar como
colaborador, ou cancelar.

Fica registrado nome, e-mail, data/hora e o tipo de participação. Na listagem,
cada linha passa a mostrar:

```
Em atendimento
Victor Diniz
+ 2 colaboradores
04/08/2026 às 14:35
```

### Três decisões que valem registro

**A regra de "um responsável" vive no banco, não no código.** Duas pessoas
clicando no mesmo segundo passariam por qualquer verificação feita antes de
gravar — o banco é o único ponto que enxerga as duas. É um índice único
parcial, e o teste confirma que ele segura.

**Transferência existe, mas só admin e só pedindo de propósito.** Sem isso, um
cadastro cujo responsável entrou de férias ficaria travado até alguém mexer no
banco na mão. O responsável anterior vira colaborador em vez de sumir — ele
trabalhou no cadastro, e apagar isso apagaria o histórico.

**Sair grava a data de saída, não apaga a linha.** A pergunta "quem mexeu neste
cadastro" precisa de resposta depois que a pessoa sai.

### Uma adaptação

O painel de agregado e candidato não tem "abrir" — decide direto na linha. Ali
a pergunta vem antes de **decidir**, que é o momento equivalente de pegar o
cadastro, e há um botão de fone de ouvido para quem só quer acompanhar sem
decidir nada.

---

## 3. Onde os documentos ficam

Houve uma mudança de rumo no meio do caminho, e vale explicar por quê.

A primeira decisão foi gravar direto na pasta do canal do Teams, sincronizada
pelo OneDrive. Funcionou: implementei, testei, os arquivos chegaram ao canal.
Mas essa pasta existe só na máquina do Victor. Em produção, na Vercel, o
registro aparecia na tela e o arquivo não abria.

Com o requisito "preciso acessar o documento quando a gente quiser", o Supabase
voltou a ser o destino: é o único armazenamento que os dois ambientes alcançam.
O canal continua recebendo cópia, pelo espelho.

### O espelho (`npm run sincronizar-canal`)

Roda na máquina do Victor, baixa do Supabase o que ainda não está na pasta, e o
OneDrive sobe para o canal.

```
npm run sincronizar-canal              (uma passada)
npm run sincronizar-canal -- --observar (fica rodando, a cada 60s)
```

Verificado: copia os arquivos, **não** recopia na segunda passada, repõe
arquivo truncado, e **nunca apaga** — arquivo sem correspondência no portal é
apenas reportado. Apagar arquivo de pasta compartilhada por decisão automática
seria arriscado demais.

### O que ainda falta decidir: cota

| | |
|---|---|
| Cadastros | ~200/mês (92 em 14 dias) |
| Anexos por cadastro | 8,6 (média real) |
| Tamanho médio | ~390 KB (medido nos 11.758 arquivos do Forms) |
| **Volume** | **~670 MB/mês** |

O plano free do Supabase são **1 GB** — enche em cerca de **6 semanas**.

Três saídas, na ordem em que eu recomendo:

1. **Sites.Selected via Graph** — uma cópia só, no canal, e o site lê de lá
   rodando na Vercel. É a solução certa. Depende da liberação do TI.
2. **Supabase Pro, US$ 25/mês** — 100 GB, cerca de 12 anos no volume atual.
   Resolve enquanto a 1 não sai, e custa menos que a licença Premium do Power
   Automate que estamos tentando eliminar.
3. **Free + limpeza** — manter no Supabase só os cadastros recentes. Barato,
   mas contraria o requisito: o documento antigo não abriria no site.

Ficou combinado tratar isso depois.

---

## 4. Defeitos encontrados e corrigidos

Os três apareceram durante os testes, antes de chegarem em vocês.

### Caminho de arquivo aceito sem conferência

A validação do caminho morava dentro do provedor de pasta. No Supabase
**qualquer chave é válida**, então dois problemas passavam:

- `FORA/x.pdf` gravava na raiz do bucket (aconteceu de verdade num teste; o
  objeto foi removido);
- o registro aceitava um caminho apontando para o arquivo de **outro cadastro** —
  daria para fazer a CNH de uma pessoa aparecer no cadastro de outra.

A validação passou para junto de onde os caminhos são construídos, e vale para
os dois provedores e para as duas rotas que recebem caminho do navegador.
Formato aceito, e só ele: `CADASTROS/<pasta do cadastro>/<arquivo>`, com
extensão pdf, jpg, jpeg ou png.

### Arquivo órfão travava o reenvio para sempre

Se o registro sumisse do banco e o arquivo ficasse no storage, aquele documento
**nunca mais** podia ser enviado: a tela mostrava "Erro interno", sem nenhuma
forma de consertar pelo portal. Faltava `upsert` na assinatura do upload — e
ele vai no cabeçalho `x-upsert`, não no corpo (no corpo o Supabase ignora
silenciosamente).

### Timeout de conexão virando "Erro interno"

O pooler do Supabase hiberna no plano free, e a primeira conexão depois disso
estoura o tempo. Isso apareceu várias vezes durante o dia e teria aparecido no
teste de vocês.

Agora a consulta é repetida até 3 vezes, com espera crescente (300ms, 900ms), e
**só** quando a falha foi ao conseguir a conexão — nesse caso o banco não chegou
a ver a consulta, e repetir é seguro até para INSERT. Queda no meio da consulta
não é repetida, porque um INSERT pode ter sido aplicado e repetir duplicaria o
registro.

---

## 5. Diagnóstico do armazenamento

Rota nova, só para admin: `GET /api/admin/armazenamento`.

Responde qual provedor está em uso, se ele está funcionando (faz uma escrita e
uma leitura de verdade, e apaga em seguida), o limite de tamanho e o bucket.
Não devolve nenhuma chave.

Existe porque a configuração do storage é invisível pela tela: se a chave do
Supabase não estiver na Vercel, o upload recusa e ninguém sabe por quê.

**Junto com isso, uma proteção:** o sistema não cai mais no armazenamento em
memória sozinho. Memória aceita o arquivo e o perde no reinício — em produção
seria upload que parece funcionar e some, e ninguém descobre até precisarem do
documento. Sem armazenamento configurado, agora recusa dizendo isso.

---

## 6. O que foi verificado

| Verificação | Itens | Situação |
|---|---|---|
| Validação (CPF, CNPJ, placa, telefone, datas, CNH) | 106 | passando |
| Anexo nos três módulos | 12 | passando |
| Sistema de atendimento | 18 | passando |
| Espelho no canal | 9 | passando |
| Gravação em pasta (provedor alternativo) | 25 | passando |

Inclui os casos de disputa: duas pessoas tentando assumir o mesmo cadastro,
transferência por admin, tentativa de transferência por não-admin, entrar duas
vezes sem duplicar, e sair mantendo o histórico.

Produção conferida depois do deploy: arquivos novos servidos, rota nova
respondendo, e login funcionando.

---

## 7. Pendências

### Do lado da Jomed

- **Quebrar a herança de permissão** da pasta do canal antes que ela encha de
  CPF e CNH — hoje é visível para toda a equipe `TRAFEGO - MATRIZ`.
- **Rotacionar a chave do Supabase** (`SUPABASE_SERVICE_KEY`), que foi exposta
  durante a configuração.
- **Consentimento do `Sites.Selected`** com o TI.
- Copiar os ~200 documentos antigos que ainda estão no OneDrive pessoal do
  `operacional_01` (a pasta `FORMS REGISTROS - MICROSOFT` tem só um atalho).
- Criar os logins de melissa.pontes, fabio.alves, ellen.karine e
  renan.vasconcelos.
- Incluir `origem_id` no fluxo do Power Automate.

### Do lado do sistema

- **Confirmar que a `SUPABASE_SERVICE_KEY` chegou na Vercel** — use a rota de
  diagnóstico logado como admin. Se `funcionando` vier `false`, o upload em
  produção está desligado.
- Decidir a questão de cota (seção 3).
- Cron para evitar a hibernação do Supabase no plano free.
- Remapear os 200 links antigos depois que os arquivos forem copiados.

---

## Como testar amanhã

1. **Conferir o armazenamento primeiro.** Logado como admin, abra
   `/api/admin/armazenamento`. Precisa vir `"funcionando": true`. Se vier
   `false`, o upload não vai funcionar e a causa está ali na resposta.
2. **Um cadastro de cada módulo**, com anexo. A área de anexos aparece depois
   de clicar em enviar.
3. **Abrir um cadastro no painel** — o modal de participação deve aparecer.
   Abrir de novo não deve perguntar outra vez.
4. **Duas pessoas no mesmo cadastro**: a segunda a tentar assumir deve ser
   recusada com o nome de quem assumiu, e conseguir entrar como colaborador.
5. **Exportar em ZIP**, um cadastro e vários.
6. **Rodar o espelho** (`npm run sincronizar-canal`) e conferir o canal.
