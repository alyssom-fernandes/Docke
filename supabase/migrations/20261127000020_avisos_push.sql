-- Avisos no celular por Web Push (benchmark B4.4.5; decisão do dono 26/11).
-- Cada aparelho que liga os avisos grava uma inscrição; o worker envia os
-- avisos novos da central (cifrados para o aparelho) e marca pushed_at.
--
-- Aditivo: tabela nova e uma coluna sem padrão (NULL) em notifications.

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  endpoint    text         NOT NULL UNIQUE CHECK (endpoint ~ '^https://' AND length(endpoint) <= 1000),
  p256dh      text         NOT NULL CHECK (length(p256dh) <= 200),
  auth        text         NOT NULL CHECK (length(auth) <= 100),
  user_agent  text         CHECK (user_agent IS NULL OR length(user_agent) <= 300),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  failures    int          NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON public.push_subscriptions (user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_subscriptions TO service_role;

ALTER TABLE public.notifications ADD COLUMN IF NOT EXISTS pushed_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_notifications_push_pendente ON public.notifications (created_at) WHERE pushed_at IS NULL;
