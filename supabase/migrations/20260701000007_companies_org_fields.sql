-- ADR-014: campos necessários para o CRUD de Organizações/Empresas.
-- cnpj: identificador fiscal, único quando informado.
-- logo_key: chave do objeto no storage (R2) — não é URL pública, resolvida
--           sob demanda via presigned URL (mesmo padrão de documents.storage_path).
-- is_active: soft state — "desativar" nunca remove a linha (R2/I1-like: histórico
--            de documents/folders continua íntegro).

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS cnpj       text,
  ADD COLUMN IF NOT EXISTS logo_key   text,
  ADD COLUMN IF NOT EXISTS is_active  boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_companies_cnpj
  ON public.companies (cnpj)
  WHERE cnpj IS NOT NULL;
