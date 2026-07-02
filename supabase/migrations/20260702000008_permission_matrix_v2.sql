-- =============================================================================
-- ADR-036/037 (Adendos 06/07) — Matriz de permissões final: 4 papéis por empresa
-- visualizador | auditor | admin  (supremo é papel GLOBAL em public.users.role,
-- não faz parte deste enum — supremo administra qualquer empresa sem precisar
-- de uma linha em user_company_access).
--
-- Mapeamento de dados existentes (decisão registrada em docs/05-PROGRESS.md):
--   viewer  -> visualizador  (mesma capacidade: ver + baixar, sem escrita)
--   editor  -> auditor       (nome mais próximo; a permissão de ESCRITA que o
--                              antigo 'editor' tinha deixa de existir nesse nível
--                              — correção do Adendo 07: "auditor" é somente-leitura,
--                              nome reservado permanentemente para leitura pura)
--   manager -> admin         (já era o nível de controle total da empresa)
--
-- Efeito prático: como não existe mais um papel de empresa com escrita mas sem
-- controle administrativo, qualquer usuário que precise fazer upload/mover/
-- excluir documentos precisa ser 'admin' daquela empresa (ou 'supremo' global).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remover a constraint antiga ANTES de migrar os dados — senão o UPDATE
--    tenta gravar os novos valores enquanto a constraint velha ainda proíbe.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_company_access
  DROP CONSTRAINT IF EXISTS user_company_access_permission_level_check;

-- ---------------------------------------------------------------------------
-- 2. Migrar dados existentes
-- ---------------------------------------------------------------------------
UPDATE public.user_company_access
SET permission_level = CASE permission_level
  WHEN 'viewer'  THEN 'visualizador'
  WHEN 'editor'  THEN 'auditor'
  WHEN 'manager' THEN 'admin'
  ELSE permission_level
END
WHERE permission_level IN ('viewer', 'editor', 'manager');

-- ---------------------------------------------------------------------------
-- 3. Adicionar a constraint nova
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_company_access
  ADD CONSTRAINT user_company_access_permission_level_check
    CHECK (permission_level IN ('visualizador', 'auditor', 'admin'));

-- ---------------------------------------------------------------------------
-- 3. Policies de escrita: só 'admin' escreve (auditor passa a ser leitura pura)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "folders_insert" ON public.folders;
CREATE POLICY "folders_insert"
  ON public.folders FOR INSERT
  TO authenticated
  WITH CHECK (public.user_has_access(auth.uid(), path, company_id) = 'admin');

DROP POLICY IF EXISTS "folders_update" ON public.folders;
CREATE POLICY "folders_update"
  ON public.folders FOR UPDATE
  TO authenticated
  USING (
    deleted_at IS NULL
    AND public.user_has_access(auth.uid(), path, company_id) = 'admin'
  )
  WITH CHECK (public.user_has_access(auth.uid(), path, company_id) = 'admin');

DROP POLICY IF EXISTS "documents_insert" ON public.documents;
CREATE POLICY "documents_insert"
  ON public.documents FOR INSERT
  TO authenticated
  WITH CHECK (
    folder_id IS NULL
      AND public.user_has_access(auth.uid(), NULL::ltree, company_id) = 'admin'
    OR
    folder_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.folders f
        WHERE f.id = documents.folder_id
          AND public.user_has_access(auth.uid(), f.path, company_id) = 'admin'
      )
  );

DROP POLICY IF EXISTS "documents_update" ON public.documents;
CREATE POLICY "documents_update"
  ON public.documents FOR UPDATE
  TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      folder_id IS NULL
        AND public.user_has_access(auth.uid(), NULL::ltree, company_id) = 'admin'
      OR
      folder_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.folders f
          WHERE f.id = documents.folder_id
            AND public.user_has_access(auth.uid(), f.path, company_id) = 'admin'
        )
    )
  )
  WITH CHECK (
    folder_id IS NULL
      AND public.user_has_access(auth.uid(), NULL::ltree, company_id) = 'admin'
    OR
    folder_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.folders f
        WHERE f.id = documents.folder_id
          AND public.user_has_access(auth.uid(), f.path, company_id) = 'admin'
      )
  );

-- ---------------------------------------------------------------------------
-- 4. Policies de gestão de user_company_access: 'admin' (era 'manager')
--    O literal 'admin' já existia nessas condições por engano — nunca era um
--    valor válido de permission_level antes desta migration, então na prática
--    essas policies já equivaliam a checar só 'manager'. Simplificado agora.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "uca_select_own_or_admin" ON public.user_company_access;
CREATE POLICY "uca_select_own_or_admin"
  ON public.user_company_access FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_company_admin(company_id)
  );

DROP POLICY IF EXISTS "uca_insert_admin" ON public.user_company_access;
CREATE POLICY "uca_insert_admin"
  ON public.user_company_access FOR INSERT
  TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "uca_update_admin" ON public.user_company_access;
CREATE POLICY "uca_update_admin"
  ON public.user_company_access FOR UPDATE
  TO authenticated
  USING     (public.is_company_admin(company_id))
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "uca_delete_admin" ON public.user_company_access;
CREATE POLICY "uca_delete_admin"
  ON public.user_company_access FOR DELETE
  TO authenticated
  USING (public.is_company_admin(company_id));

CREATE OR REPLACE FUNCTION public.is_company_admin(p_company_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_company_access
    WHERE user_id          = auth.uid()
      AND company_id       = p_company_id
      AND permission_level = 'admin'
      AND folder_path IS NULL
  );
$$;
