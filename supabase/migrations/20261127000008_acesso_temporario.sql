-- Acesso temporário por pessoa (benchmark B3.1.8): a concessão direta pode ter
-- prazo; ao vencer, o worker retira o acesso e registra na trilha.
--
-- Aditivo: uma coluna nova (nula = sem prazo) e um índice. Nenhum dado muda.

ALTER TABLE public.user_company_access ADD COLUMN IF NOT EXISTS expires_at timestamptz;

COMMENT ON COLUMN public.user_company_access.expires_at IS
  'Fim do acesso temporário (nulo = sem prazo). Vencido, o worker apaga a concessão e registra na trilha.';

CREATE INDEX IF NOT EXISTS idx_user_company_access_expires ON public.user_company_access (expires_at) WHERE expires_at IS NOT NULL;

-- Buscas salvas (benchmark B2.1.5, FA-A3-05/B4.1.4 em parte): a consulta com
-- os filtros, guardada por pessoa e empresa, reexecutável em um clique.
CREATE TABLE IF NOT EXISTS public.saved_searches (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id  uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name        text         NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  query       text         NOT NULL CHECK (length(query) <= 2000),
  created_at  timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (user_id, company_id, name)
);

COMMENT ON TABLE public.saved_searches IS 'Busca salva: query = parâmetros da página de Busca (q e filtros), por pessoa e empresa.';

ALTER TABLE public.saved_searches ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.saved_searches TO service_role;
GRANT SELECT, INSERT, DELETE ON public.saved_searches TO authenticated;

DROP POLICY IF EXISTS saved_searches_own ON public.saved_searches;
CREATE POLICY saved_searches_own ON public.saved_searches
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid() AND public.is_company_member(company_id));
