-- Lotes de envio consultáveis depois (achados B1.1.9 e B4.3.7 da avaliação
-- de 25/11/2026): cada envio de vários arquivos fica registrado no servidor,
-- com o total, quantos entraram e o motivo de cada falha. Fechar a aba no
-- meio deixa o lote "interrompido", e o resumo pode ser consultado e baixado
-- depois. Ao terminar, quem enviou recebe um aviso que fica na central.
--
-- Aditivo: tabela nova (lida pelo dono do lote; gravada pela API) e um tipo
-- novo na lista de avisos (os tipos que já existiam continuam).

CREATE TABLE IF NOT EXISTS public.upload_batches (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  folder_id    uuid,
  folder_name  text,
  total        integer     NOT NULL CHECK (total >= 0),
  ok           integer     NOT NULL DEFAULT 0 CHECK (ok >= 0),
  falhas       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  data_original boolean    NOT NULL DEFAULT false,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);

COMMENT ON TABLE public.upload_batches IS
  'Envios de vários arquivos: total, quantos entraram e o motivo de cada falha (consultável depois de fechar a aba).';

CREATE INDEX IF NOT EXISTS idx_upload_batches_user ON public.upload_batches (user_id, started_at DESC);

ALTER TABLE public.upload_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "upload_batches_own" ON public.upload_batches;
CREATE POLICY "upload_batches_own" ON public.upload_batches FOR SELECT TO authenticated
  USING (user_id = auth.uid());
GRANT SELECT ON public.upload_batches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.upload_batches TO service_role;

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring',
    'obligation_overdue', 'obligation_at_risk', 'obligation_blocked', 'obligation_expired',
    'obligation_review',
    'retention_expiring_90', 'retention_expiring_30', 'retention_expiring_7',
    'upload_request_received',
    'access_request', 'access_request_decided',
    'lgpd_request', 'security_incident', 'security_alert', 'access_review',
    'upload_batch'
  ]));
