-- =============================================================================
-- Registro de incidentes de segurança com dados pessoais (LGPD art. 48;
-- Resolução CD/ANPD 15/2024) — parte que faltava do achado X2-17.
--
-- Cada incidente tem quando a empresa soube, o que vazou ou ficou exposto,
-- quantos titulares, a avaliação de risco, as medidas e, quando o risco é
-- relevante, a comunicação à ANPD e aos titulares (prazo de 3 dias úteis
-- contado de quando a empresa soube). O registro fica guardado mesmo depois
-- de encerrado: a resolução pede a guarda por 5 anos.
--
-- Aditivo: duas tabelas novas e um tipo novo de aviso (a lista só ganha valor).
-- Acesso só pela conexão interna da API, que confere se a pessoa administra a
-- empresa (mesmo modelo dos pedidos do titular).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.security_incidents (
  id                      uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  protocolo               text         NOT NULL UNIQUE,
  titulo                  text         NOT NULL CHECK (length(titulo) BETWEEN 3 AND 200),
  descricao               text         CHECK (descricao IS NULL OR length(descricao) <= 4000),
  descoberto_em           timestamptz  NOT NULL,
  ocorrido_em             timestamptz,
  categorias              text[]       NOT NULL DEFAULT '{}'
                                       CHECK (categorias <@ ARRAY['identificacao', 'contato', 'documentos', 'financeiro',
                                                                  'saude', 'trabalhista', 'credenciais', 'criancas', 'outros']::text[]),
  titulares_afetados      integer      CHECK (titulares_afetados IS NULL OR titulares_afetados >= 0),
  risco_relevante         boolean,     -- NULL: ainda não avaliado
  avaliacao_risco         text         CHECK (avaliacao_risco IS NULL OR length(avaliacao_risco) <= 4000),
  medidas                 text         CHECK (medidas IS NULL OR length(medidas) <= 4000),
  comunicado_anpd_em      timestamptz,
  protocolo_anpd          text         CHECK (protocolo_anpd IS NULL OR length(protocolo_anpd) <= 100),
  comunicado_titulares_em timestamptz,
  status                  text         NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'contido', 'encerrado')),
  responsavel_id          uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  created_by              uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  encerrado_at            timestamptz
);

CREATE INDEX IF NOT EXISTS idx_security_incidents_company ON public.security_incidents (company_id, status, descoberto_em DESC);

CREATE TABLE IF NOT EXISTS public.security_incident_events (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id  uuid         NOT NULL REFERENCES public.security_incidents(id) ON DELETE CASCADE,
  user_id      uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  tipo         text         NOT NULL CHECK (tipo IN ('criado', 'status', 'responsavel', 'risco', 'medidas', 'anpd', 'titulares', 'dados', 'nota')),
  detalhe      text         CHECK (detalhe IS NULL OR length(detalhe) <= 4000),
  created_at   timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_incident_events_inc ON public.security_incident_events (incident_id, created_at);

ALTER TABLE public.security_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_incident_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.security_incidents TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.security_incident_events TO service_role;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring',
    'obligation_overdue', 'obligation_at_risk', 'obligation_blocked', 'obligation_expired',
    'obligation_review',
    'retention_expiring_90', 'retention_expiring_30', 'retention_expiring_7',
    'upload_request_received',
    'access_request', 'access_request_decided',
    'lgpd_request',
    'security_incident'
  ]::text[]));
