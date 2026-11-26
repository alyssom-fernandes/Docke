-- Pedidos do titular (LGPD art. 18 e 19; benchmark B3.7.2): canal e fluxo
-- com protocolo, prazo, responsável, verificação de identidade e histórico.
-- O pedido chega pelo formulário público da empresa (se ela ligar o canal) ou
-- é registrado pelo admin quando vem por e-mail, telefone ou balcão.
-- O CPF não é guardado em claro: só o resumo SHA-256 e os dois últimos dígitos.
--
-- Aditivo: duas tabelas novas, uma coluna com padrão em companies e um tipo
-- novo de aviso (a lista só ganha valores).

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS lgpd_channel_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.lgpd_requests (
  id                    uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  protocolo             text         NOT NULL UNIQUE,
  codigo_hash           text,        -- código de acompanhamento do formulário público (SHA-256)
  tipo                  text         NOT NULL CHECK (tipo IN ('confirmacao', 'acesso', 'correcao', 'eliminacao', 'portabilidade',
                                                          'anonimizacao', 'informacao', 'revogacao', 'oposicao')),
  canal                 text         NOT NULL CHECK (canal IN ('formulario', 'email', 'telefone', 'presencial', 'outro')),
  titular_nome          text         NOT NULL CHECK (length(titular_nome) BETWEEN 2 AND 200),
  titular_cpf_sha256    text,
  titular_cpf_final     text         CHECK (titular_cpf_final IS NULL OR titular_cpf_final ~ '^[0-9]{2}$'),
  contato               text         CHECK (contato IS NULL OR length(contato) <= 200),
  descricao             text         CHECK (descricao IS NULL OR length(descricao) <= 2000),
  status                text         NOT NULL DEFAULT 'recebido'
                                     CHECK (status IN ('recebido', 'verificando', 'em_andamento', 'concluido', 'negado')),
  identidade_verificada boolean      NOT NULL DEFAULT false,
  identidade_metodo     text         CHECK (identidade_metodo IS NULL OR length(identidade_metodo) <= 200),
  responsavel_id        uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  prazo                 date         NOT NULL,
  resposta              text         CHECK (resposta IS NULL OR length(resposta) <= 4000),
  created_by            uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  concluido_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_lgpd_requests_company ON public.lgpd_requests (company_id, status, prazo);

CREATE TABLE IF NOT EXISTS public.lgpd_request_events (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid         NOT NULL REFERENCES public.lgpd_requests(id) ON DELETE CASCADE,
  user_id     uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  tipo        text         NOT NULL CHECK (tipo IN ('criado', 'status', 'responsavel', 'identidade', 'prazo', 'nota', 'resposta')),
  detalhe     text         CHECK (detalhe IS NULL OR length(detalhe) <= 4000),
  created_at  timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lgpd_request_events_req ON public.lgpd_request_events (request_id, created_at);

ALTER TABLE public.lgpd_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lgpd_request_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lgpd_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lgpd_request_events TO service_role;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring',
    'obligation_overdue', 'obligation_at_risk', 'obligation_blocked', 'obligation_expired',
    'obligation_review',
    'retention_expiring_90', 'retention_expiring_30', 'retention_expiring_7',
    'upload_request_received',
    'access_request', 'access_request_decided',
    'lgpd_request'
  ]::text[]));
