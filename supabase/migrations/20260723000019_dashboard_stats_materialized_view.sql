-- Fase 3.1: agregados do dashboard deixam de contar direto em `documents`/
-- `folders` a cada carregamento — viram materialized view, atualizada
-- periodicamente (worker) e sob demanda (botão "Atualizar", Fase 3.3).
--
-- total_favorites NÃO entra aqui: é por usuário (fav.user_id = auth.uid()),
-- não da empresa — materializar isso por empresa estaria errado (o número
-- variaria por quem está olhando). Continua sendo consulta ao vivo, que já
-- é barata (tabela pequena, índice por user_id).
--
-- Materialized views não suportam RLS (limitação do Postgres) — por isso
-- o endpoint que lê daqui PRECISA verificar manualmente que o usuário
-- pertence à empresa antes de devolver a linha (ver companies.py).

CREATE MATERIALIZED VIEW public.mv_company_stats AS
SELECT
  c.id AS company_id,
  (SELECT count(*) FROM public.documents d
   WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS total_documents,
  (SELECT count(*) FROM public.folders f
   WHERE f.company_id = c.id AND f.deleted_at IS NULL) AS total_folders,
  (SELECT count(*) FROM public.documents d
   WHERE d.company_id = c.id AND d.deleted_at IS NULL
     AND d.created_at >= now() - interval '7 days') AS recent_uploads
FROM public.companies c;

-- REFRESH CONCURRENTLY exige um índice único — sem ele, todo refresh
-- bloqueia leituras da view enquanto recalcula.
CREATE UNIQUE INDEX idx_mv_company_stats_company_id ON public.mv_company_stats (company_id);

CREATE TABLE IF NOT EXISTS public.company_stats_refresh (
  company_id  uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.company_stats_refresh ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_stats_refresh_select"
  ON public.company_stats_refresh FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id = auth.uid() AND uca.company_id = company_stats_refresh.company_id
    )
  );

GRANT SELECT ON public.company_stats_refresh TO authenticated;
GRANT SELECT ON public.mv_company_stats TO authenticated, service_role;

-- REFRESH MATERIALIZED VIEW exige ser dono da view — SECURITY DEFINER pra
-- authenticated (via botão "Atualizar") e o worker (job periódico)
-- conseguirem disparar sem precisar de privilégio de superusuário.
CREATE OR REPLACE FUNCTION public.refresh_company_stats()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_company_stats;
  INSERT INTO public.company_stats_refresh (company_id, refreshed_at)
  SELECT id, now() FROM public.companies
  ON CONFLICT (company_id) DO UPDATE SET refreshed_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.refresh_company_stats() TO authenticated, service_role;

-- Primeiro refresh (sem CONCURRENTLY — a view acabou de ser criada, ainda
-- não tem o índice único "pronto para leitura concorrente" na prática, e
-- CONCURRENTLY numa view nunca lida antes falha).
REFRESH MATERIALIZED VIEW public.mv_company_stats;
INSERT INTO public.company_stats_refresh (company_id, refreshed_at)
SELECT id, now() FROM public.companies
ON CONFLICT (company_id) DO UPDATE SET refreshed_at = now();
