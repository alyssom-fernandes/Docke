-- Códigos de recuperação da verificação em duas etapas (achado FA-A8-01 da
-- avaliação de 25/11/2026). Quem perde o celular entra com a senha e um dos
-- códigos; o código vale uma vez só, o app autenticador da conta é apagado e
-- os administradores das empresas da pessoa são avisados. Guardamos só o
-- HMAC do código (a chave fica na API, fora do banco).
--
-- Aditivo: tabela nova, lida e escrita só pela API (service_role).

CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  code_hash   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);

COMMENT ON TABLE public.mfa_recovery_codes IS
  'Códigos de recuperação da verificação em duas etapas (só o HMAC; cada um vale uma vez).';

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user ON public.mfa_recovery_codes (user_id) WHERE used_at IS NULL;

ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.mfa_recovery_codes TO service_role;
