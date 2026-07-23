-- =============================================================================
-- Fase 4.1 — Modelo de Obrigações (Obrigação → Documento comprobatório)
--
-- Três tabelas, "Document Type → Obligation Template → Obligation Instance →
-- Documents" (backlog, seção H/O):
--   obligation_templates  catálogo de obrigações recorrentes por empresa
--                         (ex.: "DARF mensal", "ASO admissional"), config de
--                         admin — mesmo bucket de custom_field/folder_field.
--   obligation_instances  uma ocorrência concreta do template num período
--                         (ex.: DARF de 2026-07). Estado não é binário:
--                         pending/at_risk/overdue são DERIVADOS do prazo (não
--                         persistidos — calculados na leitura, service layer);
--                         reviewing/approved/dispensado/cancelado SÃO
--                         persistidos porque nascem de ação humana.
--   obligation_documents  quais documentos satisfazem uma instância — N:N,
--                         porque a mesma obrigação pode ser comprovada por
--                         documentos diferentes (Folha.pdf OU Pacote RH.zip).
--
-- Regras condicionais (4.2), dependências entre obrigações, matriz 2D (4.4) e
-- alertas idempotentes (4.5) ficam para fatias seguintes — aqui só o modelo e
-- os estados manuais. `rules_json` já existe na tabela para não forçar
-- migração de schema quando 4.2 chegar, mas nada ainda o interpreta.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.obligation_templates (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name          text        NOT NULL,
  description   text,
  frequency     text        NOT NULL CHECK (frequency IN ('mensal', 'anual', 'unica', 'evento')),
  criticality   text        NOT NULL DEFAULT 'media' CHECK (criticality IN ('baixa', 'media', 'alta', 'critica')),
  department    text,
  sla_days      int         NOT NULL DEFAULT 0,
  weight        int         NOT NULL DEFAULT 1,
  rules_json    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  active        boolean     NOT NULL DEFAULT true,
  created_by    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_obligation_templates_company
  ON public.obligation_templates (company_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.obligation_instances (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id     uuid        NOT NULL REFERENCES public.obligation_templates(id) ON DELETE CASCADE,
  company_id      uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period          text        NOT NULL, -- "2026-07" (mensal/anual) ou identificador livre (unica/evento)
  due_date        date        NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'reviewing', 'approved', 'dispensado', 'cancelado')),
  dispensa_motivo text,       -- obrigatório na prática quando status='dispensado' (checado na service layer)
  owner_id        uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  score            int        NOT NULL DEFAULT 0,
  satisfied_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_obligation_instance_period UNIQUE (template_id, period)
);

CREATE INDEX IF NOT EXISTS idx_obligation_instances_company ON public.obligation_instances (company_id);
CREATE INDEX IF NOT EXISTS idx_obligation_instances_template ON public.obligation_instances (template_id);
CREATE INDEX IF NOT EXISTS idx_obligation_instances_due ON public.obligation_instances (company_id, due_date)
  WHERE status NOT IN ('approved', 'dispensado', 'cancelado');

DROP TRIGGER IF EXISTS trg_obligation_instances_updated_at ON public.obligation_instances;
CREATE TRIGGER trg_obligation_instances_updated_at
  BEFORE UPDATE ON public.obligation_instances
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.obligation_documents (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  obligation_instance_id uuid       NOT NULL REFERENCES public.obligation_instances(id) ON DELETE CASCADE,
  document_id           uuid        NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  linked_by             uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  linked_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_obligation_document UNIQUE (obligation_instance_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_obligation_documents_instance ON public.obligation_documents (obligation_instance_id);
CREATE INDEX IF NOT EXISTS idx_obligation_documents_document ON public.obligation_documents (document_id);

-- ---------------------------------------------------------------------------
-- Vincular um documento marca a instância como 'approved' automaticamente
-- (satisfaz a obrigação). Desvincular o último documento volta pra 'pending'
-- — a não ser que o status atual seja 'dispensado'/'cancelado' (decisão
-- humana explícita não é desfeita por uma alteração de vínculo).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obligation_documents_sync_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_instance_id uuid;
  v_remaining   int;
  v_status      text;
BEGIN
  v_instance_id := COALESCE(NEW.obligation_instance_id, OLD.obligation_instance_id);

  SELECT status INTO v_status FROM public.obligation_instances WHERE id = v_instance_id;
  IF v_status IN ('dispensado', 'cancelado') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT count(*) INTO v_remaining
  FROM public.obligation_documents
  WHERE obligation_instance_id = v_instance_id;

  IF v_remaining > 0 THEN
    UPDATE public.obligation_instances
    SET status = 'approved', satisfied_at = COALESCE(satisfied_at, now())
    WHERE id = v_instance_id AND status <> 'approved';
  ELSE
    UPDATE public.obligation_instances
    SET status = 'pending', satisfied_at = NULL
    WHERE id = v_instance_id AND status <> 'pending';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_obligation_documents_sync_ins ON public.obligation_documents;
CREATE TRIGGER trg_obligation_documents_sync_ins
  AFTER INSERT ON public.obligation_documents
  FOR EACH ROW EXECUTE FUNCTION public.obligation_documents_sync_status();

DROP TRIGGER IF EXISTS trg_obligation_documents_sync_del ON public.obligation_documents;
CREATE TRIGGER trg_obligation_documents_sync_del
  AFTER DELETE ON public.obligation_documents
  FOR EACH ROW EXECUTE FUNCTION public.obligation_documents_sync_status();

-- ---------------------------------------------------------------------------
-- RLS — mesma forma de custom_field/folder_field: leitura por qualquer membro
-- da empresa, escrita (templates) só admin. Instâncias podem ser revisadas
-- (status/dispensa) por admin OU operador (quem processa o dia a dia fiscal/
-- RH normalmente não é admin da empresa). obligation_documents segue o mesmo
-- nível de permissão da instância a que pertence.
-- ---------------------------------------------------------------------------
ALTER TABLE public.obligation_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.obligation_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.obligation_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "obligation_templates_select" ON public.obligation_templates;
CREATE POLICY "obligation_templates_select"
  ON public.obligation_templates FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id = auth.uid() AND uca.company_id = obligation_templates.company_id
    )
  );

DROP POLICY IF EXISTS "obligation_templates_insert" ON public.obligation_templates;
CREATE POLICY "obligation_templates_insert"
  ON public.obligation_templates FOR INSERT
  TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "obligation_templates_update" ON public.obligation_templates;
CREATE POLICY "obligation_templates_update"
  ON public.obligation_templates FOR UPDATE
  TO authenticated
  USING     (public.is_company_admin(company_id))
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "obligation_templates_delete" ON public.obligation_templates;
CREATE POLICY "obligation_templates_delete"
  ON public.obligation_templates FOR DELETE
  TO authenticated
  USING (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "obligation_instances_select" ON public.obligation_instances;
CREATE POLICY "obligation_instances_select"
  ON public.obligation_instances FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id = auth.uid() AND uca.company_id = obligation_instances.company_id
    )
  );

DROP POLICY IF EXISTS "obligation_instances_insert" ON public.obligation_instances;
CREATE POLICY "obligation_instances_insert"
  ON public.obligation_instances FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_access(auth.uid(), NULL::ltree, company_id) IN ('admin', 'operador')
  );

DROP POLICY IF EXISTS "obligation_instances_update" ON public.obligation_instances;
CREATE POLICY "obligation_instances_update"
  ON public.obligation_instances FOR UPDATE
  TO authenticated
  USING (
    public.user_has_access(auth.uid(), NULL::ltree, company_id) IN ('admin', 'operador')
  )
  WITH CHECK (
    public.user_has_access(auth.uid(), NULL::ltree, company_id) IN ('admin', 'operador')
  );

DROP POLICY IF EXISTS "obligation_instances_delete" ON public.obligation_instances;
CREATE POLICY "obligation_instances_delete"
  ON public.obligation_instances FOR DELETE
  TO authenticated
  USING (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "obligation_documents_select" ON public.obligation_documents;
CREATE POLICY "obligation_documents_select"
  ON public.obligation_documents FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.obligation_instances oi
      JOIN public.user_company_access uca ON uca.company_id = oi.company_id AND uca.user_id = auth.uid()
      WHERE oi.id = obligation_documents.obligation_instance_id
    )
  );

DROP POLICY IF EXISTS "obligation_documents_insert" ON public.obligation_documents;
CREATE POLICY "obligation_documents_insert"
  ON public.obligation_documents FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.obligation_instances oi
      WHERE oi.id = obligation_documents.obligation_instance_id
        AND public.user_has_access(auth.uid(), NULL::ltree, oi.company_id) IN ('admin', 'operador')
    )
  );

DROP POLICY IF EXISTS "obligation_documents_delete" ON public.obligation_documents;
CREATE POLICY "obligation_documents_delete"
  ON public.obligation_documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.obligation_instances oi
      WHERE oi.id = obligation_documents.obligation_instance_id
        AND public.user_has_access(auth.uid(), NULL::ltree, oi.company_id) IN ('admin', 'operador')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.obligation_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.obligation_instances TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.obligation_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.obligation_templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.obligation_instances TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.obligation_documents TO service_role;
