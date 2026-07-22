-- =============================================================================
-- Docke — Fix: user_has_access() não-determinístico com concessões duplicadas
--
-- Problema: user_company_access não tinha UNIQUE(user_id, company_id, folder_path).
-- Se o mesmo usuário recebesse duas concessões no mesmo folder_path (ex: uma
-- 'admin' e outra 'visualizador' criadas por engano), a função
-- user_has_access() ordenava só por nlevel(folder_path) e usava LIMIT 1 — com
-- os dois candidatos empatados em nlevel, o Postgres podia devolver qualquer
-- um dos dois, e a escolha podia mudar entre execuções (plano de query não é
-- garantia de ordem estável sem ORDER BY que desempate).
--
-- Fix:
-- 1. Deduplica linhas existentes (mantém a concessão mais PERMISSIVA por
--    user+company+folder_path — nunca a mais recente por data, que seria
--    arbitrário do ponto de vista de segurança).
-- 2. Cria índices únicos parciais que impedem a duplicata voltar a existir.
-- 3. Reescreve user_has_access() com um desempate determinístico (id) para
--    o caso residual de empate em nlevel que a constraint não cobre.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Deduplica: para cada (user_id, company_id, folder_path) com mais de uma
--    linha, mantém a de permission_level mais permissivo; remove as demais.
-- ---------------------------------------------------------------------------
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, company_id, folder_path
      ORDER BY
        CASE permission_level
          WHEN 'admin' THEN 3
          WHEN 'operador' THEN 2
          ELSE 1
        END DESC,
        created_at DESC
    ) AS rn
  FROM public.user_company_access
)
DELETE FROM public.user_company_access
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- ---------------------------------------------------------------------------
-- 2. Índices únicos parciais (Postgres trata NULL como distinto em UNIQUE
--    normal, por isso duas condições separadas: uma pra folder_path preenchido,
--    outra pra garantir só uma concessão "empresa toda" por usuário).
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_access_user_company_folder
  ON public.user_company_access (user_id, company_id, folder_path)
  WHERE folder_path IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_access_user_company_wide
  ON public.user_company_access (user_id, company_id)
  WHERE folder_path IS NULL;

-- ---------------------------------------------------------------------------
-- 3. user_has_access — desempate determinístico por id quando nlevel empata
--    (defesa em profundidade; após o passo 1+2 não deveria mais ocorrer).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_has_access(
  p_user_id     uuid,
  p_target_path ltree,
  p_company_id  uuid
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT permission_level
  FROM public.user_company_access
  WHERE user_id   = p_user_id
    AND company_id = p_company_id
    AND (
      folder_path IS NULL              -- null = acesso a toda a empresa
      OR folder_path @> p_target_path  -- folder_path é ancestral (ou igual) a target_path
    )
  ORDER BY
    CASE WHEN folder_path IS NULL THEN 0
         ELSE nlevel(folder_path)
    END DESC,                          -- mais específico (maior nlevel) primeiro
    id DESC                            -- desempate determinístico (nunca depende do plano de query)
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.user_has_access(uuid, ltree, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_access(uuid, ltree, uuid) TO service_role;
