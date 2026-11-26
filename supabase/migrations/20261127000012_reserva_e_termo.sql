-- Reserva para edição (check-out/check-in, benchmark B1.4.7), termo de
-- confidencialidade nos links públicos (B3.2.5) e base legal e finalidade
-- por pasta (LGPD, B3.7.6).
--
-- Aditivo: uma tabela nova e colunas novas, todas opcionais. Nenhum dado muda.

-- 1) Reserva: quem reservou edita (versão nova, nome, metadados, mover,
--    excluir); os outros só leem até liberar. Tabela própria para não mexer no
--    "Modificado em" do documento.
CREATE TABLE IF NOT EXISTS public.document_checkouts (
  document_id  uuid         PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
  company_id   uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id      uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  note         text         CHECK (note IS NULL OR length(note) <= 200),
  created_at   timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.document_checkouts IS 'Documento reservado para edição: só user_id altera até liberar (admin da empresa pode forçar a liberação).';

ALTER TABLE public.document_checkouts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_checkouts TO service_role;
GRANT SELECT ON public.document_checkouts TO authenticated;
DROP POLICY IF EXISTS document_checkouts_select ON public.document_checkouts;
CREATE POLICY document_checkouts_select ON public.document_checkouts
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_checkouts.document_id));

-- 2) Termo de confidencialidade no link público: o visitante lê e informa o
--    nome antes de abrir; o aceite fica registrado no acesso.
ALTER TABLE public.shares ADD COLUMN IF NOT EXISTS terms_text text CHECK (terms_text IS NULL OR length(terms_text) <= 4000);
ALTER TABLE public.share_accesses ADD COLUMN IF NOT EXISTS visitor_name text CHECK (visitor_name IS NULL OR length(visitor_name) <= 120);

-- 3) Base legal e finalidade (LGPD art. 7º e 11) registradas na pasta
--    classificada; valem para as subpastas, como a classificação.
ALTER TABLE public.folders
  ADD COLUMN IF NOT EXISTS legal_basis text CHECK (legal_basis IS NULL OR length(legal_basis) <= 120),
  ADD COLUMN IF NOT EXISTS purpose text CHECK (purpose IS NULL OR length(purpose) <= 500);

-- As rotas públicas de link usam o papel docke_share_public, limitado por coluna.
GRANT SELECT (terms_text) ON public.shares TO docke_share_public;
GRANT INSERT (visitor_name) ON public.share_accesses TO docke_share_public;

-- A pasta é atualizada pela conexão do usuário (RLS): libera as colunas novas.
GRANT UPDATE (legal_basis, purpose) ON public.folders TO authenticated;
