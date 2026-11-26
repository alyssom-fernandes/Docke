-- Prazo de guarda por tipo de documento e por metadado, além da pasta (achado
-- A7-89 da avaliação de 25/11/2026). Pastas mudam; o tipo do documento ("NF-e")
-- e os metadados ("Tipo = Holerite") não. Uma atribuição pode combinar pasta,
-- tipo e campo: vale para o documento quando TODAS as condições preenchidas
-- batem.
--
-- Aditivo: colunas novas, opcionais (NULL = sem filtro, como hoje); a chave
-- única passa a considerar os filtros (as linhas existentes continuam únicas,
-- porque todas têm os filtros vazios). Nenhum dado é alterado ou apagado.

ALTER TABLE public.retention_policy_assignments
  ADD COLUMN IF NOT EXISTS match_tipo_fiscal text,
  ADD COLUMN IF NOT EXISTS match_field_id uuid REFERENCES public.custom_field(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS match_field_value text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rpa_match_field_pair') THEN
    ALTER TABLE public.retention_policy_assignments
      ADD CONSTRAINT rpa_match_field_pair CHECK ((match_field_id IS NULL) = (match_field_value IS NULL));
  END IF;
END $$;

ALTER TABLE public.retention_policy_assignments DROP CONSTRAINT IF EXISTS uq_retention_assignment;
ALTER TABLE public.retention_policy_assignments
  ADD CONSTRAINT uq_retention_assignment
  UNIQUE NULLS NOT DISTINCT (company_id, folder_path, policy_id, match_tipo_fiscal, match_field_id, match_field_value);

COMMENT ON COLUMN public.retention_policy_assignments.match_tipo_fiscal IS
  'Só documentos deste tipo (documents.tipo_fiscal, sem diferença de maiúsculas). NULL = qualquer tipo.';
COMMENT ON COLUMN public.retention_policy_assignments.match_field_id IS
  'Só documentos em que este campo de metadado tem o valor match_field_value. NULL = sem filtro.';

-- Os filtros de tipo e de metadado batem para o documento?
CREATE OR REPLACE FUNCTION public.retention_assignment_applies(
  p_match_tipo text, p_match_field uuid, p_match_value text, p_document_id uuid, p_doc_tipo text
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (p_match_tipo IS NULL OR lower(trim(coalesce(p_doc_tipo, ''))) = lower(trim(p_match_tipo)))
     AND (p_match_field IS NULL OR EXISTS (
           SELECT 1 FROM public.document_field_value v
           WHERE v.document_id = p_document_id AND v.custom_field_id = p_match_field
             AND lower(trim(v.value_text)) = lower(trim(p_match_value))
         ))
$$;

GRANT EXECUTE ON FUNCTION public.retention_assignment_applies(text, uuid, text, uuid, text) TO authenticated, service_role;

-- Mesma função de 20261126000002, agora com os filtros da atribuição.
CREATE OR REPLACE FUNCTION public.document_retention_candidates(p_document_id uuid)
RETURNS TABLE (
  policy_id uuid, policy_name text, locked boolean, is_indeterminate boolean, expires_at date,
  assignment_folder_path ltree
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH doc AS (
    SELECT d.id, d.company_id, d.created_at, d.tipo_fiscal, f.path AS folder_path
    FROM public.documents d
    JOIN public.folders f ON f.id = d.folder_id
    WHERE d.id = p_document_id
  ),
  candidates AS (
    SELECT
      rp.id AS policy_id, rp.name AS policy_name, rp.locked, rp.duration_months, rp.start_rule,
      rpa.folder_path AS assignment_folder_path,
      CASE rp.trigger_type
        WHEN 'upload_date' THEN doc.created_at::date
        WHEN 'custom_field' THEN (
          SELECT dfv.value_date FROM public.document_field_value dfv
          WHERE dfv.document_id = doc.id AND dfv.custom_field_id = rp.trigger_custom_field_id
        )
      END AS start_date
    FROM public.retention_policy_assignments rpa
    JOIN public.retention_policies rp ON rp.id = rpa.policy_id
    CROSS JOIN doc
    WHERE rpa.company_id = doc.company_id
      AND rp.active AND rp.archived_at IS NULL
      AND (rpa.folder_path IS NULL OR rpa.folder_path @> doc.folder_path)
      AND public.retention_assignment_applies(rpa.match_tipo_fiscal, rpa.match_field_id, rpa.match_field_value, doc.id, doc.tipo_fiscal)
  )
  SELECT
    policy_id, policy_name, locked,
    duration_months IS NULL AS is_indeterminate,
    CASE WHEN duration_months IS NULL OR start_date IS NULL THEN NULL
         ELSE ((CASE WHEN start_rule = 'ano_seguinte'
                     THEN (date_trunc('year', start_date) + interval '1 year')::date
                     ELSE start_date END)
               + (duration_months || ' months')::interval)::date
    END AS expires_at,
    assignment_folder_path
  FROM candidates
  WHERE start_date IS NOT NULL OR duration_months IS NULL
$$;

GRANT EXECUTE ON FUNCTION public.document_retention_candidates(uuid) TO authenticated, service_role;
