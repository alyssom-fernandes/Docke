-- Verificação em duas etapas (MFA por app autenticador, TOTP do Supabase Auth).
-- Achados X2-12, FA-A1-02, FA-A8-01 e B4.2.3 da avaliação de 25/11/2026;
-- decisão do dono em 26/11/2026: exigir para administradores e para quem
-- acessa pastas com dado pessoal ou sensível (RH e afins).
--
-- A política vale por empresa. O administrador geral sempre precisa.
--   desligada         ninguém é obrigado (quem quiser ativa em Ajustes → Segurança)
--   admins            administradores da empresa
--   admins_sensiveis  administradores e quem acessa pasta marcada como dado pessoal/sensível
--   todos             todo mundo que acessa a empresa
-- Só acrescenta uma coluna: nenhum dado existente muda.

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS mfa_policy text NOT NULL DEFAULT 'admins_sensiveis'
    CHECK (mfa_policy IN ('desligada', 'admins', 'admins_sensiveis', 'todos'));

COMMENT ON COLUMN public.companies.mfa_policy IS
  'Quem precisa da verificação em duas etapas nesta empresa: desligada | admins | admins_sensiveis | todos.';
