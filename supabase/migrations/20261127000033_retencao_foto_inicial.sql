-- Foto da retenção no início (achados B3.4.2 e A7-81 da avaliação de
-- 25/11/2026): quando um documento entra, fica gravado qual política valia e
-- a data de descarte calculada naquele momento, com uma cópia das regras da
-- política. É a prova do que valia à época; o prazo vigente continua vindo de
-- document_retention_info(), que pode aumentar (política travada só aumenta)
-- e resolve conflito pelo prazo mais longo.
--
-- Aditivo: tabela nova e um gatilho AFTER INSERT em documents. O gatilho
-- nunca impede um envio: qualquer erro vira aviso no log e o documento entra
-- sem a foto. Documentos que já existiam ficam sem foto (não dá para provar
-- hoje o que valia quando eles entraram).

CREATE TABLE IF NOT EXISTS public.document_retention_snapshots (
  document_id      uuid        PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
  company_id       uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  policy_id        uuid,
  policy_name      text,
  policy           jsonb,
  expires_at       date,
  is_indeterminate boolean,
  captured_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.document_retention_snapshots IS
  'Política e data de descarte que valiam quando o documento entrou (prova do que valia à época).';

CREATE INDEX IF NOT EXISTS idx_retention_snapshots_company ON public.document_retention_snapshots (company_id);

ALTER TABLE public.document_retention_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "retention_snapshots_select" ON public.document_retention_snapshots;
CREATE POLICY "retention_snapshots_select" ON public.document_retention_snapshots FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_company_access uca
                 WHERE uca.user_id = auth.uid() AND uca.company_id = document_retention_snapshots.company_id));
GRANT SELECT ON public.document_retention_snapshots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_retention_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.capture_retention_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  info record;
  pol  jsonb;
BEGIN
  BEGIN
    SELECT * INTO info FROM public.document_retention_info(NEW.id);
    IF info.policy_id IS NOT NULL THEN
      SELECT to_jsonb(p) - 'company_id' - 'created_by'
        INTO pol
        FROM public.retention_policies p WHERE p.id = info.policy_id;
    END IF;
    INSERT INTO public.document_retention_snapshots
      (document_id, company_id, policy_id, policy_name, policy, expires_at, is_indeterminate)
    VALUES (NEW.id, NEW.company_id, info.policy_id, info.policy_name, pol, info.expires_at, info.is_indeterminate)
    ON CONFLICT (document_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Foto da retenção não gravada para %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_retention_snapshot() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_documents_retention_snapshot ON public.documents;
CREATE TRIGGER trg_documents_retention_snapshot
  AFTER INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.capture_retention_snapshot();
