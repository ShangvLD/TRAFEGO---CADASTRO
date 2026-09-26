# Migrations

Estes arquivos são o **registro versionado** do que mudou no banco. Eles não
são o mecanismo de aplicação.

Neste projeto o schema é idempotente e roda sozinho na inicialização do app
(`src/db.js`, com `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS` e
`UPDATE` com guarda). Foi assim que `sql/habilitar-rls.sql` já funcionava: o
arquivo existe para ser lido, auditado e rodado à mão no SQL Editor do
Supabase quando for preciso; o app aplica o mesmo bloco no boot.

Cada migration aqui tem um espelho em `src/db.js`, indicado no cabeçalho do
arquivo. **Ao mexer numa, mexa na outra** — senão o banco de produção e o
registro divergem, que é pior que não ter registro nenhum.

| # | o que faz | espelho em src/db.js |
|---|---|---|
| 001 | colunas de rastreio em `documentos`, dono alternativo, índices, `vw_documentos` | bloco "Documentos, segunda rodada" |
| 002 | código canônico dos tipos de documento | bloco "Código canônico dos tipos" |
| 003 | tabela `blacklist` (proprietários bloqueados) | bloco "BLACKLIST GEOMED" |

A reorganização dos caminhos no Storage **não é migration SQL**: mover arquivo
exige falar com o Supabase Storage, o que o Postgres não faz. Ela está em
`src/migrar-storage.js` (`npm run migrar-storage`), que copia o objeto,
atualiza `documentos.caminho` e só então apaga o original.
