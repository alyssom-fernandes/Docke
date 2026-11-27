-- Adiar e arquivar avisos (achado B4.4.1 da avaliação de 25/11/2026), como
-- na caixa de entrada do Linear: "adiar" esconde o aviso até a data escolhida
-- e ele volta como não lido; "arquivar" tira da caixa sem apagar (fica em
-- "Arquivados", e a limpeza de 90 dias vale igual).
--
-- Aditivo: duas colunas opcionais e um índice. A pessoa já pode atualizar os
-- próprios avisos (GRANT UPDATE e RLS por user_id existentes).

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at   timestamptz;

COMMENT ON COLUMN public.notifications.snoozed_until IS 'Adiado: some da caixa até esta data e volta como não lido.';
COMMENT ON COLUMN public.notifications.archived_at IS 'Arquivado pela pessoa: fora da caixa de entrada, ainda consultável.';

CREATE INDEX IF NOT EXISTS idx_notifications_caixa
  ON public.notifications (user_id, created_at DESC)
  WHERE archived_at IS NULL;
