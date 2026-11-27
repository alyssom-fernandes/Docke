-- Marcos assinados da trilha de auditoria (achado X3-12 da avaliação de
-- 25/11/2026). A cadeia de hash da trilha usa uma chave guardada no próprio
-- banco: quem tem acesso direto ao banco consegue reescrever o passado e
-- recalcular a cadeia inteira. Uma vez por dia a manutenção grava aqui o topo
-- da cadeia de cada empresa, assinado com uma chave que fica só na API (fora
-- do banco). Na verificação, um marco cujo hash não existe mais na cadeia
-- mostra que o passado foi reescrito, mesmo com a cadeia recalculada.
--
-- Aditivo: tabela nova, lida e escrita só pela API (service_role).

CREATE TABLE IF NOT EXISTS public.activity_log_checkpoints (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  last_hash   bytea       NOT NULL,
  signature   text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.activity_log_checkpoints IS
  'Topo da cadeia da trilha por empresa, assinado pela API com chave fora do banco (marco diário).';

CREATE INDEX IF NOT EXISTS idx_activity_checkpoints_company ON public.activity_log_checkpoints (company_id, created_at DESC);

ALTER TABLE public.activity_log_checkpoints ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.activity_log_checkpoints TO service_role;
