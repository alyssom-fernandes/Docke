-- =============================================================================
-- Docke — GRANTs de tabela para roles authenticated e service_role
-- Em Supabase local com migrations raw, os GRANTs de tabela não são criados
-- automaticamente. O RLS filtra as linhas, mas o role precisa ter acesso básico.
-- =============================================================================

-- USAGE no schema (pré-requisito para acessar qualquer objeto)
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;

-- Tabelas — authenticated pode fazer tudo (RLS filtra o que realmente aparece)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;

-- Sequences (para gen_random_uuid() e outros defaults)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Funções (SECURITY DEFINER já tem EXECUTE implícito para o owner; as outras precisam de GRANT)
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;
