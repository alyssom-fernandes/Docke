-- Modelos de estrutura (benchmark B1.5.4, B1.5.6, B1.5.8): o admin guarda a
-- árvore de uma pasta (subpastas, campos de metadados e valores padrão) como
-- um modelo com nome ("Admissão de colaborador", "Contrato de fornecedor") e
-- aplica depois, numa pasta nova ou sobre uma pasta que já existe, sem apagar
-- nada. Cada vez que o modelo é regravado, a versão anterior fica guardada.
-- Documento-modelo: um documento marcado como modelo aparece em "Novo a partir
-- de modelo" e a cópia já nasce com os metadados dele.
--
-- Aditivo: duas tabelas novas e uma coluna com padrão em documents.

CREATE TABLE IF NOT EXISTS public.structure_templates (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name         text         NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description  text         CHECK (description IS NULL OR length(description) <= 500),
  version      int          NOT NULL DEFAULT 1,
  tree         jsonb        NOT NULL,
  created_by   uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_by   uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  archived_at  timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_structure_templates_nome
  ON public.structure_templates (company_id, lower(btrim(name))) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.structure_template_versions (
  template_id  uuid         NOT NULL REFERENCES public.structure_templates(id) ON DELETE CASCADE,
  version      int          NOT NULL,
  tree         jsonb        NOT NULL,
  saved_by     uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  saved_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (template_id, version)
);

ALTER TABLE public.structure_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.structure_template_versions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.structure_templates TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.structure_template_versions TO service_role;

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_documents_template ON public.documents (company_id) WHERE is_template AND deleted_at IS NULL;
