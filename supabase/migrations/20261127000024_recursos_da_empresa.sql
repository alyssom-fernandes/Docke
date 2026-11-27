-- Recursos que cada empresa liga ou desliga (Ajustes → Recursos).
--
-- Guarda só o que foi mudado: a chave que não aparece vale como ligada (os
-- padrões ficam no código, em app/services/features_service.py). O canal do
-- titular continua na coluna própria (lgpd_channel_enabled). Aditiva.

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS features jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Se um recurso está ligado na empresa. As rotas públicas de link
-- (papel docke_share_public) não leem companies; esta função devolve só o
-- liga/desliga do recurso pedido e nada mais.
CREATE OR REPLACE FUNCTION public.company_feature_enabled(p_company_id uuid, p_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT (c.features ->> p_key)::boolean FROM public.companies c WHERE c.id = p_company_id), true)
$$;

REVOKE ALL ON FUNCTION public.company_feature_enabled(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_feature_enabled(uuid, text) TO authenticated, docke_share_public, service_role;
