-- Preferências de avisos por pessoa (achado A8-12 da avaliação de 25/11/2026):
-- cada um escolhe quais avisos de rotina não quer receber (pasta ancorada com
-- atividade, versão nova, link aberto, lixeira, obrigação perto de vencer,
-- arquivo recebido por pedido, prazo de guarda a 90/30 dias).
--
-- Os avisos de segurança, de atraso, de conferência e os pedidos de acesso e
-- do titular não podem ser silenciados: a API recusa esses tipos e o gatilho
-- abaixo só descarta o que a pessoa marcou.
--
-- Aditivo: uma coluna nova com valor padrão vazio (ninguém deixa de receber
-- nada até mexer) e um gatilho BEFORE INSERT em notifications.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS notification_mute text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.users.notification_mute IS
  'Tipos de aviso que a pessoa escolheu não receber (só os de rotina; ver notifications_respect_mute).';

CREATE OR REPLACE FUNCTION public.notifications_respect_mute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Nunca silencia o que é de segurança, atraso ou pede ação de alguém.
  IF NEW.type IN ('share_blocked', 'obligation_overdue', 'obligation_blocked', 'obligation_expired',
                  'obligation_review', 'retention_expiring_7', 'access_request', 'access_request_decided',
                  'lgpd_request', 'security_incident') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = NEW.user_id AND NEW.type = ANY (u.notification_mute)) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notifications_respect_mute() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_notifications_respect_mute ON public.notifications;
CREATE TRIGGER trg_notifications_respect_mute
  BEFORE INSERT ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notifications_respect_mute();
