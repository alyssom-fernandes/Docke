-- Fase 6.1: fallback pg_trgm pra busca por conteúdo.
--
-- Bug relatado pelo usuário antes das 11 rodadas de pesquisa: busca por
-- código (NF-e, CNPJ pontuado, datas tipo "03/2026") falhava
-- intermitentemente mesmo com OCR concluído. Causa raiz confirmada na
-- pesquisa: o stemmer português do to_tsvector/websearch_to_tsquery
-- tokeniza esses códigos de forma imprevisível (pontuação vira separador
-- de palavra, números não recebem tratamento especial) — o que está no
-- índice não bate com o parse da query em boa parte dos casos.
--
-- Fix consenso das 5 IAs: pg_trgm como fallback via ILIKE (contenção de
-- substring, sem tokenização nenhuma) — resolve tanto códigos quanto
-- typos. A extensão pg_trgm já existe desde a migration inicial
-- (20260627000001) mas nunca foi usada em índice nenhum.

CREATE INDEX IF NOT EXISTS idx_documents_ocr_text_trgm ON public.documents USING gin (ocr_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_name_trgm ON public.documents USING gin (name gin_trgm_ops);
