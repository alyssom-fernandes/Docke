-- =============================================================================
-- Docke — Fix: recursão infinita em políticas RLS
-- Problema: policies em user_company_access referenciavam a própria tabela
-- em subqueries, causando "infinite recursion detected in policy".
-- Solução: funções SECURITY DEFINER que executam como o owner (bypassa RLS)
-- e são chamadas pelas policies em vez de subqueries diretas.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Funções auxiliares SECURITY DEFINER (sem RLS durante execução)
-- ---------------------------------------------------------------------------

-- Retorna true se auth.uid() é membro de qualquer empresa.
CREATE OR REPLACE FUNCTION public.is_company_member(p_company_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_company_access
    WHERE user_id    = auth.uid()
      AND company_id = p_company_id
  );
$$;

-- Retorna true se auth.uid() é admin ou manager (com acesso total, folder_path IS NULL).
CREATE OR REPLACE FUNCTION public.is_company_admin(p_company_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_company_access
    WHERE user_id          = auth.uid()
      AND company_id       = p_company_id
      AND permission_level IN ('admin', 'manager')
      AND folder_path IS NULL
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_company_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_admin(uuid)  TO authenticated;

-- ---------------------------------------------------------------------------
-- Drop e recria policies problemáticas
-- ---------------------------------------------------------------------------

-- COMPANIES
DROP POLICY IF EXISTS "companies_select_member" ON public.companies;
CREATE POLICY "companies_select_member"
  ON public.companies FOR SELECT
  TO authenticated
  USING (public.is_company_member(id));

-- USERS (referenciava uca indiretamente — mantém join mas via função)
DROP POLICY IF EXISTS "users_select_self_or_company" ON public.users;
CREATE POLICY "users_select_self_or_company"
  ON public.users FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_company_access my_uca
      JOIN public.user_company_access their_uca
        ON their_uca.company_id = my_uca.company_id
       AND their_uca.user_id    = users.id
      WHERE my_uca.user_id = auth.uid()
    )
  );

-- USER_COMPANY_ACCESS — todas as policies que auto-referenciam a tabela
DROP POLICY IF EXISTS "uca_select_own_or_admin"  ON public.user_company_access;
DROP POLICY IF EXISTS "uca_insert_admin"          ON public.user_company_access;
DROP POLICY IF EXISTS "uca_update_admin"          ON public.user_company_access;
DROP POLICY IF EXISTS "uca_delete_admin"          ON public.user_company_access;

-- SELECT: usuário vê a própria entrada OU é admin da empresa
CREATE POLICY "uca_select_own_or_admin"
  ON public.user_company_access FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_company_admin(company_id)
  );

-- INSERT: apenas admin da empresa pode criar entradas
CREATE POLICY "uca_insert_admin"
  ON public.user_company_access FOR INSERT
  TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

-- UPDATE: apenas admin da empresa pode alterar
CREATE POLICY "uca_update_admin"
  ON public.user_company_access FOR UPDATE
  TO authenticated
  USING     (public.is_company_admin(company_id))
  WITH CHECK (public.is_company_admin(company_id));

-- DELETE: apenas admin da empresa pode remover
CREATE POLICY "uca_delete_admin"
  ON public.user_company_access FOR DELETE
  TO authenticated
  USING (public.is_company_admin(company_id));
