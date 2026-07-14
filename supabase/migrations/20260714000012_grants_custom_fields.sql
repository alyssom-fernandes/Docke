-- =============================================================================
-- Docke — GRANTs faltantes nas tabelas de metadados customizados (ADENDO-08)
-- A migration 20260710000011 criou custom_field/folder_field/document_field_value
-- e o RLS delas, mas esqueceu o GRANT de tabela (padrão já estabelecido em
-- 20260627000005_grants.sql: "GRANT ... ON ALL TABLES" só alcança tabelas que
-- já existiam NAQUELE momento — tabelas criadas depois precisam de GRANT próprio).
-- Sem isso, toda query nessas 3 tabelas falha com "permission denied", mesmo
-- com as policies de RLS corretas — RLS filtra linhas, não substitui o GRANT
-- básico de acesso à tabela.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_field TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_field TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_field_value TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.custom_field TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_field TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_field_value TO service_role;
