-- Verificação da cadeia da trilha mais rápida (X3-12) e índice das
-- notificações usado pela manutenção (X3-19). Aditiva: só índices e a mesma
-- função com a caminhada indexada; o resultado é o mesmo.

CREATE INDEX IF NOT EXISTS idx_activity_company_prev_hash ON public.activity_log (company_id, prev_hash);
CREATE INDEX IF NOT EXISTS idx_notifications_type_resource ON public.notifications (type, resource_id);

CREATE OR REPLACE FUNCTION public.activity_log_verify_chain(p_company_id uuid)
RETURNS TABLE(event_id uuid, event_created_at timestamptz, ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key       bytea;
  v_last_hash bytea;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.user_company_access uca
         WHERE uca.user_id = auth.uid() AND uca.company_id = p_company_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.users u
         WHERE u.id = auth.uid() AND u.role = 'supremo' AND u.is_active
       )
    THEN
      RAISE EXCEPTION 'Sem acesso à trilha de auditoria desta empresa.' USING ERRCODE = '42501';
    END IF;
  ELSIF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Sem acesso à trilha de auditoria desta empresa.' USING ERRCODE = '42501';
  END IF;

  SELECT key INTO v_key FROM public.activity_log_hmac_key LIMIT 1;
  SELECT c.last_hash INTO v_last_hash FROM public.activity_log_chain c WHERE c.company_id = p_company_id;

  RETURN QUERY
  WITH RECURSIVE
  ev AS (
    SELECT
      al.id, al.created_at, al.prev_hash, al.hash,
      extensions.hmac(
        coalesce(al.prev_hash, '\x00'::bytea) ||
        convert_to((to_jsonb(al) - 'hash' - 'prev_hash')::text, 'utf8'),
        v_key, 'sha256'
      ) AS recomputed
    FROM public.activity_log al
    WHERE al.company_id = p_company_id
  ),
  -- A caminhada usa o índice (company_id, prev_hash) direto na tabela; antes
  -- juntava numa CTE sem índice e ficava quadrática com a trilha grande (X3-12).
  walk AS (
    SELECT al.id, al.hash, 1 AS pos
    FROM public.activity_log al
    WHERE al.company_id = p_company_id AND al.prev_hash = '\x00'::bytea
    UNION ALL
    SELECT al.id, al.hash, w.pos + 1
    FROM walk w
    JOIN public.activity_log al ON al.company_id = p_company_id AND al.prev_hash = w.hash
  ),
  checked AS (
    SELECT
      e.id AS chk_id,
      e.created_at AS chk_created_at,
      (w.id IS NOT NULL AND e.hash = e.recomputed) AS chk_ok,
      CASE
        WHEN w.id IS NULL
          THEN 'Cadeia quebrada: este evento não encadeia com o anterior.'
        WHEN e.hash <> e.recomputed
          THEN 'Evento adulterado: o conteúdo não bate mais com o hash gravado.'
        ELSE NULL
      END AS chk_reason,
      coalesce(w.pos, 2147483647) AS chk_pos
    FROM ev e
    LEFT JOIN walk w ON w.id = e.id
  ),
  tail AS (
    SELECT
      NULL::uuid AS chk_id,
      NULL::timestamptz AS chk_created_at,
      false AS chk_ok,
      'Cadeia truncada: o evento mais recente registrado na cadeia não existe mais.'::text AS chk_reason,
      0 AS chk_pos
    WHERE v_last_hash IS NOT NULL
      AND v_last_hash <> '\x00'::bytea
      AND NOT EXISTS (SELECT 1 FROM ev x WHERE x.hash = v_last_hash)
  )
  SELECT r.chk_id, r.chk_created_at, r.chk_ok, r.chk_reason
  FROM (SELECT * FROM tail UNION ALL SELECT * FROM checked) r
  ORDER BY r.chk_pos, r.chk_created_at, r.chk_id;
END;
$$;


REVOKE ALL ON FUNCTION public.activity_log_verify_chain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_log_verify_chain(uuid) TO authenticated, service_role;
