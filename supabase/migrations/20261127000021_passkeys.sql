-- Passkeys (digital, rosto ou chave de segurança; benchmark B4.5.8 e B4.2.3,
-- decisão do dono 26/11): cada aparelho cadastrado guarda o id da credencial
-- e a chave pública (formato COSE). A chave privada nunca sai do aparelho.
--
-- Aditivo: tabela nova.

CREATE TABLE IF NOT EXISTS public.passkeys (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  credential_id  text         NOT NULL UNIQUE CHECK (length(credential_id) <= 1400),
  public_key     bytea        NOT NULL,
  sign_count     bigint       NOT NULL DEFAULT 0,
  name           text         NOT NULL DEFAULT 'Este aparelho' CHECK (length(name) <= 80),
  created_at     timestamptz  NOT NULL DEFAULT now(),
  last_used_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_passkeys_user ON public.passkeys (user_id);

ALTER TABLE public.passkeys ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.passkeys TO service_role;
