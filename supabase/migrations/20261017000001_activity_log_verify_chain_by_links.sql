-- Verificação da trilha encadeada: segue os elos de hash, não o horário.
--
-- A versão anterior (20260723000016) ordenava os eventos por (created_at, id)
-- e comparava cada prev_hash com o hash do evento "anterior" nessa ordem. Só
-- que a cadeia é montada na ORDEM DE GRAVAÇÃO (trigger com FOR UPDATE na
-- activity_log_chain), e as duas ordens divergem em casos normais:
--   * vários eventos na mesma transação têm o mesmo now() — o desempate por id
--     (uuid aleatório) embaralha a ordem;
--   * o seed/reset da demo grava eventos com created_at sorteado nos últimos
--     7 dias, fora da ordem de inserção.
-- Nos dois casos a tela "Verificar integridade" acusava "Cadeia quebrada" sem
-- adulteração nenhuma.
--
-- Agora: o primeiro evento é o que tem prev_hash = '\x00'; o próximo é o que
-- aponta (prev_hash) para o hash do atual, e assim por diante. Um evento é
-- válido se for alcançável por essa caminhada E se o HMAC recalculado bater.
-- Evento apagado no meio → os seguintes ficam inalcançáveis → "Cadeia
-- quebrada". Conteúdo alterado (inclusive o prev_hash) → HMAC não bate →
-- "Evento adulterado". Assinatura e retorno da função não mudam.

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
  walk AS (
    SELECT e.id, e.hash, 1 AS pos
    FROM ev e
    WHERE e.prev_hash = '\x00'::bytea
    UNION ALL
    SELECT e.id, e.hash, w.pos + 1
    FROM walk w
    JOIN ev e ON e.prev_hash = w.hash
  )
  SELECT
    e.id,
    e.created_at,
    (w.id IS NOT NULL AND e.hash = e.recomputed),
    CASE
      WHEN w.id IS NULL
        THEN 'Cadeia quebrada: este evento não encadeia com o anterior.'
      WHEN e.hash <> e.recomputed
        THEN 'Evento adulterado: o conteúdo não bate mais com o hash gravado.'
      ELSE NULL
    END
  FROM ev e
  LEFT JOIN walk w ON w.id = e.id
  ORDER BY coalesce(w.pos, 2147483647), e.created_at, e.id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.activity_log_verify_chain(uuid) TO authenticated;
