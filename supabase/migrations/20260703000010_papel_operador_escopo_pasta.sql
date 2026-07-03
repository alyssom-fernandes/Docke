-- =============================================================================
-- Papel "operador" (leitura+escrita escopada por pasta) + fusão visualizador/auditor
--
-- Contexto (retomando decisão original de planejamento — ADR-001/R5 do
-- 03-MANUAL-EXECUCAO.md — que já previa herança de permissão via ltree, mas
-- cuja UI de concessão nunca chegou a ser construída):
--
--   - "auditor" e "visualizador" tinham, na prática, a mesma capacidade
--     (leitura + log de atividade — activity_log_select nunca discriminou
--     por permission_level). Fundidos em um só papel: "visualizador".
--   - Novo papel "operador": pode ver, fazer upload, mover e excluir
--     documentos DENTRO das pastas às quais tem acesso — mas só pode excluir
--     os documentos que ELE MESMO inseriu (checado na aplicação, não aqui:
--     RLS não distingue "quem fez upload" de forma prática para UPDATE).
--     Não cria/renomeia/exclui pastas — isso continua exclusivo de admin.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Remover a constraint antiga ANTES de migrar os dados.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_company_access
  DROP CONSTRAINT IF EXISTS user_company_access_permission_level_check;

-- ---------------------------------------------------------------------------
-- 2. Migrar dados existentes: auditor -> visualizador (fusão).
-- ---------------------------------------------------------------------------
UPDATE public.user_company_access
SET permission_level = 'visualizador'
WHERE permission_level = 'auditor';

-- ---------------------------------------------------------------------------
-- 3. Constraint nova.
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_company_access
  ADD CONSTRAINT user_company_access_permission_level_check
    CHECK (permission_level IN ('visualizador', 'operador', 'admin'));

-- ---------------------------------------------------------------------------
-- 4. RLS de documents: 'operador' ganha INSERT/UPDATE dentro do seu escopo
--    (igual 'admin' nesse nível — a restrição de "só exclui o que inseriu"
--    é aplicada no service layer, não aqui, porque RLS não consegue
--    distinguir de forma limpa "isto é uma exclusão" de "isto é outro
--    UPDATE" sem inspecionar a transição de deleted_at por trigger).
--    folders_insert/folders_update NÃO mudam — permanecem admin-only.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "documents_insert" ON public.documents;
CREATE POLICY "documents_insert"
  ON public.documents FOR INSERT
  TO authenticated
  WITH CHECK (
    folder_id IS NULL
      AND public.user_has_access(auth.uid(), NULL::ltree, company_id) IN ('admin', 'operador')
    OR
    folder_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.folders f
        WHERE f.id = documents.folder_id
          AND public.user_has_access(auth.uid(), f.path, company_id) IN ('admin', 'operador')
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
        AND public.user_has_access(auth.uid(), NULL::ltree, company_id) IN ('admin', 'operador')
      OR
      folder_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.folders f
          WHERE f.id = documents.folder_id
            AND public.user_has_access(auth.uid(), f.path, company_id) IN ('admin', 'operador')
        )
    )
  )
  WITH CHECK (
    folder_id IS NULL
      AND public.user_has_access(auth.uid(), NULL::ltree, company_id) IN ('admin', 'operador')
    OR
    folder_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.folders f
        WHERE f.id = documents.folder_id
          AND public.user_has_access(auth.uid(), f.path, company_id) IN ('admin', 'operador')
      )
  );

-- folders_insert/folders_update: sem alteração — permanecem exigindo 'admin'.
-- is_company_admin(): sem alteração — continua checando só 'admin' com
-- folder_path IS NULL (usado para gestão de empresa/usuários/config, que
-- continua exclusiva de admin/supremo).
