-- =============================================================================
-- Docke — Migration inicial
-- Inclui: extensões, FTS portuguese, 8 tabelas, índices, constraints
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EXTENSÕES
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- CONFIGURAÇÃO FTS PORTUGUÊS
-- Não existe por padrão — precisa ser criada explicitamente.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config WHERE cfgname = 'portuguese'
  ) THEN
    CREATE TEXT SEARCH CONFIGURATION portuguese (COPY = pg_catalog.portuguese);
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Wrapper IMMUTABLE para unaccent
-- unaccent() é STABLE por padrão; funções em índices GIN precisam ser
-- IMMUTABLE. Este wrapper permite usá-la em expressões de índice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.immutable_unaccent(text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS
$$
  SELECT unaccent($1);
$$;

-- ---------------------------------------------------------------------------
-- companies
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.companies (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  is_single_company_mode boolean    NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- users (espelha auth.users — sem duplicar dados de autenticação)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.users (
  id            uuid        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username      text        UNIQUE,
  full_name     text,
  role          text        NOT NULL CHECK (role IN ('supremo', 'admin', 'usuario')),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

-- ---------------------------------------------------------------------------
-- folders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.folders (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  parent_id   uuid        REFERENCES public.folders(id) ON DELETE SET NULL,
  path        ltree       NOT NULL,
  name        text        NOT NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        REFERENCES public.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_folders_path       ON public.folders USING GIST (path);
CREATE INDEX IF NOT EXISTS idx_folders_company    ON public.folders (company_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent     ON public.folders (parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_deleted    ON public.folders (deleted_at);

-- ---------------------------------------------------------------------------
-- user_company_access
-- folder_path NULL = acesso a toda a empresa
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_company_access (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id       uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  folder_path      ltree,
  permission_level text        NOT NULL CHECK (permission_level IN ('viewer', 'editor', 'manager')),
  granted_by       uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_user_company ON public.user_company_access (user_id, company_id);

-- ---------------------------------------------------------------------------
-- documents
-- R6: company_id deve ser idêntico ao folders.company_id da pasta que o contém.
-- Validado via CHECK trigger no service layer. UNIQUE(company_id, content_hash)
-- impede duplicata dentro da mesma empresa.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.documents (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id                 uuid        NOT NULL REFERENCES public.folders(id) ON DELETE RESTRICT,
  company_id                uuid        NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  name                      text        NOT NULL,
  mime_type                 text        NOT NULL,
  file_type                 text        NOT NULL,
  size_bytes                bigint      NOT NULL CHECK (size_bytes > 0),
  storage_path              text        NOT NULL,
  content_hash              text,
  sector                    text,
  competencia               date,
  tipo_fiscal               text,
  ocr_status                text        NOT NULL DEFAULT 'pending'
                                        CHECK (ocr_status IN ('pending', 'processing', 'done', 'failed')),
  ocr_text                  text,
  ocr_completed_at          timestamptz,
  uploaded_by               uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz,
  deleted_original_folder_id uuid       REFERENCES public.folders(id) ON DELETE SET NULL,

  CONSTRAINT uq_document_hash_per_company UNIQUE (company_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_documents_company_folder ON public.documents (company_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_deleted        ON public.documents (deleted_at);
CREATE INDEX IF NOT EXISTS idx_documents_search         ON public.documents USING GIN (
  to_tsvector('portuguese', public.immutable_unaccent(name || ' ' || coalesce(ocr_text, '')))
);
CREATE INDEX IF NOT EXISTS idx_documents_company        ON public.documents (company_id);

-- ---------------------------------------------------------------------------
-- ocr_jobs
-- Única autoridade sobre estado de OCR (I3 / R3).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ocr_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid        NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  status        text        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts      int         NOT NULL DEFAULT 0,
  started_at    timestamptz,
  finished_at   timestamptz,
  error_message text,
  next_retry_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocr_jobs_status ON public.ocr_jobs (status, created_at);

-- ---------------------------------------------------------------------------
-- favorites (com FK real — sem modelo polimórfico: ADR-006)
-- CHECK garante que exatamente um dos dois campos é NOT NULL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.favorites (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  document_id uuid        REFERENCES public.documents(id) ON DELETE CASCADE,
  folder_id   uuid        REFERENCES public.folders(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_favorites_one_target
    CHECK ((document_id IS NOT NULL) <> (folder_id IS NOT NULL)),
  CONSTRAINT uq_favorites_user_document
    UNIQUE (user_id, document_id),
  CONSTRAINT uq_favorites_user_folder
    UNIQUE (user_id, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_favorites_user ON public.favorites (user_id);

-- ---------------------------------------------------------------------------
-- activity_log (append-only — NUNCA UPDATE nem DELETE: I1 / R2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_log (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  company_id        uuid        NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  action            text        NOT NULL CHECK (action IN (
                      'upload', 'view', 'move', 'rename', 'delete',
                      'restore', 'download', 'favorite', 'unfavorite'
                    )),
  item_type         text        NOT NULL CHECK (item_type IN ('document', 'folder')),
  item_id           uuid        NOT NULL,
  item_name_snapshot text       NOT NULL,
  metadata          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_user_date    ON public.activity_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_item         ON public.activity_log (item_id, item_type);
CREATE INDEX IF NOT EXISTS idx_activity_company_date ON public.activity_log (company_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Trigger: updated_at automático em documents
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_updated_at ON public.documents;
CREATE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Habilitar RLS em todas as tabelas de usuário
-- (políticas implementadas na migration M1.3/M1.4)
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_company_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ocr_jobs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorites          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log       ENABLE ROW LEVEL SECURITY;
