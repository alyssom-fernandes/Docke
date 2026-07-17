-- Copiar estrutura de pastas (entre empresas ou dentro da mesma empresa):
-- adiciona 'copy' como ação válida no activity_log.

ALTER TABLE public.activity_log
  DROP CONSTRAINT IF EXISTS activity_log_action_check;

ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_action_check
    CHECK (action IN (
      'upload', 'view', 'move', 'rename', 'delete',
      'restore', 'download', 'favorite', 'unfavorite', 'undo', 'copy'
    ));
