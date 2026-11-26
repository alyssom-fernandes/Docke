-- Quem enviou o link e de qual empresa (A1-11).
--
-- O papel docke_share_public (rotas /s/{token}) não lê companies nem users,
-- de propósito. Esta função devolve só o nome da empresa e o nome de quem
-- criou o link ativo — o que o destinatário precisa para confiar no link —
-- e nada mais. Aditiva.

CREATE OR REPLACE FUNCTION public.share_public_context(p_share_id uuid)
RETURNS TABLE(company_name text, sender_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.name::text, u.full_name::text
  FROM public.shares s
  JOIN public.companies c ON c.id = s.company_id
  LEFT JOIN public.users u ON u.id = s.created_by
  WHERE s.id = p_share_id AND s.revoked_at IS NULL AND s.expired_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.share_public_context(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.share_public_context(uuid) TO docke_share_public, service_role;
