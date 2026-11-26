-- Miniaturas na grade e derivado de Office gerado no envio (achados A4-20 e
-- A5-42 da avaliação de 25/11/2026).
--
-- Aditivo: tabela nova e um índice. Nenhum dado existente é alterado.
--
-- O estado fica numa tabela própria, e não em documents, porque qualquer
-- UPDATE em documents muda o "Modificado em" (gatilho set_updated_at). A chave
-- é o caminho do arquivo no storage: uma versão nova tem caminho novo e ganha
-- miniatura nova sozinha.

CREATE TABLE IF NOT EXISTS public.document_thumbnails (
  storage_path text        PRIMARY KEY,
  company_id   uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  ok           boolean     NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.document_thumbnails IS
  'Miniatura gerada (ok = true) ou tentativa sem miniatura possível (ok = false) para o arquivo em storage_path; o objeto fica em derivatives/{storage_path}.thumb.webp.';

CREATE INDEX IF NOT EXISTS idx_document_thumbnails_company ON public.document_thumbnails (company_id);

-- A listagem de documentos procura a miniatura pelo caminho do arquivo.
CREATE INDEX IF NOT EXISTS idx_documents_storage_path ON public.documents (storage_path);

ALTER TABLE public.document_thumbnails ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_thumbnails TO service_role;
GRANT SELECT ON public.document_thumbnails TO authenticated;

-- Quem vê o documento vê se ele tem miniatura (o RLS de documents vale dentro
-- da subconsulta).
DROP POLICY IF EXISTS document_thumbnails_select ON public.document_thumbnails;
CREATE POLICY document_thumbnails_select ON public.document_thumbnails
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.storage_path = document_thumbnails.storage_path));
