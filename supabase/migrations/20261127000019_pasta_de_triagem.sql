-- Pasta de triagem (benchmark B1.1.8): uma pasta por empresa marcada como
-- "Entrada". O que chega sem destino certo fica nela; o Docke sugere pasta,
-- tipo e competência por regras (sem IA) e quem administra confirma em lote.
-- Nada sai de lá sem confirmação.
--
-- Aditivo: uma coluna com padrão e um índice único parcial.

ALTER TABLE public.folders ADD COLUMN IF NOT EXISTS is_inbox boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_folders_inbox_por_empresa ON public.folders (company_id) WHERE is_inbox AND deleted_at IS NULL;
