-- Partições futuras da trilha (X3-13).
--
-- A migration do event store criou partições mensais até 2028-12 e uma
-- DEFAULT. Nada criava as seguintes: a partir de jan/2029 tudo cairia na
-- DEFAULT, e criar a partição depois falharia enquanto a DEFAULT tivesse
-- linhas daquele mês. Esta função cria as que faltam com antecedência; o
-- worker de manutenção a chama a cada ciclo (é barata: só cria o que falta).
-- Aditiva: não toca em dados.

CREATE OR REPLACE FUNCTION public.ensure_activity_log_partitions(months_ahead int DEFAULT 24)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d date := date_trunc('month', now())::date;
  fim date := (date_trunc('month', now()) + make_interval(months => months_ahead))::date;
  nome text;
  criadas int := 0;
BEGIN
  WHILE d <= fim LOOP
    nome := 'activity_log_' || to_char(d, 'YYYY_MM');
    IF to_regclass('public.' || nome) IS NULL THEN
      -- Se a DEFAULT já tiver linhas deste mês, criar a partição falharia:
      -- nesse caso não cria (a linha continua na DEFAULT, nada se perde) e avisa.
      IF EXISTS (SELECT 1 FROM public.activity_log_default WHERE created_at >= d AND created_at < d + interval '1 month') THEN
        RAISE WARNING 'activity_log_default tem linhas de %; partição % não criada', to_char(d, 'YYYY-MM'), nome;
      ELSE
        EXECUTE format(
          'CREATE TABLE public.%I PARTITION OF public.activity_log FOR VALUES FROM (%L) TO (%L)',
          nome, d, (d + interval '1 month')::date
        );
        criadas := criadas + 1;
      END IF;
    END IF;
    d := (d + interval '1 month')::date;
  END LOOP;
  RETURN criadas;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_activity_log_partitions(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_activity_log_partitions(int) TO service_role;

-- Já deixa 36 meses à frente.
SELECT public.ensure_activity_log_partitions(36);
