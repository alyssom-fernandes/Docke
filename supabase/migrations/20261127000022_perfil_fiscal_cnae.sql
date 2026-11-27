-- =============================================================================
-- Perfil fiscal com a atividade principal (CNAE) — achado A9-13.
--
-- O catálogo de obrigações passa a recomendar o que vale para a empresa pelo
-- regime, pela UF, pela atividade e por ter ou não empregados. Só uma coluna
-- nova, opcional: sem CNAE, nada muda.
-- Os GRANTs de company_fiscal_profile são por tabela, então já valem para a
-- coluna nova.
-- =============================================================================

ALTER TABLE public.company_fiscal_profile
  ADD COLUMN IF NOT EXISTS cnae_principal text
  CHECK (cnae_principal IS NULL OR cnae_principal ~ '^[0-9]{7}$');

COMMENT ON COLUMN public.company_fiscal_profile.cnae_principal IS
  'CNAE da atividade principal, só os 7 dígitos (ex.: 4731800 para comércio varejista de combustíveis).';
