-- Correções de segurança apontadas na avaliação externa de 19/10/2026.
-- Todas são defesa em profundidade: nenhuma é explorável pela API de hoje,
-- mas cada uma deixava o RLS (ou o banco) sem a proteção que o README promete.

-- ---------------------------------------------------------------------------
-- 1. users: a policy users_update_self limita a LINHA (id = auth.uid()), não
--    as colunas — qualquer usuário autenticado conseguia trocar o próprio
--    role (ex.: para 'supremo') e is_active direto no PostgREST. O app só
--    altera full_name com a conexão do usuário (AuthService.update_own_profile);
--    o resto passa pela conexão administrativa.
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON public.users FROM anon, authenticated;
GRANT UPDATE (full_name) ON public.users TO authenticated;

COMMENT ON POLICY "users_update_self" ON public.users IS
  'Usuário altera só a própria linha; as colunas ficam limitadas pelo GRANT UPDATE (full_name) de 20261026000002.';

-- ---------------------------------------------------------------------------
-- 2. Partições de activity_log: RLS e GRANT ficaram só no pai (20260723000015).
--    Pelo pai valem as policies dele; pelo nome da partição
--    (activity_log_2026_10 etc.) não havia RLS nenhuma. Habilita RLS (sem
--    policy, nada fica visível) e tira os privilégios de anon/authenticated em
--    cada partição. Consultas pelo pai não mudam: o Postgres checa privilégio
--    e RLS só na tabela citada na consulta. Partições novas não são criadas
--    pelo app (a DEFAULT recebe o que passar de 2028-12); quem criar uma à mão
--    repete estes dois comandos.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  p regclass;
BEGIN
  FOR p IN
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'public.activity_log'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p);
    EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, anon, authenticated', p);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. activity_log_verify_chain:
--    a) é SECURITY DEFINER (ignora o RLS) e recebia qualquer p_company_id —
--       quem chamasse pelo PostgREST via ids e horários de eventos de outras
--       empresas. Agora exige acesso à empresa (user_company_access) ou o papel
--       supremo. Sem claims (conexão interna como postgres, testes) não há
--       auth.uid() e a checagem não se aplica; anon é recusado.
--    b) caminhava a partir do genesis e nunca olhava o fim: apagar o evento
--       mais recente (ou os N últimos) deixava os restantes alcançáveis e
--       válidos, e a tela dizia "íntegra". O último elo gravado
--       (activity_log_chain.last_hash) agora precisa existir entre os eventos;
--       se não existir, volta uma linha sem event_id: "Cadeia truncada".
--    Os nomes de coluna das CTEs (chk_*) evitam colidir com os parâmetros de
--    saída (ok, reason) dentro do PL/pgSQL.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.activity_log_verify_chain(p_company_id uuid)
RETURNS TABLE(event_id uuid, event_created_at timestamptz, ok boolean, reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_key       bytea;
  v_last_hash bytea;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT EXISTS (
         SELECT 1 FROM public.user_company_access uca
         WHERE uca.user_id = auth.uid() AND uca.company_id = p_company_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.users u
         WHERE u.id = auth.uid() AND u.role = 'supremo' AND u.is_active
       )
    THEN
      RAISE EXCEPTION 'Sem acesso à trilha de auditoria desta empresa.' USING ERRCODE = '42501';
    END IF;
  ELSIF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Sem acesso à trilha de auditoria desta empresa.' USING ERRCODE = '42501';
  END IF;

  SELECT key INTO v_key FROM public.activity_log_hmac_key LIMIT 1;
  SELECT c.last_hash INTO v_last_hash FROM public.activity_log_chain c WHERE c.company_id = p_company_id;

  RETURN QUERY
  WITH RECURSIVE
  ev AS (
    SELECT
      al.id, al.created_at, al.prev_hash, al.hash,
      extensions.hmac(
        coalesce(al.prev_hash, '\x00'::bytea) ||
        convert_to((to_jsonb(al) - 'hash' - 'prev_hash')::text, 'utf8'),
        v_key, 'sha256'
      ) AS recomputed
    FROM public.activity_log al
    WHERE al.company_id = p_company_id
  ),
  walk AS (
    SELECT e.id, e.hash, 1 AS pos
    FROM ev e
    WHERE e.prev_hash = '\x00'::bytea
    UNION ALL
    SELECT e.id, e.hash, w.pos + 1
    FROM walk w
    JOIN ev e ON e.prev_hash = w.hash
  ),
  checked AS (
    SELECT
      e.id AS chk_id,
      e.created_at AS chk_created_at,
      (w.id IS NOT NULL AND e.hash = e.recomputed) AS chk_ok,
      CASE
        WHEN w.id IS NULL
          THEN 'Cadeia quebrada: este evento não encadeia com o anterior.'
        WHEN e.hash <> e.recomputed
          THEN 'Evento adulterado: o conteúdo não bate mais com o hash gravado.'
        ELSE NULL
      END AS chk_reason,
      coalesce(w.pos, 2147483647) AS chk_pos
    FROM ev e
    LEFT JOIN walk w ON w.id = e.id
  ),
  tail AS (
    SELECT
      NULL::uuid AS chk_id,
      NULL::timestamptz AS chk_created_at,
      false AS chk_ok,
      'Cadeia truncada: o evento mais recente registrado na cadeia não existe mais.'::text AS chk_reason,
      0 AS chk_pos
    WHERE v_last_hash IS NOT NULL
      AND v_last_hash <> '\x00'::bytea
      AND NOT EXISTS (SELECT 1 FROM ev x WHERE x.hash = v_last_hash)
  )
  SELECT r.chk_id, r.chk_created_at, r.chk_ok, r.chk_reason
  FROM (SELECT * FROM tail UNION ALL SELECT * FROM checked) r
  ORDER BY r.chk_pos, r.chk_created_at, r.chk_id;
END;
$$;

REVOKE ALL ON FUNCTION public.activity_log_verify_chain(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.activity_log_verify_chain(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Rotas públicas de link (/s/{token}/...): usavam a conexão administrativa
--    (postgres, sem RLS, enxergando até a chave HMAC). Agora trocam para este
--    papel (SET ROLE em get_db_share_public, backend/app/dependencies.py), que
--    não faz login e só alcança as colunas que essas rotas leem ou gravam. Um
--    erro de escopo nessas rotas sem autenticação deixa de expor o resto do
--    banco. As policies TO docke_share_public liberam as linhas dessas
--    tabelas (o escopo do link continua sendo checado no backend); as colunas
--    ficam limitadas pelos GRANTs.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'docke_share_public') THEN
    CREATE ROLE docke_share_public NOLOGIN;
  END IF;
END $$;

GRANT docke_share_public TO postgres;
GRANT USAGE ON SCHEMA public TO docke_share_public;

GRANT SELECT (id, resource_type, resource_id, company_id, token_hash, password_hash, expires_at,
              revoked_at, expired_at, pin_to_version_id, created_by, view_count)
  ON public.shares TO docke_share_public;
GRANT UPDATE (view_count, last_accessed_at) ON public.shares TO docke_share_public;
GRANT SELECT (id, folder_id, name, mime_type, size_bytes, storage_path, current_version_id, deleted_at)
  ON public.documents TO docke_share_public;
GRANT SELECT (id, parent_id, name, path, deleted_at) ON public.folders TO docke_share_public;
GRANT SELECT (id, storage_key, mime_type) ON public.document_versions TO docke_share_public;
GRANT INSERT (share_id, ip_hash, user_agent, success) ON public.share_accesses TO docke_share_public;
GRANT SELECT (id, type, resource_id, message, read_at, created_at) ON public.notifications TO docke_share_public;
GRANT INSERT (user_id, company_id, type, resource_type, resource_id, message)
  ON public.notifications TO docke_share_public;
GRANT UPDATE (message, created_at) ON public.notifications TO docke_share_public;

CREATE POLICY "shares_public_link_select" ON public.shares
  FOR SELECT TO docke_share_public USING (true);
CREATE POLICY "shares_public_link_update" ON public.shares
  FOR UPDATE TO docke_share_public USING (true) WITH CHECK (true);
CREATE POLICY "documents_public_link_select" ON public.documents
  FOR SELECT TO docke_share_public USING (true);
CREATE POLICY "folders_public_link_select" ON public.folders
  FOR SELECT TO docke_share_public USING (true);
CREATE POLICY "document_versions_public_link_select" ON public.document_versions
  FOR SELECT TO docke_share_public USING (true);
CREATE POLICY "share_accesses_public_link_insert" ON public.share_accesses
  FOR INSERT TO docke_share_public WITH CHECK (true);
-- Só as notificações de link (acessado/bloqueado) — as demais nem aparecem.
CREATE POLICY "notifications_public_link_select" ON public.notifications
  FOR SELECT TO docke_share_public USING (type IN ('share_accessed', 'share_blocked'));
CREATE POLICY "notifications_public_link_insert" ON public.notifications
  FOR INSERT TO docke_share_public WITH CHECK (type IN ('share_accessed', 'share_blocked'));
CREATE POLICY "notifications_public_link_update" ON public.notifications
  FOR UPDATE TO docke_share_public USING (type = 'share_accessed') WITH CHECK (type = 'share_accessed');
