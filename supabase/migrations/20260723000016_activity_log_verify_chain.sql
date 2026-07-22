-- Fase 2.9: função de verificação de integridade da cadeia de hash criada
-- na migration anterior. Recalcula o HMAC de cada evento na ordem em que
-- foram gravados e compara com o que está armazenado — qualquer UPDATE
-- direto na linha (fora do fluxo normal da app) quebra a comparação a
-- partir do ponto adulterado em diante.
CREATE OR REPLACE FUNCTION public.activity_log_verify_chain(p_company_id uuid)
RETURNS TABLE(event_id uuid, event_created_at timestamptz, ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key bytea;
BEGIN
  SELECT key INTO v_key FROM public.activity_log_hmac_key LIMIT 1;

  RETURN QUERY
  WITH ordered AS (
    SELECT al.*, lag(al.hash) OVER (ORDER BY al.created_at, al.id) AS expected_prev
    FROM public.activity_log al
    WHERE al.company_id = p_company_id
  ),
  checked AS (
    SELECT
      o.id, o.created_at, o.prev_hash, o.hash, o.expected_prev,
      extensions.hmac(
        coalesce(o.expected_prev, '\x00'::bytea) ||
        convert_to((to_jsonb(o) - 'hash' - 'prev_hash' - 'expected_prev')::text, 'utf8'),
        v_key, 'sha256'
      ) AS recomputed
    FROM ordered o
  )
  SELECT
    c.id,
    c.created_at,
    (c.prev_hash IS NOT DISTINCT FROM coalesce(c.expected_prev, '\x00'::bytea) AND c.hash = c.recomputed),
    CASE
      WHEN c.prev_hash IS DISTINCT FROM coalesce(c.expected_prev, '\x00'::bytea)
        THEN 'Cadeia quebrada: este evento não encadeia com o anterior.'
      WHEN c.hash <> c.recomputed
        THEN 'Evento adulterado: o conteúdo não bate mais com o hash gravado.'
      ELSE NULL
    END
  FROM checked c
  ORDER BY c.created_at, c.id;
END;
$$;

-- SECURITY DEFINER já cobre o acesso à chave; permitir que a app CHAME a
-- função (isso não expõe a chave nem as tabelas internas, só o resultado).
GRANT EXECUTE ON FUNCTION public.activity_log_verify_chain(uuid) TO authenticated;
