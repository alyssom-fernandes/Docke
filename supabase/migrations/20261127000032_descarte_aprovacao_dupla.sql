-- Aprovação dupla opcional na fila de descarte (achado B3.4.5 da avaliação de
-- 25/11/2026): com a regra ligada, um documento só fica aprovado para
-- descarte quando duas pessoas diferentes aprovam. A primeira aprovação fica
-- registrada no item até a segunda.
--
-- Aditivo: uma coluna na empresa (desligada por padrão, nada muda para quem
-- não ligar) e duas colunas opcionais no item da fila (o GRANT da tabela já
-- cobre as colunas novas).

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS retention_double_approval boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.companies.retention_double_approval IS
  'Descarte exige a aprovação de duas pessoas diferentes.';

ALTER TABLE public.retention_review_queue
  ADD COLUMN IF NOT EXISTS first_approved_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS first_approved_at timestamptz;

COMMENT ON COLUMN public.retention_review_queue.first_approved_by IS
  'Aprovação dupla: quem aprovou primeiro (o item segue pendente até a segunda pessoa).';
