-- Eventos da NF-e (benchmark B2.5.9): o XML de cancelamento, carta de
-- correção ou manifestação que entra no acervo é lido e ligado à nota pela
-- chave de 44 dígitos; a nota passa a mostrar que foi cancelada ou corrigida.
--
-- Aditivo: tabela nova. Nenhum dado existente é alterado.

CREATE TABLE IF NOT EXISTS public.nfe_eventos (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id   uuid         NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  chave         text         NOT NULL CHECK (chave ~ '^[0-9]{44}$'),
  tipo          text         NOT NULL,
  descricao     text,
  texto         text,
  protocolo     text,
  data_evento   timestamptz,
  lido_em       timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (document_id, tipo, chave)
);

COMMENT ON TABLE public.nfe_eventos IS
  'Evento de NF-e lido de um XML do acervo (110111 cancelamento, 110110 carta de correção, 2102xx manifestação), ligado à nota pela chave.';

CREATE INDEX IF NOT EXISTS idx_nfe_eventos_chave ON public.nfe_eventos (company_id, chave);

ALTER TABLE public.nfe_eventos ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nfe_eventos TO service_role;
GRANT SELECT ON public.nfe_eventos TO authenticated;

DROP POLICY IF EXISTS nfe_eventos_select ON public.nfe_eventos;
CREATE POLICY nfe_eventos_select ON public.nfe_eventos
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = nfe_eventos.document_id));
