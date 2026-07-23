-- =============================================================================
-- Fase 4.5 — Alertas idempotentes por ausência
--
-- "Alertas nascem da AUSÊNCIA, não do upload → scheduler diário. Mas
-- IDEMPOTENTES por scope_id + missing_rule_id + snapshot_version pra não
-- gerar tempestade de notificação." (backlog, seção H)
--
-- Reaproveita a tabela `notifications` já existente (ADR-023/028/031) em vez
-- de criar uma tabela nova — a técnica de idempotência já usada por
-- `_notify_trash_expiring_soon` (NOT EXISTS por type+resource_id) se aplica
-- direto aqui: cada (instância, status) só gera UM registro em
-- `notifications`, porque o `type` muda junto com o status
-- (obligation_overdue → obligation_at_risk → ...), então uma transição real
-- sempre notifica de novo, mas ficar parado no mesmo status nunca repete.
-- =============================================================================

ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;

ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring',
    'obligation_overdue', 'obligation_at_risk', 'obligation_blocked', 'obligation_expired'
  ]::text[]));
