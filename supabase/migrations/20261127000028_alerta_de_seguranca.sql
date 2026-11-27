-- Alertas de segurança ao administrador (achado B4.4.6 da avaliação de
-- 25/11/2026): verificação em duas etapas zerada ou desligada e link público
-- criado sem senha ou sem prazo. Um tipo novo de aviso, separado dos eventos
-- da trilha; não pode ser silenciado (a rota de preferências só aceita os
-- avisos de rotina).
--
-- Aditivo: a lista de tipos aceitos só ganha 'security_alert'.

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
    'security_alert'
  ]::text[]));
