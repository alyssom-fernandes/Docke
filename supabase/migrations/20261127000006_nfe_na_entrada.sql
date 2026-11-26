-- NF-e lida no ato do envio (benchmark FA-A4-12, B1.1.10, B2.5.5, B2.5.6):
-- os dados do XML (chave de 44 dígitos, número, série, emitente, destinatário,
-- valor, emissão) ficam guardados para mostrar no documento, achar pela chave
-- e avisar quando a mesma nota já está no acervo.
--
-- Aditivo: tabela nova. Nenhum dado existente é alterado.

CREATE TABLE IF NOT EXISTS public.document_nfe (
  document_id        uuid          PRIMARY KEY REFERENCES public.documents(id) ON DELETE CASCADE,
  company_id         uuid          NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- false: XML lido que não é NF-e/NFC-e (a linha evita ler de novo).
  reconhecida        boolean       NOT NULL,
  chave              text          CHECK (chave IS NULL OR chave ~ '^[0-9]{44}$'),
  modelo             text,
  numero             text,
  serie              text,
  data_emissao       timestamptz,
  natureza_operacao  text,
  emitente_cnpj      text,
  emitente_nome      text,
  destinatario_doc   text,
  destinatario_nome  text,
  valor_total        numeric(15, 2),
  lida_em            timestamptz   NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.document_nfe IS
  'Dados do XML de NF-e/NFC-e lidos no envio (chave de 44 dígitos e cabeçalho da nota). reconhecida = false: XML que não é nota.';

CREATE INDEX IF NOT EXISTS idx_document_nfe_chave ON public.document_nfe (company_id, chave) WHERE chave IS NOT NULL;

ALTER TABLE public.document_nfe ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_nfe TO service_role;
GRANT SELECT ON public.document_nfe TO authenticated;

-- Quem vê o documento vê os dados da nota (o RLS de documents vale na subconsulta).
DROP POLICY IF EXISTS document_nfe_select ON public.document_nfe;
CREATE POLICY document_nfe_select ON public.document_nfe
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.documents d WHERE d.id = document_nfe.document_id));
