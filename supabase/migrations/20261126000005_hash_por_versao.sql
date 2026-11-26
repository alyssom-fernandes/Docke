-- Impressão digital (SHA-256) de cada versão (J1-08, B1.4.8).
--
-- Antes só o envio original tinha hash (documents.content_hash, usado também
-- para achar duplicatas). Uma versão nova trocava o arquivo sem registrar o
-- hash dele, então não dava para provar que o arquivo guardado hoje é o mesmo
-- que foi enviado. A coluna nova é preenchida no envio de cada versão (e
-- copiada ao restaurar). Nenhum dado existente é alterado: para a versão 1 o
-- backend usa documents.content_hash, que é o hash desse mesmo arquivo; versões
-- enviadas antes desta migration aparecem como "sem registro".

ALTER TABLE public.document_versions
  ADD COLUMN IF NOT EXISTS sha256 text
    CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$');

COMMENT ON COLUMN public.document_versions.sha256 IS
  'SHA-256 (hex) do arquivo desta versão, calculado no servidor ao confirmar o envio.';

-- Nome da versão (A5-66, B1.4.3): "v3 — aprovada pelo jurídico". Opcional.
ALTER TABLE public.document_versions
  ADD COLUMN IF NOT EXISTS label text
    CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 80);
