-- =============================================================================
-- Docke — Função user_has_access
-- Retorna o permission_level efetivo de um usuário em uma pasta,
-- respeitando a regra de especificidade (R5 / Invariante I7):
-- o path mais específico (mais profundo) sempre prevalece.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.user_has_access(
  p_user_id     uuid,
  p_target_path ltree,
  p_company_id  uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT permission_level
  FROM public.user_company_access
  WHERE user_id   = p_user_id
    AND company_id = p_company_id
    AND (
      folder_path IS NULL              -- null = acesso a toda a empresa
      OR folder_path @> p_target_path  -- folder_path é ancestral (ou igual) a target_path
    )
  ORDER BY
    CASE WHEN folder_path IS NULL THEN 0
         ELSE nlevel(folder_path)
    END DESC                           -- mais específico (maior nlevel) primeiro
  LIMIT 1;
$$;

-- Garante que auth.uid() (usado pelas policies RLS) possa chamar a função
GRANT EXECUTE ON FUNCTION public.user_has_access(uuid, ltree, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_access(uuid, ltree, uuid) TO service_role;
