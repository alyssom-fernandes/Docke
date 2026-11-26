-- Política de links públicos por empresa (achado FA-A5-08 da avaliação de
-- 25/11/2026): exigir senha em todo link e limitar a validade máxima. Pasta
-- com dado sensível já não aceita link (20261126000010).
--
-- Aditivo: duas colunas com padrão que mantém o comportamento de hoje (sem
-- senha obrigatória, sem limite). Nenhum dado é alterado.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS share_require_password boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS share_max_days int;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'companies_share_max_days_check') THEN
    ALTER TABLE public.companies
      ADD CONSTRAINT companies_share_max_days_check CHECK (share_max_days IS NULL OR share_max_days BETWEEN 1 AND 3650);
  END IF;
END $$;

COMMENT ON COLUMN public.companies.share_require_password IS 'Todo link público desta empresa precisa de senha.';
COMMENT ON COLUMN public.companies.share_max_days IS 'Validade máxima de um link público, em dias (NULL = sem limite).';
