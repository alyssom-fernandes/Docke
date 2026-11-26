-- Retenção que protege de verdade (achados A7-80, A7-81, A7-106..A7-108 da
-- avaliação de 25/11/2026).
--
-- 1) Prazo efetivo = o MAIS LONGO entre todas as políticas que valem para o
--    documento. Antes, uma política "travada" mais curta vencia uma não
--    travada mais longa: uma travada de 12 meses na empresa toda encurtava a
--    guarda de 5 anos dos fiscais numa subpasta. A trava continua impedindo
--    a exclusão enquanto o prazo DELA não acabar (função de bloqueio abaixo).
-- 2) Prazo que começa em 1º de janeiro do ano seguinte (regra comum na
--    guarda fiscal), além de "a partir da data".
-- 3) Bloqueio judicial (legal hold) com número do processo, data de revisão
--    e motivo da liberação.
--
-- Aditivo: colunas novas com padrão, funções reescritas. Nenhum dado é
-- alterado ou apagado.

ALTER TABLE public.retention_policies
  ADD COLUMN IF NOT EXISTS start_rule text NOT NULL DEFAULT 'data' CHECK (start_rule IN ('data', 'ano_seguinte')),
  ADD COLUMN IF NOT EXISTS catalog_key text,
  ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN public.retention_policies.start_rule IS
  'data: conta a partir da data do gatilho. ano_seguinte: a partir de 1º de janeiro do ano seguinte a ela.';

ALTER TABLE public.legal_holds
  ADD COLUMN IF NOT EXISTS process_number text,
  ADD COLUMN IF NOT EXISTS review_date date,
  ADD COLUMN IF NOT EXISTS release_reason text;

-- Todas as políticas que valem para o documento, com a data de cada uma.
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
    SELECT d.id, d.company_id, d.created_at, f.path AS folder_path
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

-- Vencedor: indeterminado primeiro, depois o que expira mais tarde; a trava
-- só desempata prazos iguais.
CREATE OR REPLACE FUNCTION public.document_retention_info(p_document_id uuid)
RETURNS TABLE (expires_at date, is_indeterminate boolean, policy_id uuid, policy_name text, locked boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.expires_at, c.is_indeterminate, c.policy_id, c.policy_name, c.locked
  FROM public.document_retention_candidates(p_document_id) c
  ORDER BY c.is_indeterminate DESC, c.expires_at DESC NULLS LAST, c.locked DESC
  LIMIT 1
$$;

-- A exclusão fica bloqueada enquanto QUALQUER política travada que vale para
-- o documento ainda não venceu (não só a vencedora).
CREATE OR REPLACE FUNCTION public.document_deletion_block_reason(p_document_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.document_is_under_hold(p_document_id) THEN
    RETURN 'legal_hold';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.document_retention_candidates(p_document_id) c
    WHERE c.locked AND (c.is_indeterminate OR c.expires_at IS NULL OR c.expires_at > current_date)
  ) THEN
    RETURN 'retencao';
  END IF;
  RETURN NULL;
END;
$$;
