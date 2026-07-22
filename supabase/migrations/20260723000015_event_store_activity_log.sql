-- Fase 2.1 (pesquisa "Auditoria e conformidade"): activity_log vira event
-- store de verdade — particionada por mês, sem CHECK fixo de action, com
-- campos de contexto (categoria, severidade, request/correlation id, IP,
-- user-agent) e cadeia de hash HMAC-SHA256 pra tornar adulteração detectável.
--
-- Só 87 linhas em produção hoje (verificado antes de escrever esta
-- migration) — recriar a tabela do zero e reinserir é seguro e rápido,
-- não precisa da dança de "criar tabela nova + copiar em lotes" que uma
-- tabela grande exigiria.

-- ---------------------------------------------------------------------------
-- Chave HMAC e estado da cadeia — NUNCA acessíveis diretamente pelas roles
-- da aplicação (authenticated/service_role não recebem GRANT nenhum aqui).
-- Só a função SECURITY DEFINER abaixo enxerga essas tabelas, exatamente
-- para que adulteração via UPDATE direto na linha não consiga recalcular
-- um hash válido sem conhecer a chave.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_log_hmac_key (
  id  boolean PRIMARY KEY DEFAULT true CHECK (id),
  key bytea NOT NULL
);
ALTER TABLE public.activity_log_hmac_key ENABLE ROW LEVEL SECURITY;

INSERT INTO public.activity_log_hmac_key (key)
SELECT extensions.gen_random_bytes(32)
WHERE NOT EXISTS (SELECT 1 FROM public.activity_log_hmac_key);

CREATE TABLE IF NOT EXISTS public.activity_log_chain (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  last_hash  bytea NOT NULL
);
ALTER TABLE public.activity_log_chain ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Função de hash encadeado. SECURITY DEFINER: roda com o dono (quem aplicou
-- a migration), não com o role de quem disparou o INSERT — é assim que
-- authenticated/service_role conseguem inserir em activity_log sem nunca
-- ter acesso direto à chave nem ao estado da cadeia.
-- ---------------------------------------------------------------------------
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
BEGIN
  SELECT key INTO v_key FROM public.activity_log_hmac_key LIMIT 1;

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

  -- O encadeamento de verdade está aqui: prev_hash entra nos BYTES que vão
  -- pro HMAC, não só no JSON (colocar prev_hash dentro do payload seria
  -- decorativo — o hash resultante precisa depender dele).
  NEW.hash := extensions.hmac(v_prev || convert_to(v_payload, 'utf8'), v_key, 'sha256');

  UPDATE public.activity_log_chain SET last_hash = NEW.hash WHERE company_id = NEW.company_id;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Nova activity_log particionada por mês
-- ---------------------------------------------------------------------------
-- Renomear a tabela NÃO renomeia os índices dela — 'idx_activity_user_date'
-- etc. continuam existindo com esses nomes até a tabela antiga ser dropada
-- no fim deste arquivo, então os índices novos abaixo colidiriam se
-- tivessem o mesmo nome. Renomeia os índices antigos junto.
ALTER TABLE public.activity_log RENAME TO activity_log_old_20260723;
ALTER INDEX idx_activity_user_date    RENAME TO idx_activity_user_date_old_20260723;
ALTER INDEX idx_activity_item         RENAME TO idx_activity_item_old_20260723;
ALTER INDEX idx_activity_company_date RENAME TO idx_activity_company_date_old_20260723;

CREATE TABLE public.activity_log (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  company_id         uuid        NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  -- Sem CHECK fixo (era uma lista de 9 valores editada a cada feature nova
  -- em 3 migrations diferentes) — validação de vocabulário de ação fica no
  -- backend, que pode evoluir sem depender de migration.
  action             text        NOT NULL,
  item_type          text        NOT NULL CHECK (item_type IN ('document', 'folder')),
  item_id            uuid        NOT NULL,
  item_name_snapshot text        NOT NULL,
  metadata           jsonb,
  event_category     text        NOT NULL DEFAULT 'document',
  severity           text        NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  actor_type         text        NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system')),
  request_id         uuid,
  correlation_id     uuid,
  ip                 inet,
  user_agent         text,
  prev_hash          bytea,
  hash               bytea,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Partições mensais de 2026-06 (mês mais antigo com dado real) até 2028-12 —
-- folga de mais de 2 anos antes de precisar gerar mais partições. Partição
-- DEFAULT como rede de segurança pra nunca falhar um INSERT por falta de
-- partição, mesmo que a geração periódica de partições futuras seja
-- esquecida (ver nota de acompanhamento no plano da Fase 2).
DO $$
DECLARE
  d date := date '2026-06-01';
BEGIN
  WHILE d < date '2029-01-01' LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.activity_log FOR VALUES FROM (%L) TO (%L)',
      'activity_log_' || to_char(d, 'YYYY_MM'),
      d,
      d + interval '1 month'
    );
    d := d + interval '1 month';
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.activity_log_default PARTITION OF public.activity_log DEFAULT;

CREATE TRIGGER trg_activity_log_hash
  BEFORE INSERT ON public.activity_log
  FOR EACH ROW EXECUTE FUNCTION public.activity_log_set_hash();

-- Índices — auto-propagam pras partições existentes e futuras (PG11+).
CREATE INDEX idx_activity_user_date    ON public.activity_log (user_id, created_at DESC);
CREATE INDEX idx_activity_item         ON public.activity_log (item_id, item_type);
CREATE INDEX idx_activity_company_date ON public.activity_log (company_id, created_at DESC);
-- BRIN: ~99% menor que B-tree pra uma coluna que só cresce (created_at) —
-- útil justamente pra continuar rápido depois que houver muitas partições.
CREATE INDEX idx_activity_created_brin ON public.activity_log USING BRIN (created_at);
-- GIN só serve pra contenção (metadata @> '{"chave":"valor"}'), NUNCA pra
-- igualdade em campo específico (metadata->>'campo' = 'x' vira seq scan e
-- sofre o mesmo problema de TOAST medido na pesquisa — se algum campo de
-- metadata precisar de filtro frequente por igualdade, a solução é um
-- índice de expressão B-tree dedicado, não este GIN).
CREATE INDEX idx_activity_metadata_gin ON public.activity_log USING GIN (metadata);

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "activity_log_select"
  ON public.activity_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id    = auth.uid()
        AND uca.company_id = activity_log.company_id
    )
  );

CREATE POLICY "activity_log_insert"
  ON public.activity_log FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id    = auth.uid()
        AND uca.company_id = activity_log.company_id
    )
  );

-- Tabela nova = sem os GRANTs que o "ON ALL TABLES IN SCHEMA public" de
-- 20260627000005 deu de uma vez só (aquele comando só pega tabelas que já
-- existiam na hora que rodou).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.activity_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.activity_log TO service_role;

-- ---------------------------------------------------------------------------
-- Migra os eventos existentes — passam pelo trigger de hash normalmente,
-- então também ganham uma cadeia válida a partir do genesis (\x00).
-- ORDER BY company_id, created_at garante que a cadeia de cada empresa
-- nasce em ordem cronológica.
-- ---------------------------------------------------------------------------
INSERT INTO public.activity_log
  (id, user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata, created_at)
SELECT id, user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata, created_at
FROM public.activity_log_old_20260723
ORDER BY company_id, created_at ASC;

DROP TABLE public.activity_log_old_20260723;
