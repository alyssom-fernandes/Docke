-- Comentários e anotações em documentos (benchmark B2.4.6, B2.4.9, B2.6.7).
-- Anotação = comentário preso a um ponto da página (coordenadas normalizadas
-- de 0 a 1, independentes do zoom), numa camada separada: o PDF não muda.
-- Fica ligada à versão em que foi feita; a busca também olha o texto delas.
--
-- Aditivo: tabela nova.

CREATE TABLE IF NOT EXISTS public.document_comments (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id  uuid         NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  version_id   uuid         REFERENCES public.document_versions(id) ON DELETE SET NULL,
  user_id      uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  body         text         NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
  page         int          CHECK (page IS NULL OR page >= 1),
  x            real         CHECK (x IS NULL OR (x >= 0 AND x <= 1)),
  y            real         CHECK (y IS NULL OR (y >= 0 AND y <= 1)),
  resolved_at  timestamptz,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CONSTRAINT chk_comment_ponto CHECK ((x IS NULL) = (y IS NULL) AND (x IS NULL OR page IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_document_comments_doc ON public.document_comments (document_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_document_comments_busca ON public.document_comments
  USING gin (to_tsvector('portuguese', body)) WHERE deleted_at IS NULL;

ALTER TABLE public.document_comments ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_comments TO service_role;
