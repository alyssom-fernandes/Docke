-- Abertura de link público pelo visitante na trilha de auditoria (achado
-- B3.2.8 da avaliação de 25/11/2026): além de share_accesses, cada abertura
-- (e cada tentativa recusada) entra na trilha encadeada da empresa, com o nome
-- que o visitante informou no termo, nunca como "usuário anônimo".
--
-- O visitante não tem conta: o evento fica em nome de quem criou o link, como
-- ação do sistema (actor_type = 'system'), e o visitante vai em metadata.
--
-- Aditivo: só uma função nova, chamada pelo papel restrito dos links públicos.

CREATE OR REPLACE FUNCTION public.log_share_access_trail(p_share_id uuid, p_success boolean, p_visitor text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s record;
  nome text;
BEGIN
  SELECT id, company_id, resource_type, resource_id, created_by INTO s FROM public.shares WHERE id = p_share_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF s.resource_type = 'document' THEN
    SELECT name INTO nome FROM public.documents WHERE id = s.resource_id;
  ELSE
    SELECT name INTO nome FROM public.folders WHERE id = s.resource_id;
  END IF;
  INSERT INTO public.activity_log
    (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, actor_type, severity, metadata)
  VALUES
    (s.created_by, s.company_id,
     CASE WHEN p_success THEN 'share_access' ELSE 'share_access_denied' END,
     CASE WHEN s.resource_type = 'document' THEN 'document' ELSE 'folder' END,
     s.resource_id, coalesce(nome, 'item'), 'share', 'system',
     CASE WHEN p_success THEN 'info' ELSE 'warning' END,
     jsonb_build_object('visitante', coalesce(nullif(btrim(left(p_visitor, 120)), ''), 'não informado')));
END;
$$;

REVOKE ALL ON FUNCTION public.log_share_access_trail(uuid, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_share_access_trail(uuid, boolean, text) TO docke_share_public, service_role;
