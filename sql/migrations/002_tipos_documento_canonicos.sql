-- ===========================================================================
-- 002 — código canônico dos tipos de documento
--
-- ESPELHO de src/db.js, bloco "Código canônico dos tipos de documento".
-- Ver sql/migrations/README.md.
--
-- IDEMPOTENTE: as linhas já convertidas não casam mais com o WHERE.
--
-- ATENÇÃO: esta é a única migration que ALTERA DADO existente. Antes de
-- rodar à mão, o retrato do que será mudado:
--
--   SELECT modulo, codigo, count(*) FROM cfg_documentos GROUP BY 1,2;
--   SELECT tipo, count(*) FROM documentos GROUP BY 1;
--
-- NÃO HÁ COMO DESFAZER automaticamente: o código antigo não é dedutível do
-- novo (três viraram um). Guarde o retrato acima antes de rodar.
-- ===========================================================================

-- ------------------------------------------------------------------------
-- Código canônico dos tipos de documento
-- (espelho de sql/migrations/002_tipos_documento_canonicos.sql)
--
-- O mesmo documento tinha um código por módulo, porque cada lista de
-- documentosIniciais foi escrita numa semana diferente:
--
--   Direção Segura  CERT_DIRECAO_SEGURA | CURSO_DIRECAO_SEGURA
--                    | CERTIFICADO_DE_DIRECAO_SEGURA
--   Acidente rodovia CERTIFICADO_DE_COMO_EVITAR_ACIDENTE_NAS_RODOVIAS
--                    | CURSO_ACIDENTE_RODOVIA
--
-- Isso só incomoda na pergunta que cruza módulos — "este motorista já
-- entregou o curso?" — que com três códigos responde "não" três vezes. E na
-- renovação, que procura o documento já enviado pelo código do módulo atual
-- e não acha o que veio do outro.
--
-- O NOT EXISTS não é zelo: (modulo, codigo) é único, e renomear para um
-- código que o módulo já tem derrubaria a inicialização inteira. Hoje não
-- há colisão; a guarda é para o dia em que alguém criar o canônico à mão
-- pela tela de admin antes de isto rodar.
-- ------------------------------------------------------------------------
UPDATE cfg_documentos c SET codigo = 'CERT_DIRECAO_SEGURA'
 WHERE codigo IN ('CURSO_DIRECAO_SEGURA', 'CERTIFICADO_DE_DIRECAO_SEGURA')
   AND NOT EXISTS (SELECT 1 FROM cfg_documentos x
                    WHERE x.modulo = c.modulo AND x.codigo = 'CERT_DIRECAO_SEGURA');

UPDATE cfg_documentos c SET codigo = 'CERT_ACIDENTE_RODOVIA'
 WHERE codigo IN ('CURSO_ACIDENTE_RODOVIA',
                  'CERTIFICADO_DE_COMO_EVITAR_ACIDENTE_NAS_RODOVIAS')
   AND NOT EXISTS (SELECT 1 FROM cfg_documentos x
                    WHERE x.modulo = c.modulo AND x.codigo = 'CERT_ACIDENTE_RODOVIA');

-- Os documentos JÁ ANEXADOS acompanham o código. Sem isto, o anexo antigo
-- ficaria órfão do tipo renomeado: a tela procura pelo código novo, não
-- acha, e pede de novo um documento que a pessoa já entregou.
UPDATE documentos SET tipo = 'CERT_DIRECAO_SEGURA'
 WHERE tipo IN ('CURSO_DIRECAO_SEGURA', 'CERTIFICADO_DE_DIRECAO_SEGURA');

UPDATE documentos SET tipo = 'CERT_ACIDENTE_RODOVIA'
 WHERE tipo IN ('CURSO_ACIDENTE_RODOVIA',
                'CERTIFICADO_DE_COMO_EVITAR_ACIDENTE_NAS_RODOVIAS');

-- O RESULTADO RDO, com espaço: o único código do sistema fora da convenção,
-- e o único documento nativo que existia. O nome do ARQUIVO já saía
-- "RESULTADO_RDO.pdf" (higienizar() trocava o espaço); era o código no banco
-- que discordava do arquivo.
UPDATE documentos SET tipo = 'RESULTADO_RDO' WHERE tipo = 'RESULTADO RDO';

-- Regra geral para o que escapar: espaço e hífen viram "_". Não cobre
-- acento (que o Postgres normalizaria diferente do Node); nenhum código em
-- uso tem acento, e canonico() cuida dos que chegarem.
UPDATE documentos
   SET tipo = upper(regexp_replace(trim(tipo), '[^A-Za-z0-9]+', '_', 'g'))
 WHERE tipo <> upper(regexp_replace(trim(tipo), '[^A-Za-z0-9]+', '_', 'g'));
