-- Pedir arquivos a terceiros (benchmark FA-A4-11, B3.5.8, B1.1.6 em parte):
-- link de envio para o contador, o fornecedor ou o funcionário mandarem
-- arquivos direto para uma pasta, sem conta no Docke. O que chega passa pela
-- mesma conferência do envio normal (tamanho, conteúdo × extensão, SHA-256,
-- duplicidade) e avisa quem pediu.
--
-- Aditivo: duas tabelas novas e um tipo novo de aviso (a lista de tipos só
-- ganha um valor). Nenhum dado existente é alterado.

CREATE TABLE IF NOT EXISTS public.upload_requests (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  folder_id      uuid         NOT NULL REFERENCES public.folders(id) ON DELETE CASCADE,
  token          text         NOT NULL UNIQUE,
  title          text         NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  message        text         CHECK (message IS NULL OR length(message) <= 1000),
  password_hash  text,
  expires_at     timestamptz  NOT NULL,
  max_files      int          NOT NULL DEFAULT 20 CHECK (max_files BETWEEN 1 AND 200),
  revoked_at     timestamptz,
  created_by     uuid         NOT NULL REFERENCES public.users(id),
  created_at     timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.upload_requests IS
  'Pedido de arquivos por link: quem tem o link (e a senha, se houver) envia arquivos para folder_id até expires_at.';

CREATE INDEX IF NOT EXISTS idx_upload_requests_folder ON public.upload_requests (folder_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.upload_request_files (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id    uuid         NOT NULL REFERENCES public.upload_requests(id) ON DELETE CASCADE,
  document_id   uuid         REFERENCES public.documents(id) ON DELETE SET NULL,
  sender_name   text         NOT NULL CHECK (length(sender_name) BETWEEN 1 AND 120),
  file_name     text         NOT NULL,
  size_bytes    bigint,
  confirmed_at  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.upload_request_files IS
  'Cada arquivo recebido por um pedido: quem mandou (nome informado) e o documento criado. confirmed_at NULL = envio ainda não concluído.';

CREATE INDEX IF NOT EXISTS idx_upload_request_files_request ON public.upload_request_files (request_id, created_at DESC);

ALTER TABLE public.upload_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upload_request_files ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.upload_requests, public.upload_request_files TO service_role;
GRANT SELECT ON public.upload_requests, public.upload_request_files TO authenticated;

-- Quem vê a pasta vê os pedidos dela (o RLS de folders vale na subconsulta).
DROP POLICY IF EXISTS upload_requests_select ON public.upload_requests;
CREATE POLICY upload_requests_select ON public.upload_requests
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.folders f WHERE f.id = upload_requests.folder_id));

DROP POLICY IF EXISTS upload_request_files_select ON public.upload_request_files;
CREATE POLICY upload_request_files_select ON public.upload_request_files
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.upload_requests r WHERE r.id = upload_request_files.request_id));

-- Aviso a quem pediu quando um arquivo chega.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring',
    'obligation_overdue', 'obligation_at_risk', 'obligation_blocked', 'obligation_expired',
    'obligation_review',
    'retention_expiring_90', 'retention_expiring_30', 'retention_expiring_7',
    'upload_request_received'
  ]::text[]));
