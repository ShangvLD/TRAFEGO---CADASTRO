-- ===========================================================================
-- Fecha o schema "public" para a API HTTP do Supabase (PostgREST)
--
-- POR QUE: o Supabase publica o schema "public" em
-- https://<ref>.supabase.co/rest/v1/, e os papéis "anon"/"authenticated"
-- nascem com permissão sobre toda tabela criada ali. Este sistema não usa essa
-- API (fala com o banco por TCP, como "postgres"), mas a porta ficava aberta:
-- com a anon key do projeto dava para ler "usuarios" (hash de senha) e
-- "sessoes". É o que o Security Advisor aponta como "RLS Disabled in Public".
--
-- IMPACTO NA APLICAÇÃO: nenhum. O papel "postgres" (usado pelo app, via
-- pooler) e o "service_role" (usado pelo Storage) têm BYPASSRLS.
--
-- Rodar no painel do Supabase: SQL Editor > New query > colar > Run.
-- O mesmo bloco também roda sozinho na inicialização do app (src/db.js,
-- RLS_SQL), para tabela nova já nascer protegida.
--
-- PARA DESFAZER (se algum dia a API HTTP for usada):
--   ALTER TABLE public.<tabela> DISABLE ROW LEVEL SECURITY;
--   GRANT SELECT ON public.<tabela> TO anon;   -- e criar as políticas
-- ===========================================================================

DO $rls$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t.tablename);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t.tablename);
    END IF;
  END LOOP;
END
$rls$;

-- Conferência: rls = true em todas, anon_select = false em todas.
SELECT c.relname AS tabela,
       c.relrowsecurity AS rls,
       has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
       has_table_privilege('authenticated', c.oid, 'SELECT') AS auth_select
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY c.relname;
