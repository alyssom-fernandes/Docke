-- M3.4: adiciona 'undo' como ação válida no activity_log
-- O evento de undo é criado quando o usuário desfaz uma ação (I1 append-only).

ALTER TABLE public.activity_log
  DROP CONSTRAINT IF EXISTS activity_log_action_check;

ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_action_check
    CHECK (action IN (
      'upload', 'view', 'move', 'rename', 'delete',
      'restore', 'download', 'favorite', 'unfavorite', 'undo'
    ));
