-- Pedido de acesso dentro do Docke (benchmark B3.1.6): quem abre o link
-- interno de uma pasta que não acessa pede acesso; o admin da empresa aprova
-- (com papel e prazo) ou recusa, e quem pediu é avisado.
--
-- Aditivo: tabela nova e dois tipos novos de aviso (a lista só ganha valores).

CREATE TABLE IF NOT EXISTS public.access_requests (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  folder_id       uuid         NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  requester_id    uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  message         text         CHECK (message IS NULL OR length(message) <= 500),
  status          text         NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'recusado')),
  decided_by      uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  role_granted    text,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_access_requests_pendente
  ON public.access_requests (requester_id, folder_id) WHERE status = 'pendente';
CREATE INDEX IF NOT EXISTS idx_access_requests_company ON public.access_requests (company_id, status, created_at DESC);

ALTER TABLE public.access_requests ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.access_requests TO service_role;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring',
    'obligation_overdue', 'obligation_at_risk', 'obligation_blocked', 'obligation_expired',
    'obligation_review',
    'retention_expiring_90', 'retention_expiring_30', 'retention_expiring_7',
    'upload_request_received',
    'access_request', 'access_request_decided'
  ]::text[]));
