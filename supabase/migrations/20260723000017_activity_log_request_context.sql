-- Fase 2.2: preenche request_id/correlation_id/ip/user_agent automaticamente
-- a partir do contexto da conexão (setado pelo backend via set_config em
-- get_db/get_db_admin) — nenhum dos 12 pontos de INSERT em activity_log
-- precisa saber disso, exatamente como já funciona com auth.uid() hoje.
-- COALESCE com o que o caller já tiver mandado explicitamente (nenhum manda
-- hoje, mas deixa a porta aberta pra um evento futuro que queira sobrescrever).
CREATE OR REPLACE FUNCTION public.activity_log_set_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_prev    bytea;
  v_key     bytea;
  v_payload text;
  v_ip      text;
BEGIN
  SELECT key INTO v_key FROM public.activity_log_hmac_key LIMIT 1;

  NEW.request_id     := coalesce(NEW.request_id, nullif(current_setting('request.id', true), '')::uuid);
  NEW.correlation_id := coalesce(NEW.correlation_id, nullif(current_setting('request.correlation_id', true), '')::uuid);
  NEW.user_agent      := coalesce(NEW.user_agent, nullif(current_setting('request.user_agent', true), ''));

  v_ip := nullif(current_setting('request.ip', true), '');
  IF NEW.ip IS NULL AND v_ip IS NOT NULL AND v_ip <> 'unknown' THEN
    NEW.ip := v_ip::inet;
  END IF;

  -- Garante uma linha de estado por empresa; FOR UPDATE serializa
  -- concorrência — sem isso, duas inserções simultâneas da mesma empresa
  -- podem ler o mesmo last_hash e bifurcar a cadeia.
  INSERT INTO public.activity_log_chain (company_id, last_hash)
  VALUES (NEW.company_id, '\x00'::bytea)
  ON CONFLICT (company_id) DO NOTHING;

  SELECT last_hash INTO v_prev
  FROM public.activity_log_chain
  WHERE company_id = NEW.company_id
  FOR UPDATE;

  NEW.prev_hash := v_prev;

  -- Payload = a linha inteira menos os próprios campos de hash — cobre
  -- qualquer coluna presente ou futura sem precisar listar campo por campo.
  v_payload := (to_jsonb(NEW) - 'hash' - 'prev_hash')::text;

  NEW.hash := extensions.hmac(v_prev || convert_to(v_payload, 'utf8'), v_key, 'sha256');

  UPDATE public.activity_log_chain SET last_hash = NEW.hash WHERE company_id = NEW.company_id;

  RETURN NEW;
END;
$$;
