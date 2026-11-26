-- Busca sem recalcular o texto de cada documento a cada consulta (achado
-- X3-05 da avaliação de 25/11/2026).
--
-- Coluna GERADA (calculada pelo próprio Postgres a partir de nome, setor,
-- tipo fiscal e texto lido) com índice GIN. É DDL: não roda UPDATE em linha
-- nenhuma, não dispara gatilhos nem muda "modificado em". O texto entra até
-- 200 mil caracteres (limite seguro do tsvector); além disso a busca por
-- trecho (ILIKE) continua cobrindo.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(name, ''))), 'A') ||
    setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(sector, '') || ' ' || coalesce(tipo_fiscal, ''))), 'C') ||
    setweight(to_tsvector('portuguese', public.immutable_unaccent(left(coalesce(ocr_text, ''), 200000))), 'D')
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_documents_search_tsv ON public.documents USING GIN (search_tsv);
