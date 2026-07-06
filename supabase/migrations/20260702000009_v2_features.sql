-- =============================================================================
-- Docke v2 — Frente 3: versionamento, compartilhamento externo, retenção
-- configurável de lixeira, notificações (ADR-022 a 031, Adendos 04/05).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ADR-024/029 — Versionamento de documentos
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.document_versions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id    uuid        NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  version_number int         NOT NULL,
  storage_key    text        NOT NULL,
  size_bytes     bigint      NOT NULL,
  mime_type      text        NOT NULL,
  ocr_text       text,
  ocr_status     text        NOT NULL DEFAULT 'pending' CHECK (ocr_status IN ('pending', 'processing', 'done', 'failed')),
  uploaded_by    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_document_versions_number UNIQUE (document_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_document_versions_doc ON public.document_versions (document_id, version_number DESC);

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS current_version_id uuid REFERENCES public.document_versions(id);

-- Backfill: documentos que já existiam antes do versionamento ganham uma
-- "versão 1" retroativa a partir dos dados atuais, para o histórico não
-- começar vazio/inconsistente para quem já tinha documentos em produção.
DO $$
DECLARE
  doc RECORD;
  new_version_id uuid;
BEGIN
  FOR doc IN
    SELECT id, storage_path, size_bytes, mime_type, ocr_text, ocr_status, uploaded_by, created_at
    FROM public.documents
    WHERE current_version_id IS NULL
  LOOP
    INSERT INTO public.document_versions
      (document_id, version_number, storage_key, size_bytes, mime_type, ocr_text, ocr_status, uploaded_by, created_at)
    VALUES
      (doc.id, 1, doc.storage_path, doc.size_bytes, doc.mime_type, doc.ocr_text, doc.ocr_status, doc.uploaded_by, doc.created_at)
    RETURNING id INTO new_version_id;

    UPDATE public.documents SET current_version_id = new_version_id WHERE id = doc.id;
  END LOOP;
END $$;

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;

-- Leitura de versões segue a mesma regra de leitura do documento pai.
CREATE POLICY "document_versions_select"
  ON public.document_versions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_versions.document_id
        AND d.deleted_at IS NULL
        AND (
          d.folder_id IS NULL
            AND public.user_has_access(auth.uid(), NULL::ltree, d.company_id) IS NOT NULL
          OR
          d.folder_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.folders f
              WHERE f.id = d.folder_id
                AND public.user_has_access(auth.uid(), f.path, d.company_id) IS NOT NULL
            )
        )
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_versions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_versions TO service_role;

-- ---------------------------------------------------------------------------
-- ADR-022/027/031 — Compartilhamento externo
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shares (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type      text        NOT NULL CHECK (resource_type IN ('document', 'folder')),
  resource_id        uuid        NOT NULL,
  company_id         uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  token_hash         text        UNIQUE NOT NULL,
  password_hash      text,
  expires_at         timestamptz,
  pin_to_version_id  uuid        REFERENCES public.document_versions(id),
  created_by         uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  expired_at         timestamptz,
  view_count         int         NOT NULL DEFAULT 0,
  last_accessed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_shares_resource ON public.shares (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_shares_creator   ON public.shares (created_by, created_at DESC);

CREATE TABLE IF NOT EXISTS public.share_accesses (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id     uuid        NOT NULL REFERENCES public.shares(id) ON DELETE CASCADE,
  accessed_at  timestamptz NOT NULL DEFAULT now(),
  ip_hash      text,
  user_agent   text,
  success      boolean     NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_share_accesses_share ON public.share_accesses (share_id, accessed_at DESC);

ALTER TABLE public.shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.share_accesses ENABLE ROW LEVEL SECURITY;

-- Autor do link vê e gerencia os próprios links; admin da empresa vê todos (revogação — matriz ADR-036).
CREATE POLICY "shares_select"
  ON public.shares FOR SELECT
  TO authenticated
  USING (created_by = auth.uid() OR public.is_company_admin(company_id));

CREATE POLICY "shares_insert"
  ON public.shares FOR INSERT
  TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "shares_update"
  ON public.shares FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid() OR public.is_company_admin(company_id))
  WITH CHECK (created_by = auth.uid() OR public.is_company_admin(company_id));

CREATE POLICY "share_accesses_select"
  ON public.share_accesses FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.shares s
      WHERE s.id = share_accesses.share_id
        AND (s.created_by = auth.uid() OR public.is_company_admin(s.company_id))
    )
  );

-- A rota pública /s/:token roda com service_role (sem sessão de usuário) — sem policy adicional necessária.
GRANT SELECT, INSERT, UPDATE ON public.shares TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.shares TO service_role;
GRANT SELECT, INSERT ON public.share_accesses TO authenticated;
GRANT SELECT, INSERT ON public.share_accesses TO service_role;

-- ---------------------------------------------------------------------------
-- ADR-025/030 — Retenção de lixeira configurável
-- ---------------------------------------------------------------------------

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS retention_days int NOT NULL DEFAULT 30 CHECK (retention_days > 0);

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS trash_expires_at timestamptz;

ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS trash_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_documents_trash_expires ON public.documents (trash_expires_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_folders_trash_expires   ON public.folders (trash_expires_at)   WHERE deleted_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- ADR-023/028/031 — Notificações
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.notifications (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id     uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type           text        NOT NULL CHECK (type IN ('folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring')),
  resource_type  text,
  resource_id    uuid,
  actor_user_id  uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  message        text        NOT NULL,
  read_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON public.notifications (user_id, read_at) WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_select_own"
  ON public.notifications FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "notifications_update_own"
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT SELECT, UPDATE ON public.notifications TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.notifications TO service_role;
