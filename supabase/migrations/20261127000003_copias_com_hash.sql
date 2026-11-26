-- Documentos copiados ("Copiar estrutura" com documentos, Alt ao arrastar)
-- passam a ter o hash do original e a marca de cópia.
--
-- Antes, a cópia gravava content_hash = NULL (a unicidade do hash por empresa
-- não deixava repetir). Com isso a cópia ficava fora das listas (que escondem
-- envio incompleto, sem hash) e a limpeza de envios incompletos a apagaria
-- depois de 6 horas.
--
-- O hash continua único por empresa para os originais (é o que barra o mesmo
-- arquivo enviado duas vezes); cópias podem repetir o hash do original.
--
-- Aditivo: coluna nova e um índice único parcial criado ANTES de soltar a
-- restrição antiga (todas as linhas de hoje já o respeitam). Nenhum dado é
-- alterado ou apagado.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS copied_from uuid REFERENCES public.documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.documents.copied_from IS
  'Documento de origem quando este é uma cópia (repete o content_hash dele). NULL = original.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_document_hash_original
  ON public.documents (company_id, content_hash)
  WHERE copied_from IS NULL;

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS uq_document_hash_per_company;
