-- Fase 3.5: "número sempre com contexto" — adiciona documents_today
-- (uploads nas últimas 24h) na materialized view. Materialized view não
-- aceita ADD COLUMN, então recria do zero (view pequena, barato).
DROP MATERIALIZED VIEW public.mv_company_stats;

CREATE MATERIALIZED VIEW public.mv_company_stats AS
SELECT
  c.id AS company_id,
  (SELECT count(*) FROM public.documents d
   WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS total_documents,
  (SELECT count(*) FROM public.folders f
   WHERE f.company_id = c.id AND f.deleted_at IS NULL) AS total_folders,
  (SELECT count(*) FROM public.documents d
   WHERE d.company_id = c.id AND d.deleted_at IS NULL
     AND d.created_at >= now() - interval '7 days') AS recent_uploads,
  (SELECT count(*) FROM public.documents d
   WHERE d.company_id = c.id AND d.deleted_at IS NULL
     AND d.created_at >= now() - interval '1 day') AS documents_today
FROM public.companies c;

CREATE UNIQUE INDEX idx_mv_company_stats_company_id ON public.mv_company_stats (company_id);
GRANT SELECT ON public.mv_company_stats TO authenticated, service_role;

REFRESH MATERIALIZED VIEW public.mv_company_stats;
