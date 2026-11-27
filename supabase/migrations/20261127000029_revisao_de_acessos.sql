-- Revisão periódica de acessos (achados A9-21, FA-A9-05, B3.1.7 e B3.7.8 da
-- avaliação de 25/11/2026): campanha com responsável e prazo, foto de quem
-- acessa o quê no dia em que começou, decisão "manter" ou "retirar" por pessoa
-- (com quem decidiu, quando e observação) e repetição automática a cada 3, 6
-- ou 12 meses. A foto e as decisões ficam guardadas como evidência.
--
-- Aditivo: duas tabelas novas, usadas só pela API com a conexão de serviço
-- (a API confere quem administra a empresa antes); o RLS fica ligado e sem
-- política para o papel authenticated. Um tipo novo de aviso para o
-- responsável ("access_review").

CREATE TABLE IF NOT EXISTS public.access_reviews (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  title          text         NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  reviewer_id    uuid         NOT NULL REFERENCES public.users(id),
  due_date       date         NOT NULL,
  repeat_months  int          CHECK (repeat_months IS NULL OR repeat_months IN (3, 6, 12)),
  created_by     uuid         NOT NULL REFERENCES public.users(id),
  created_at     timestamptz  NOT NULL DEFAULT now(),
  closed_at      timestamptz,
  closed_by      uuid         REFERENCES public.users(id)
);

COMMENT ON TABLE public.access_reviews IS
  'Campanha de revisão de acessos: responsável, prazo, repetição e quando foi concluída.';

CREATE INDEX IF NOT EXISTS idx_access_reviews_company ON public.access_reviews (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.access_review_items (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id    uuid         NOT NULL REFERENCES public.access_reviews(id) ON DELETE CASCADE,
  user_id      uuid         NOT NULL REFERENCES public.users(id),
  person_name  text         NOT NULL,
  email        text,
  snapshot     jsonb        NOT NULL DEFAULT '[]'::jsonb,
  decision     text         CHECK (decision IS NULL OR decision IN ('manter', 'retirar')),
  note         text         CHECK (note IS NULL OR length(note) <= 500),
  decided_by   uuid         REFERENCES public.users(id),
  decided_at   timestamptz,
  CONSTRAINT uq_access_review_person UNIQUE (review_id, user_id)
);

COMMENT ON TABLE public.access_review_items IS
  'Uma pessoa na campanha: os acessos que tinha quando a revisão começou (snapshot) e a decisão.';

ALTER TABLE public.access_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_review_items ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.access_reviews, public.access_review_items TO service_role;

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
    'security_incident',
    'security_alert',
    'access_review'
  ]::text[]));
