-- Pedido de arquivos ligado a uma obrigação (achados A7-55 e B3.5.8 da
-- avaliação de 25/11/2026): o contador ou o despachante recebe o link pela
-- própria obrigação e, quando manda o arquivo, ele já fica vinculado à
-- competência (e vai para conferência, se a obrigação pede), fechando a
-- pendência sem ninguém precisar achar e vincular o documento depois.
--
-- Aditivo: uma coluna opcional nova em upload_requests e um índice. Nenhum
-- dado existente muda; pedidos antigos ficam com a coluna vazia.

ALTER TABLE public.upload_requests
  ADD COLUMN IF NOT EXISTS obligation_instance_id uuid
  REFERENCES public.obligation_instances(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.upload_requests.obligation_instance_id IS
  'Competência de obrigação que o pedido comprova: cada arquivo recebido é vinculado a ela.';

CREATE INDEX IF NOT EXISTS idx_upload_requests_obligation
  ON public.upload_requests (obligation_instance_id)
  WHERE obligation_instance_id IS NOT NULL;
