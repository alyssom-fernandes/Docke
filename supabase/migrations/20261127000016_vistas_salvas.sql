-- Vistas salvas por pasta (benchmark B1.2.7): ordenação, colunas,
-- agrupamento e filtro por metadado guardados com nome, como no Airtable.
-- Vista compartilhada aparece para todos da empresa; a pessoal só para quem
-- criou. folder_id NULL = vale em qualquer pasta.
--
-- Aditivo: tabela nova.

CREATE TABLE IF NOT EXISTS public.folder_views (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  folder_id   uuid         REFERENCES public.folders(id) ON DELETE CASCADE,
  name        text         NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  config      jsonb        NOT NULL CHECK (jsonb_typeof(config) = 'object' AND length(config::text) <= 4000),
  shared      boolean      NOT NULL DEFAULT true,
  created_by  uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_folder_views_company ON public.folder_views (company_id, folder_id);

ALTER TABLE public.folder_views ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_views TO service_role;
