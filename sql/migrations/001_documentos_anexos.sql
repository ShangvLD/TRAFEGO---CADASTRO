-- ===========================================================================
-- 001 — documentos: rastreio do arquivo, dono alternativo, view de contexto
--
-- ESPELHO de src/db.js, bloco "Documentos, segunda rodada". O app aplica isto
-- sozinho na inicialização; este arquivo existe para ser lido e para poder
-- ser rodado à mão no SQL Editor do Supabase. Ver sql/migrations/README.md.
--
-- IDEMPOTENTE: pode rodar quantas vezes for.
--
-- PARA DESFAZER (nada aqui apaga dado, então o desfazer é só derrubar):
--   DROP VIEW IF EXISTS vw_documentos;
--   ALTER TABLE documentos DROP CONSTRAINT IF EXISTS documentos_tem_dono;
--   ALTER TABLE documentos
--     DROP COLUMN IF EXISTS bucket, DROP COLUMN IF EXISTS criado_por,
--     DROP COLUMN IF EXISTS atualizado_em, DROP COLUMN IF EXISTS origem,
--     DROP COLUMN IF EXISTS escopo, DROP COLUMN IF EXISTS condutor_id,
--     DROP COLUMN IF EXISTS proprietario_id, DROP COLUMN IF EXISTS veiculo_id;
-- ===========================================================================

-- ------------------------------------------------------------------------
-- Documentos, segunda rodada: o que faltava para o arquivo ser RASTREÁVEL
-- (espelho de sql/migrations/001_documentos_anexos.sql)
--
-- O balanço do que existia: a tabela já era a "tabela de anexos" — tinha
-- solicitacao_id, modulo, tipo, caminho, provedor, tamanho, content_type.
-- Faltavam três coisas, e cada uma por um motivo concreto:
--
--   bucket      "caminho" sozinho não localiza nada. O provedor diz o
--               SERVIÇO (supabase), não o CONTÊINER. Hoje o bucket vem de
--               uma variável de ambiente lida na hora da leitura — trocar
--               SUPABASE_BUCKET tornaria ilegível todo arquivo antigo, sem
--               aviso. Gravado junto com o arquivo, o registro continua
--               apontando para onde o arquivo REALMENTE está.
--
--   criado_por  "quem anexou a CNH errada neste cadastro?" não tinha
--               resposta. Documento com CPF e endereço de terceiro precisa
--               de autoria. Nullable porque as 12 linhas que já existem não
--               têm como saber — e inventar seria pior que admitir.
--
--   origem      prepara a vinda do OneDrive. 399 solicitações guardam anexo
--               do Forms em solicitacoes.anexos (JSON de links), fora desta
--               tabela. Quando forem migrados, precisam ser distinguíveis
--               do que nasceu nativo — para conferir a migração e para
--               saber o que ainda depende do OneDrive.
-- ------------------------------------------------------------------------
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS bucket text;

-- Sem FK: usuário excluído não deve levar junto o registro do documento nem
-- travar a exclusão. A autoria vira nula e o arquivo continua lá, que é o
-- comportamento correto para trilha de auditoria.
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS criado_por integer;

ALTER TABLE documentos ADD COLUMN IF NOT EXISTS atualizado_em text;

-- nativo   enviado pelo portal, direto ao storage
-- forms    veio do Microsoft Forms; o arquivo ainda está no OneDrive
-- migrado  nasceu no OneDrive e foi copiado para o storage
ALTER TABLE documentos DROP CONSTRAINT IF EXISTS documentos_origem_check;
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS origem text NOT NULL DEFAULT 'nativo';
ALTER TABLE documentos ADD CONSTRAINT documentos_origem_check
  CHECK (origem IN ('nativo', 'forms', 'migrado'));

-- A quem o anexo pertence (motorista, veiculo, carreta, geral). Copiado de
-- cfg_documentos no momento do envio: a configuração MUDA, e o documento
-- guardado no ano passado pertence a quem pertencia naquele dia.
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS escopo text;

-- ------------------------------------------------------------------------
-- Dono ALTERNATIVO: documento que não é de uma solicitação
--
-- Estas três colunas NÃO são cópia de solicitacao_cadastro, e a diferença
-- importa. Copiar seria inútil: das 401 solicitações, 2 têm condutor e
-- proprietário vinculados — as outras 399 vieram do Forms e não têm
-- entidade nenhuma. Coluna copiada nasceria nula em 99,5% das linhas.
--
-- O que elas resolvem é outro caso: a CNH é DA PESSOA, não do cadastro. Na
-- renovação, hoje, ela é reenviada e guardada de novo — o mesmo arquivo em
-- duas solicitações. Com condutor_id preenchido e solicitacao_id nulo, o
-- documento passa a ser do condutor e vale para todos os cadastros dele.
--
-- Para o caso normal (documento DE uma solicitação), a resposta a "quais
-- documentos são deste motorista?" sai da view vw_documentos, por join —
-- não de coluna duplicada.
-- ------------------------------------------------------------------------
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS condutor_id     integer REFERENCES condutores(id)     ON DELETE SET NULL;
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS proprietario_id integer REFERENCES proprietarios(id) ON DELETE SET NULL;
ALTER TABLE documentos ADD COLUMN IF NOT EXISTS veiculo_id      integer REFERENCES veiculos(id)      ON DELETE SET NULL;

-- solicitacao_id nasceu NOT NULL (a tabela só servia o terceiro). Documento
-- de condutor não tem solicitação, então a obrigatoriedade sai — e passa a
-- ser a regra abaixo: todo documento precisa de PELO MENOS UM dono.
ALTER TABLE documentos ALTER COLUMN solicitacao_id DROP NOT NULL;

ALTER TABLE documentos DROP CONSTRAINT IF EXISTS documentos_tem_dono;
ALTER TABLE documentos ADD CONSTRAINT documentos_tem_dono CHECK (
  solicitacao_id IS NOT NULL OR condutor_id IS NOT NULL
  OR proprietario_id IS NOT NULL OR veiculo_id IS NOT NULL
);

-- Índices parciais: só indexam a linha que TEM aquele dono. Como a grande
-- maioria é de solicitação, um índice cheio seria quase todo nulo.
CREATE INDEX IF NOT EXISTS idx_documentos_condutor
  ON documentos (condutor_id) WHERE condutor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documentos_proprietario
  ON documentos (proprietario_id) WHERE proprietario_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documentos_veiculo
  ON documentos (veiculo_id) WHERE veiculo_id IS NOT NULL;

-- "Quais cadastros já têm a CNH?" percorria a tabela inteira (idsComTipo).
CREATE INDEX IF NOT EXISTS idx_documentos_modulo_tipo
  ON documentos (modulo, tipo);

-- ------------------------------------------------------------------------
-- vw_documentos — o documento COM o seu contexto, sem duplicar nada
--
-- É aqui que "quais documentos são deste motorista?" é respondido: pelo
-- join com solicitacao_cadastro, que já guarda o vínculo. A view resolve os
-- dois caminhos de uma vez — o dono direto (condutor_id na linha) e o dono
-- pela solicitação — com COALESCE, para quem consulta não precisar saber
-- qual dos dois é o caso.
--
-- Só o terceiro tem solicitacao_cadastro; agregado e candidato guardam o
-- condutor no JSON "dados". Por isso o LEFT JOIN, e por isso as colunas
-- vêm nulas nesses módulos — o que é a verdade, não uma falha da view.
-- ------------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_documentos AS
  SELECT d.*,
         COALESCE(d.condutor_id,     sc.condutor_id)     AS condutor_efetivo,
         COALESCE(d.proprietario_id, sc.proprietario_id) AS proprietario_efetivo,
         c.nome  AS condutor_nome,
         c.cpf   AS condutor_cpf,
         p.nome  AS proprietario_nome,
         p.documento AS proprietario_documento,
         sc.placa_cavalo,
         sc.placa_carreta
    FROM documentos d
    LEFT JOIN solicitacao_cadastro sc
           ON d.modulo = 'terceiro' AND sc.solicitacao_id = d.solicitacao_id
    LEFT JOIN condutores    c ON c.id = COALESCE(d.condutor_id,     sc.condutor_id)
    LEFT JOIN proprietarios p ON p.id = COALESCE(d.proprietario_id, sc.proprietario_id);
