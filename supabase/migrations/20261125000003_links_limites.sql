-- =============================================================================
-- Docke — Links com limite de acessos e "só visualizar" (achado A5-77 da
-- avaliação de 25/11/2026). Colunas novas com padrão que mantém o
-- comportamento atual (sem limite, download liberado): não altera dados.
-- =============================================================================

ALTER TABLE public.shares
  ADD COLUMN IF NOT EXISTS max_views integer CHECK (max_views IS NULL OR max_views > 0),
  ADD COLUMN IF NOT EXISTS allow_download boolean NOT NULL DEFAULT true;

-- As rotas públicas (papel docke_share_public) precisam ler as duas colunas.
GRANT SELECT (max_views, allow_download) ON public.shares TO docke_share_public;
