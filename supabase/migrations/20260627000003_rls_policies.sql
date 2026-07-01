-- =============================================================================
-- Docke — Políticas RLS
-- Toda verificação de acesso usa public.user_has_access() que já resolve
-- a hierarquia ltree e a regra de especificidade (R5 / I7).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- HELPERS: funções utilitárias chamadas nas policies
-- ---------------------------------------------------------------------------

-- user_company_id: retorna a company_id do usuário autenticado para uma
-- empresa específica (confirma que o usuário é membro).
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.current_user_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- COMPANIES
-- ---------------------------------------------------------------------------
-- Usuário vê apenas empresas às quais tem acesso registrado.
CREATE POLICY "companies_select_member"
  ON public.companies FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id    = auth.uid()
        AND uca.company_id = companies.id
    )
  );

-- Apenas admin (service role) insere/altera/deleta empresas.
-- (service_role bypassa RLS por padrão — nenhuma policy para INSERT/UPDATE/DELETE necessária)

-- ---------------------------------------------------------------------------
-- USERS
-- ---------------------------------------------------------------------------
-- Usuário vê a si mesmo. Admin vê todos da mesma empresa.
CREATE POLICY "users_select_self_or_company"
  ON public.users FOR SELECT
  TO authenticated
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1
      FROM public.user_company_access my_uca
      JOIN public.user_company_access their_uca
        ON their_uca.company_id = my_uca.company_id
       AND their_uca.user_id    = users.id
      WHERE my_uca.user_id = auth.uid()
    )
  );

-- Usuário atualiza apenas o próprio perfil (username, full_name, avatar_url).
CREATE POLICY "users_update_self"
  ON public.users FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ---------------------------------------------------------------------------
-- USER_COMPANY_ACCESS
-- ---------------------------------------------------------------------------
-- Usuário vê apenas suas próprias entradas (ou todas da empresa se for admin).
CREATE POLICY "uca_select_own_or_admin"
  ON public.user_company_access FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.user_company_access admin_uca
      WHERE admin_uca.user_id       = auth.uid()
        AND admin_uca.company_id    = user_company_access.company_id
        AND admin_uca.permission_level IN ('admin', 'manager')
        AND admin_uca.folder_path IS NULL
    )
  );

-- Apenas admin/manager com acesso total (folder_path NULL) pode conceder acesso.
CREATE POLICY "uca_insert_admin"
  ON public.user_company_access FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_company_access admin_uca
      WHERE admin_uca.user_id       = auth.uid()
        AND admin_uca.company_id    = user_company_access.company_id
        AND admin_uca.permission_level IN ('admin', 'manager')
        AND admin_uca.folder_path IS NULL
    )
  );

CREATE POLICY "uca_update_admin"
  ON public.user_company_access FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access admin_uca
      WHERE admin_uca.user_id       = auth.uid()
        AND admin_uca.company_id    = user_company_access.company_id
        AND admin_uca.permission_level IN ('admin', 'manager')
        AND admin_uca.folder_path IS NULL
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_company_access admin_uca
      WHERE admin_uca.user_id       = auth.uid()
        AND admin_uca.company_id    = user_company_access.company_id
        AND admin_uca.permission_level IN ('admin', 'manager')
        AND admin_uca.folder_path IS NULL
    )
  );

CREATE POLICY "uca_delete_admin"
  ON public.user_company_access FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access admin_uca
      WHERE admin_uca.user_id       = auth.uid()
        AND admin_uca.company_id    = user_company_access.company_id
        AND admin_uca.permission_level IN ('admin', 'manager')
        AND admin_uca.folder_path IS NULL
    )
  );

-- ---------------------------------------------------------------------------
-- FOLDERS
-- ---------------------------------------------------------------------------
-- SELECT: usuário tem qualquer acesso à pasta (ou ancestral).
CREATE POLICY "folders_select"
  ON public.folders FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND public.user_has_access(auth.uid(), path, company_id) IS NOT NULL
  );

-- INSERT: precisa de editor, manager ou admin na pasta pai (ou empresa toda).
CREATE POLICY "folders_insert"
  ON public.folders FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_access(auth.uid(), path, company_id)
      IN ('editor', 'manager', 'admin')
  );

-- UPDATE (rename/move): editor+ na pasta atual.
CREATE POLICY "folders_update"
  ON public.folders FOR UPDATE
  TO authenticated
  USING (
    deleted_at IS NULL
    AND public.user_has_access(auth.uid(), path, company_id)
      IN ('editor', 'manager', 'admin')
  )
  WITH CHECK (
    public.user_has_access(auth.uid(), path, company_id)
      IN ('editor', 'manager', 'admin')
  );

-- DELETE (soft delete via UPDATE deleted_at — policy de UPDATE cobre).
-- Hard delete: apenas service role.

-- ---------------------------------------------------------------------------
-- DOCUMENTS
-- ---------------------------------------------------------------------------
-- SELECT: usuário tem qualquer acesso à pasta do documento.
-- Usa subquery para pegar o path da pasta, pois documents não tem path direto.
CREATE POLICY "documents_select"
  ON public.documents FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      -- documento na raiz da empresa (folder_id IS NULL)
      folder_id IS NULL
        AND public.user_has_access(auth.uid(), NULL::ltree, company_id) IS NOT NULL
      OR
      -- documento em pasta específica
      folder_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.folders f
          WHERE f.id = documents.folder_id
            AND public.user_has_access(auth.uid(), f.path, company_id) IS NOT NULL
        )
    )
  );

-- INSERT: editor+ na pasta destino.
CREATE POLICY "documents_insert"
  ON public.documents FOR INSERT
  TO authenticated
  WITH CHECK (
    folder_id IS NULL
      AND public.user_has_access(auth.uid(), NULL::ltree, company_id)
            IN ('editor', 'manager', 'admin')
    OR
    folder_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.folders f
        WHERE f.id = documents.folder_id
          AND public.user_has_access(auth.uid(), f.path, company_id)
                IN ('editor', 'manager', 'admin')
      )
  );

-- UPDATE (metadados, soft delete, mover): editor+ na pasta atual.
CREATE POLICY "documents_update"
  ON public.documents FOR UPDATE
  TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      folder_id IS NULL
        AND public.user_has_access(auth.uid(), NULL::ltree, company_id)
              IN ('editor', 'manager', 'admin')
      OR
      folder_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.folders f
          WHERE f.id = documents.folder_id
            AND public.user_has_access(auth.uid(), f.path, company_id)
                  IN ('editor', 'manager', 'admin')
        )
    )
  )
  WITH CHECK (
    folder_id IS NULL
      AND public.user_has_access(auth.uid(), NULL::ltree, company_id)
            IN ('editor', 'manager', 'admin')
    OR
    folder_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.folders f
        WHERE f.id = documents.folder_id
          AND public.user_has_access(auth.uid(), f.path, company_id)
                IN ('editor', 'manager', 'admin')
      )
  );

-- Hard DELETE: apenas service_role (bypassa RLS).

-- ---------------------------------------------------------------------------
-- OCR_JOBS
-- ---------------------------------------------------------------------------
-- SELECT: usuário vê jobs dos documentos que pode ver.
CREATE POLICY "ocr_jobs_select"
  ON public.ocr_jobs FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = ocr_jobs.document_id
        AND d.deleted_at IS NULL
        AND (
          d.folder_id IS NULL
            AND public.user_has_access(auth.uid(), NULL::ltree, d.company_id) IS NOT NULL
          OR
          d.folder_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.folders f
              WHERE f.id = d.folder_id
                AND public.user_has_access(auth.uid(), f.path, d.company_id) IS NOT NULL
            )
        )
    )
  );

-- INSERT/UPDATE: apenas service_role (worker OCR usa service role key).

-- ---------------------------------------------------------------------------
-- FAVORITES
-- ---------------------------------------------------------------------------
-- Usuário vê, insere e deleta apenas os próprios favoritos.
CREATE POLICY "favorites_select_own"
  ON public.favorites FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "favorites_insert_own"
  ON public.favorites FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "favorites_delete_own"
  ON public.favorites FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- ACTIVITY_LOG  (I1: append-only — sem UPDATE, sem DELETE para authenticated)
-- ---------------------------------------------------------------------------
-- SELECT: usuário vê atividade da própria empresa (qualquer empresa com acesso).
CREATE POLICY "activity_log_select"
  ON public.activity_log FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id    = auth.uid()
        AND uca.company_id = activity_log.company_id
    )
  );

-- INSERT: autenticado pode inserir (registrar ação própria).
-- O backend valida que user_id = auth.uid() antes de chamar.
CREATE POLICY "activity_log_insert"
  ON public.activity_log FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id    = auth.uid()
        AND uca.company_id = activity_log.company_id
    )
  );

-- UPDATE e DELETE: bloqueados para authenticated (I1 — append-only).
-- service_role bypassa RLS e pode corrigir dados via console administrativo.
