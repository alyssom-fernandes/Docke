-- =============================================================================
-- Docke — Fase 9.1: migra permission_level pra roles/role_permissions
--
-- Objetivo: preservar comportamento IDÊNTICO enquanto introduz um modelo de
-- dados real pra papel (em vez de um enum de texto hardcoded), preparando o
-- terreno pra grupos (9.2), origem visível (9.3) e correções de escopo (9.5)
-- sem precisar de outra migration de schema arriscada depois.
--
-- Estratégia de baixo risco:
-- 1. `role` — 3 papéis de sistema (visualizador/operador/admin), globais
--    (company_id NULL), com UUID fixo (fácil de referenciar/auditar).
-- 2. `role_permission` — matriz de capacidades por papel. Ainda não é lida
--    por nenhum router nesta fase (isso é 9.3/9.5) — só populada aqui pra o
--    dado já existir quando for usado, evitando popular sob pressão depois.
-- 3. `user_company_access.role_id` — nova coluna, mantida em sincronia com
--    `permission_level` por TRIGGER. Nenhum código Python muda: todo INSERT/
--    UPDATE que já escreve `permission_level` continua funcionando exatamente
--    igual, e role_id é derivado automaticamente. Zero risco no caminho de
--    escrita.
-- 4. `user_has_access()` passa a resolver via `role_id` → `role.key` (mesmo
--    valor de texto que já devolvia lendo `permission_level` direto — só
--    troca a fonte). Assinatura idêntica (uuid, ltree, uuid) → CREATE OR
--    REPLACE, sem DROP.
--
-- `permission_level` NÃO é removida — continua sendo a "API de escrita" hoje;
-- role_id é o dado derivado/normalizado por trás dela. Remover a coluna de
-- texto fica pra uma fase futura, só depois que todo o app já estiver lendo
-- de `role`/`role_permission` (reduz a superfície de mudança desta migration).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabela role
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid REFERENCES public.companies(id) ON DELETE CASCADE,  -- NULL = papel de sistema, disponível pra qualquer empresa
  key         text NOT NULL,
  label       text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Só um papel de sistema por key (company_id NULL); papéis customizados
-- futuros (9.2/9.6) ficam livres pra repetir key entre empresas diferentes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_system_key
  ON public.role (key) WHERE company_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_company_key
  ON public.role (company_id, key) WHERE company_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Tabela role_permission — matriz de capacidades (ainda não lida por
--    nenhum check hoje; populada pra existir quando 9.3/9.5 passarem a usar).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.role_permission (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id     uuid NOT NULL REFERENCES public.role(id) ON DELETE CASCADE,
  permission  text NOT NULL,
  UNIQUE (role_id, permission)
);

-- ---------------------------------------------------------------------------
-- 3. Seed dos 3 papéis de sistema, UUID fixo (facilita auditoria/backfill).
-- ---------------------------------------------------------------------------
INSERT INTO public.role (id, company_id, key, label, is_system) VALUES
  ('00000000-0000-0000-0001-000000000001', NULL, 'visualizador',  'Visualizador',    true),
  ('00000000-0000-0000-0001-000000000002', NULL, 'operador',      'Operador',        true),
  ('00000000-0000-0000-0001-000000000003', NULL, 'admin',         'Administrador',   true)
ON CONFLICT DO NOTHING;

-- Matriz de capacidades — reflete o comportamento HOJE já implementado nos
-- routers (documents.py, folders.py, custom_fields.py, retention_legal.py,
-- obligations.py etc.), só agora como dado em vez de string espalhada.
INSERT INTO public.role_permission (role_id, permission)
SELECT '00000000-0000-0000-0001-000000000001', p FROM unnest(ARRAY[
  'documents.read', 'folders.read', 'search.read', 'activity.read', 'obligations.read'
]) AS p
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permission (role_id, permission)
SELECT '00000000-0000-0000-0001-000000000002', p FROM unnest(ARRAY[
  'documents.read', 'folders.read', 'search.read', 'activity.read', 'obligations.read',
  'documents.write', 'documents.delete_own', 'versions.write', 'metadata.write'
]) AS p
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permission (role_id, permission)
SELECT '00000000-0000-0000-0001-000000000003', p FROM unnest(ARRAY[
  'documents.read', 'folders.read', 'search.read', 'activity.read', 'obligations.read',
  'documents.write', 'documents.delete_own', 'versions.write', 'metadata.write',
  'documents.delete_any', 'folders.manage', 'metadata.manage', 'users.manage',
  'retention.manage', 'obligations.manage', 'custom_fields.manage'
]) AS p
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. user_company_access.role_id — derivado automaticamente, nunca escrito
--    manualmente pelo backend (a API de escrita continua permission_level).
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_company_access
  ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES public.role(id);

UPDATE public.user_company_access uca
SET role_id = r.id
FROM public.role r
WHERE r.company_id IS NULL AND r.key = uca.permission_level AND uca.role_id IS NULL;

ALTER TABLE public.user_company_access
  ALTER COLUMN role_id SET NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_role_id_from_permission_level()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT r.id INTO NEW.role_id
  FROM public.role r
  WHERE r.company_id IS NULL AND r.key = NEW.permission_level;

  IF NEW.role_id IS NULL THEN
    RAISE EXCEPTION 'permission_level "%" não corresponde a nenhum papel de sistema conhecido', NEW.permission_level;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_role_id ON public.user_company_access;
CREATE TRIGGER trg_sync_role_id
  BEFORE INSERT OR UPDATE OF permission_level ON public.user_company_access
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_role_id_from_permission_level();

-- ---------------------------------------------------------------------------
-- 5. user_has_access() — mesma assinatura e mesmo texto de retorno, agora
--    resolvido via role_id → role.key em vez de ler permission_level direto.
--    CREATE OR REPLACE (não DROP): assinatura (uuid, ltree, uuid) não muda.
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
  SELECT r.key
  FROM public.user_company_access uca
  JOIN public.role r ON r.id = uca.role_id
  WHERE uca.user_id   = p_user_id
    AND uca.company_id = p_company_id
    AND (
      uca.folder_path IS NULL
      OR uca.folder_path @> p_target_path
    )
  ORDER BY
    CASE WHEN uca.folder_path IS NULL THEN 0
         ELSE nlevel(uca.folder_path)
    END DESC,
    uca.id DESC
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.user_has_access(uuid, ltree, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.user_has_access(uuid, ltree, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 6. RLS — leitura de role/role_permission liberada pra qualquer usuário
--    autenticado nos papéis de sistema (company_id NULL); papéis customizados
--    por empresa (9.2/9.6) só visíveis a quem é membro daquela empresa.
-- ---------------------------------------------------------------------------
ALTER TABLE public.role            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permission ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_select" ON public.role;
CREATE POLICY "role_select"
  ON public.role FOR SELECT
  TO authenticated
  USING (company_id IS NULL OR public.is_company_member(company_id));

DROP POLICY IF EXISTS "role_permission_select" ON public.role_permission;
CREATE POLICY "role_permission_select"
  ON public.role_permission FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.role r
      WHERE r.id = role_permission.role_id
        AND (r.company_id IS NULL OR public.is_company_member(r.company_id))
    )
  );
