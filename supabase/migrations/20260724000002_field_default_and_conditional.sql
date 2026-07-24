-- Fase 8.3/8.4: heranca de valor padrao por pasta + campos condicionais.
--
-- 8.3: default_value fica em folder_field (nao em custom_field) porque o
-- valor padrao faz sentido por APLICACAO do campo numa pasta, nao pro campo
-- em si -- o mesmo campo "Centro de custo" pode ter padrao "Comercial" numa
-- pasta e "Fiscal" noutra.
--
-- 8.4: condicao fica em custom_field porque e uma regra do proprio campo
-- ("so mostrar Numero da Nota quando Tipo Fiscal = NF-e"), independente de
-- em qual pasta ele foi aplicado.

ALTER TABLE public.folder_field
  ADD COLUMN IF NOT EXISTS default_value text;

ALTER TABLE public.custom_field
  ADD COLUMN IF NOT EXISTS condition_field_id uuid REFERENCES public.custom_field(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS condition_value text;

-- resolve_folder_fields precisa devolver default_value também, senão o
-- catálogo efetivo da pasta (usado pra montar o formulário) não sabe que
-- valor pré-preencher. DROP antes do CREATE porque mudar as colunas de
-- RETURNS TABLE muda o tipo composto da função — CREATE OR REPLACE sozinho
-- não permite isso.
DROP FUNCTION IF EXISTS public.resolve_folder_fields(uuid, ltree);

CREATE OR REPLACE FUNCTION public.resolve_folder_fields(
  p_company_id  uuid,
  p_target_path ltree
)
RETURNS TABLE (
  custom_field_id uuid,
  required        boolean,
  display_order   int,
  column_width    int,
  default_value   text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH candidates AS (
    SELECT
      ff.custom_field_id,
      ff.mode,
      ff.required,
      ff.display_order,
      ff.column_width,
      ff.default_value,
      CASE WHEN ff.folder_path IS NULL THEN 0 ELSE nlevel(ff.folder_path) END AS depth,
      ROW_NUMBER() OVER (
        PARTITION BY ff.custom_field_id
        ORDER BY CASE WHEN ff.folder_path IS NULL THEN 0 ELSE nlevel(ff.folder_path) END DESC
      ) AS rn
    FROM public.folder_field ff
    WHERE ff.company_id = p_company_id
      AND (
        ff.folder_path IS NULL
        OR (p_target_path IS NOT NULL AND ff.folder_path @> p_target_path)
      )
  )
  SELECT c.custom_field_id, c.required, c.display_order, c.column_width, c.default_value
  FROM candidates c
  WHERE c.rn = 1
    AND c.mode = 'apply';
$$;

GRANT EXECUTE ON FUNCTION public.resolve_folder_fields(uuid, ltree) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_folder_fields(uuid, ltree) TO service_role;
