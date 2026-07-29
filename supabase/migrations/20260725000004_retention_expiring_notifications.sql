-- Fase 14.5: notificações escalonadas de retenção (90/30/7 dias antes do vencimento,
-- não só depois de vencido — complementa o retention_review_queue que só entra em
-- ação quando o prazo já passou).

ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;

ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring',
    'obligation_overdue', 'obligation_at_risk', 'obligation_blocked', 'obligation_expired',
    'retention_expiring_90', 'retention_expiring_30', 'retention_expiring_7'
  ]::text[]));
