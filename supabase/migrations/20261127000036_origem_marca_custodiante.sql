-- Três itens da avaliação de 25/11/2026, todos aditivos:
--
-- B1.3.9: de onde veio cada valor de metadado (digitado, em lote, valor
-- padrão da pasta ou cópia de modelo). Coluna nova e opcional; os valores que
-- já existem ficam sem origem (o painel não mostra nada para eles).
--
-- B2.4.7: marca d'água configurável por empresa (texto extra, intensidade e
-- onde aparece). Coluna nova e opcional; vazia = o comportamento de hoje.
--
-- B3.4.3: bloqueio judicial por custodiante: todos os documentos que uma
-- pessoa enviou na empresa ficam protegidos. A lista de tipos aceitos ganha
-- 'custodian' (as linhas que já existem continuam válidas) e a função
-- document_is_under_hold passa a considerar esse tipo; os outros tipos
-- seguem exatamente como antes.

ALTER TABLE public.document_field_value
  ADD COLUMN IF NOT EXISTS source text
  CHECK (source IS NULL OR source IN ('manual', 'lote', 'padrao', 'modelo'));

COMMENT ON COLUMN public.document_field_value.source IS
  'Origem do valor: manual (digitado), lote, padrao (valor padrão da pasta aplicado) ou modelo (copiado de um modelo).';

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS watermark jsonb;

COMMENT ON COLUMN public.companies.watermark IS
  'Marca d''água: {"texto", "intensidade": fraca|media|forte, "previa": bool, "link": bool}. Vazio = padrão.';

ALTER TABLE public.legal_holds DROP CONSTRAINT IF EXISTS legal_holds_resource_type_check;
ALTER TABLE public.legal_holds ADD CONSTRAINT legal_holds_resource_type_check
  CHECK (resource_type IN ('document', 'folder', 'custodian'));

CREATE OR REPLACE FUNCTION public.document_is_under_hold(p_document_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.legal_holds h
    WHERE h.resource_type = 'document' AND h.resource_id = p_document_id AND h.released_at IS NULL
  ) OR EXISTS (
    SELECT 1 FROM public.legal_holds h
    JOIN public.folders hf ON hf.id = h.resource_id
    JOIN public.documents d ON d.id = p_document_id
    JOIN public.folders df ON df.id = d.folder_id
    WHERE h.resource_type = 'folder' AND h.released_at IS NULL
      AND hf.path @> df.path
  ) OR EXISTS (
    SELECT 1 FROM public.legal_holds h
    JOIN public.documents d ON d.id = p_document_id
    WHERE h.resource_type = 'custodian' AND h.released_at IS NULL
      AND h.company_id = d.company_id AND h.resource_id = d.uploaded_by
  );
$$;
GRANT EXECUTE ON FUNCTION public.document_is_under_hold(uuid) TO authenticated, service_role;
