-- =============================================================================
-- Fase 5.1-5.3 — Retenção legal: política / atribuição / hold / fila de revisão
--
-- Escopo desta migration é DELIBERADAMENTE reversível: nada aqui apaga um
-- documento. A política só CALCULA uma data; o hold só BLOQUEIA exclusão; a
-- fila só REGISTRA candidatos e espera decisão humana (Aprovar/Rejeitar/
-- Adiar). A execução real de descarte (5.5/5.6 — apagar de fato, gerar
-- certificado de destruição) fica para uma fatia futura, com confirmação
-- separada — combinado explicitamente com o usuário antes de começar.
--
-- "Modelo em três entidades: política / atribuição / hold — nunca booleano
-- no documento." (backlog, Fase 5). "Conflito: vence a que expira por
-- último, não a mais longa... Política travada prevalece por severidade."
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. retention_policies — catálogo de regras (config de empresa, admin only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retention_policies (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name                   text        NOT NULL,
  legal_basis            text,
  -- Gatilho: 'upload_date' usa documents.created_at; 'custom_field' usa o
  -- valor de um campo de metadado tipo data/competência (ex.: data de
  -- desligamento, data do contrato) — "gatilho por evento, não por upload".
  trigger_type           text        NOT NULL DEFAULT 'upload_date' CHECK (trigger_type IN ('upload_date', 'custom_field')),
  trigger_custom_field_id uuid       REFERENCES public.custom_field(id) ON DELETE SET NULL,
  -- NULL = indeterminado/permanente (ex.: Ficha de Registro de Empregados).
  duration_months        int         CHECK (duration_months IS NULL OR duration_months > 0),
  -- "Política travada prevalece por severidade" — trava vence no conflito
  -- entre políticas concorrentes, independente da data calculada.
  locked                 boolean     NOT NULL DEFAULT false,
  active                 boolean     NOT NULL DEFAULT true,
  created_by             uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  archived_at            timestamptz,

  CONSTRAINT chk_trigger_field CHECK (
    (trigger_type = 'custom_field' AND trigger_custom_field_id IS NOT NULL)
    OR (trigger_type = 'upload_date' AND trigger_custom_field_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_retention_policies_company ON public.retention_policies (company_id) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. retention_policy_assignments — onde a política vale na árvore
-- Mesmo padrão de folder_field: folder_path NULL = empresa toda. Mais de uma
-- política pode mirar a mesma pasta de propósito (a resolução de conflito é
-- "a que expira por último", não "a mais específica" — diferente do padrão
-- de permissão/metadado).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retention_policy_assignments (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  folder_path ltree,
  policy_id   uuid        NOT NULL REFERENCES public.retention_policies(id) ON DELETE CASCADE,
  created_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_retention_assignment UNIQUE NULLS NOT DISTINCT (company_id, folder_path, policy_id)
);

CREATE INDEX IF NOT EXISTS idx_retention_assignments_path    ON public.retention_policy_assignments USING GIST (folder_path);
CREATE INDEX IF NOT EXISTS idx_retention_assignments_company ON public.retention_policy_assignments (company_id);
CREATE INDEX IF NOT EXISTS idx_retention_assignments_policy  ON public.retention_policy_assignments (policy_id);

-- ---------------------------------------------------------------------------
-- 3. legal_holds — trava contra exclusão, independente do prazo de retenção
-- Vários holds podem coexistir no mesmo recurso (motivos diferentes); só
-- descongela quando o ÚLTIMO cai — computado por COUNT ao vivo (released_at
-- IS NULL), não por contador armazenado, pra nunca dessincronizar.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_holds (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  resource_type text        NOT NULL CHECK (resource_type IN ('document', 'folder')),
  resource_id   uuid        NOT NULL,
  reason        text        NOT NULL,
  created_by    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  released_at   timestamptz,
  released_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_legal_holds_resource ON public.legal_holds (resource_type, resource_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_legal_holds_company  ON public.legal_holds (company_id);

-- ---------------------------------------------------------------------------
-- 4. retention_review_queue — fila de descarte (SEMPRE revisão humana)
-- "Nenhum descarte automático direto." Populada por um job (worker), nunca
-- pelo usuário diretamente. Um documento só entra aqui se não estiver sob
-- hold. Índice parcial garante no máximo UMA entrada ativa (pending/deferred)
-- por documento — reprocessar o scan não duplica a fila.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.retention_review_queue (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id         uuid        NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  policy_id           uuid        REFERENCES public.retention_policies(id) ON DELETE SET NULL,
  policy_name_snapshot text       NOT NULL,
  computed_expires_at date        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'deferred')),
  reviewed_by         uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at         timestamptz,
  review_notes        text,
  deferred_until       date,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_retention_queue_active ON public.retention_review_queue (document_id)
  WHERE status IN ('pending', 'deferred');
CREATE INDEX IF NOT EXISTS idx_retention_queue_company ON public.retention_review_queue (company_id);

-- ---------------------------------------------------------------------------
-- 5. Funções: hold ativo e prazo de retenção calculado
-- ---------------------------------------------------------------------------

-- Hold direto no documento OU em qualquer pasta ancestral (inclusive a
-- própria pasta que contém o documento) — "hold em pasta protege documento
-- adicionado depois", porque a checagem é sempre ao vivo, nunca herdada por
-- cópia.
CREATE OR REPLACE FUNCTION public.document_is_under_hold(p_document_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.legal_holds h
    WHERE h.resource_type = 'document' AND h.resource_id = p_document_id AND h.released_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.legal_holds h
    JOIN public.folders hf ON hf.id = h.resource_id
    JOIN public.documents d ON d.id = p_document_id
    JOIN public.folders df ON df.id = d.folder_id
    WHERE h.resource_type = 'folder' AND h.released_at IS NULL
      AND hf.path @> df.path
  );
$$;

CREATE OR REPLACE FUNCTION public.folder_is_under_hold(p_folder_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.legal_holds h
    JOIN public.folders hf ON hf.id = h.resource_id
    JOIN public.folders tf ON tf.id = p_folder_id
    WHERE h.resource_type = 'folder' AND h.released_at IS NULL
      AND hf.path @> tf.path
  );
$$;

-- Resolve o prazo de retenção efetivo de um documento: agrega todas as
-- políticas atribuídas (empresa toda ou pasta ancestral do documento),
-- calcula a data de expiração de cada uma (start + duration_months; NULL
-- duration = indeterminado) e aplica o desempate — travada vence sobre não
-- travada; entre travadas ou entre não travadas, a que expira MAIS TARDE
-- vence (nunca a mais curta, mesmo que pareça "mais rigorosa").
CREATE OR REPLACE FUNCTION public.document_retention_info(p_document_id uuid)
RETURNS TABLE (expires_at date, is_indeterminate boolean, policy_id uuid, policy_name text, locked boolean)
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
      rp.id AS policy_id, rp.name AS policy_name, rp.locked, rp.duration_months,
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
  ),
  resolved AS (
    SELECT
      policy_id, policy_name, locked,
      duration_months IS NULL AS is_indeterminate,
      CASE WHEN duration_months IS NULL OR start_date IS NULL THEN NULL
           ELSE (start_date + (duration_months || ' months')::interval)::date END AS expires_at
    FROM candidates
    WHERE start_date IS NOT NULL OR duration_months IS NULL
  ),
  -- indeterminado (expires_at NULL) sempre vence sobre qualquer prazo finito
  -- dentro do mesmo grupo de trava — é o caso mais conservador.
  ranked AS (
    SELECT *, EXISTS (SELECT 1 FROM resolved r2 WHERE r2.locked) AS any_locked
    FROM resolved
  )
  SELECT r.expires_at, r.is_indeterminate, r.policy_id, r.policy_name, r.locked
  FROM ranked r
  WHERE (r.any_locked AND r.locked) OR (NOT r.any_locked)
  ORDER BY r.is_indeterminate DESC NULLS LAST, r.expires_at DESC NULLS FIRST
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.document_is_under_hold(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.folder_is_under_hold(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.document_retention_info(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_policy_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_review_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "retention_policies_select" ON public.retention_policies;
CREATE POLICY "retention_policies_select" ON public.retention_policies FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_company_access uca WHERE uca.user_id = auth.uid() AND uca.company_id = retention_policies.company_id));
DROP POLICY IF EXISTS "retention_policies_insert" ON public.retention_policies;
CREATE POLICY "retention_policies_insert" ON public.retention_policies FOR INSERT TO authenticated
  WITH CHECK (public.is_company_admin(company_id));
DROP POLICY IF EXISTS "retention_policies_update" ON public.retention_policies;
CREATE POLICY "retention_policies_update" ON public.retention_policies FOR UPDATE TO authenticated
  USING (public.is_company_admin(company_id)) WITH CHECK (public.is_company_admin(company_id));
DROP POLICY IF EXISTS "retention_policies_delete" ON public.retention_policies;
CREATE POLICY "retention_policies_delete" ON public.retention_policies FOR DELETE TO authenticated
  USING (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "retention_assignments_select" ON public.retention_policy_assignments;
CREATE POLICY "retention_assignments_select" ON public.retention_policy_assignments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_company_access uca WHERE uca.user_id = auth.uid() AND uca.company_id = retention_policy_assignments.company_id));
DROP POLICY IF EXISTS "retention_assignments_insert" ON public.retention_policy_assignments;
CREATE POLICY "retention_assignments_insert" ON public.retention_policy_assignments FOR INSERT TO authenticated
  WITH CHECK (public.is_company_admin(company_id));
DROP POLICY IF EXISTS "retention_assignments_delete" ON public.retention_policy_assignments;
CREATE POLICY "retention_assignments_delete" ON public.retention_policy_assignments FOR DELETE TO authenticated
  USING (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "legal_holds_select" ON public.legal_holds;
CREATE POLICY "legal_holds_select" ON public.legal_holds FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_company_access uca WHERE uca.user_id = auth.uid() AND uca.company_id = legal_holds.company_id));
DROP POLICY IF EXISTS "legal_holds_insert" ON public.legal_holds;
CREATE POLICY "legal_holds_insert" ON public.legal_holds FOR INSERT TO authenticated
  WITH CHECK (public.is_company_admin(company_id));
DROP POLICY IF EXISTS "legal_holds_update" ON public.legal_holds;
CREATE POLICY "legal_holds_update" ON public.legal_holds FOR UPDATE TO authenticated
  USING (public.is_company_admin(company_id)) WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "retention_queue_select" ON public.retention_review_queue;
CREATE POLICY "retention_queue_select" ON public.retention_review_queue FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_company_access uca WHERE uca.user_id = auth.uid() AND uca.company_id = retention_review_queue.company_id));
DROP POLICY IF EXISTS "retention_queue_update" ON public.retention_review_queue;
CREATE POLICY "retention_queue_update" ON public.retention_review_queue FOR UPDATE TO authenticated
  USING (public.is_company_admin(company_id)) WITH CHECK (public.is_company_admin(company_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.retention_policies TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.retention_policy_assignments TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.legal_holds TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.retention_review_queue TO authenticated, service_role;
