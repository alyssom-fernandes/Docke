-- =============================================================================
-- Docke — Exportação completa por empresa (achado X2-16 da avaliação de 25/11/2026)
--
-- Antes só existia o download em lote de até 50 arquivos: não havia como tirar
-- todos os documentos, a árvore de pastas, os metadados e a trilha de uma vez
-- (para auditoria, fiscalização ou troca de fornecedor).
--
-- Cada pedido vira uma linha aqui; o worker de exportação (backend) monta os
-- ZIPs no storage e grava as partes. O acesso é só pela API, com a conexão
-- administrativa e a checagem de admin da empresa: o RLS fica ligado e sem
-- política para o papel authenticated. Tabela nova: não altera dados.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_exports (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  requested_by   uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  status         text        NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  -- [{"key": "...", "name": "...", "size_bytes": 123, "documents": 10}]
  parts          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  document_count int,
  total_bytes    bigint,
  hash_mismatches int,
  error_message  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  expires_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_company_exports_company ON public.company_exports (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_exports_status  ON public.company_exports (status, created_at);

ALTER TABLE public.company_exports ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_exports TO service_role;
