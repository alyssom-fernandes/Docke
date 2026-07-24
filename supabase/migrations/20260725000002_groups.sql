-- =============================================================================
-- Docke — Fase 9.2: grupos + atribuição de acesso por grupo
--
-- Modelo: `group` (escopado por empresa) + `group_member` (N:N usuário↔grupo)
-- + `group_access` (concessão de acesso — mesmo shape de user_company_access,
-- mas o sujeito é o grupo). `user_has_access()` passa a resolver candidatos
-- de AMBAS as fontes (direta + via grupo), com a mesma regra de especificidade
-- (I7) já usada, e um desempate adicional: concessão DIRETA do usuário vence
-- concessão via grupo quando o nível de especificidade é o mesmo (precedência
-- "user > group", conforme padrão observado nas 11 rodadas — Box/Egnyte).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabela group — escopada por empresa (sem papéis de sistema aqui).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public."group" (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES public.users(id),
  UNIQUE (company_id, name)
);

-- ---------------------------------------------------------------------------
-- 2. Tabela group_member — N:N usuário↔grupo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.group_member (
  group_id    uuid NOT NULL REFERENCES public."group"(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 3. Tabela group_access — concessão de acesso pro grupo (mesmo shape de
--    user_company_access), com role_id sincronizado do mesmo jeito.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.group_access (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id          uuid NOT NULL REFERENCES public."group"(id) ON DELETE CASCADE,
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  folder_path       ltree,  -- NULL = empresa toda
  permission_level  text NOT NULL CHECK (permission_level IN ('visualizador', 'operador', 'admin')),
  role_id           uuid REFERENCES public.role(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  granted_by        uuid REFERENCES public.users(id),
  UNIQUE (group_id, company_id, folder_path)
);

CREATE INDEX IF NOT EXISTS idx_group_access_company ON public.group_access (company_id);
CREATE INDEX IF NOT EXISTS idx_group_access_group ON public.group_access (group_id);
CREATE INDEX IF NOT EXISTS idx_group_access_folder_path ON public.group_access USING GIST (folder_path);
CREATE INDEX IF NOT EXISTS idx_group_member_user ON public.group_member (user_id);

DROP TRIGGER IF EXISTS trg_sync_role_id_group ON public.group_access;
CREATE TRIGGER trg_sync_role_id_group
  BEFORE INSERT OR UPDATE OF permission_level ON public.group_access
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_role_id_from_permission_level();

-- ---------------------------------------------------------------------------
-- 4. user_has_access() — passa a unir concessões diretas e via grupo.
--    Mesma assinatura (uuid, ltree, uuid) → CREATE OR REPLACE, sem DROP.
--    Empate de especificidade: direto (0) vence grupo (1).
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
  SELECT key FROM (
    SELECT
      r.key,
      CASE WHEN uca.folder_path IS NULL THEN 0 ELSE nlevel(uca.folder_path) END AS specificity,
      0 AS source_rank
    FROM public.user_company_access uca
    JOIN public.role r ON r.id = uca.role_id
    WHERE uca.user_id = p_user_id
      AND uca.company_id = p_company_id
      AND (uca.folder_path IS NULL OR uca.folder_path @> p_target_path)

    UNION ALL

    SELECT
      r.key,
      CASE WHEN ga.folder_path IS NULL THEN 0 ELSE nlevel(ga.folder_path) END AS specificity,
      1 AS source_rank
    FROM public.group_access ga
    JOIN public.role r ON r.id = ga.role_id
    JOIN public.group_member gm ON gm.group_id = ga.group_id AND gm.user_id = p_user_id
    WHERE ga.company_id = p_company_id
      AND (ga.folder_path IS NULL OR ga.folder_path @> p_target_path)
  ) candidates
  ORDER BY specificity DESC, source_rank ASC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.user_has_access(uuid, ltree, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_access(uuid, ltree, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. RLS — membro da empresa lê grupos/membros/concessões da própria
--    empresa; escrita é feita via admin_conn no backend (mesmo padrão de
--    user_company_access), então não há policy de INSERT/UPDATE/DELETE.
-- ---------------------------------------------------------------------------
ALTER TABLE public."group"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_access ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "group_select" ON public."group";
CREATE POLICY "group_select"
  ON public."group" FOR SELECT
  TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "group_member_select" ON public.group_member;
CREATE POLICY "group_member_select"
  ON public.group_member FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public."group" g
      WHERE g.id = group_member.group_id AND public.is_company_member(g.company_id)
    )
  );

DROP POLICY IF EXISTS "group_access_select" ON public.group_access;
CREATE POLICY "group_access_select"
  ON public.group_access FOR SELECT
  TO authenticated
  USING (public.is_company_member(company_id));

GRANT SELECT ON public."group", public.group_member, public.group_access TO authenticated;
GRANT ALL ON public."group", public.group_member, public.group_access TO service_role;
