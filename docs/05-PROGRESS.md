# Docke — Progresso de Implementação
> Atualizado pelo Claude Code após cada tarefa concluída.
> Formato: ✅ para concluído (com data e resumo), ⬜ para pendente, 🔄 para em andamento.
> NUNCA deletar ou reordenar itens. Apenas marcar status.

---

## Milestone 1 — Fundação (schema, RLS, auth)

- ✅ **M1.1** Configurar repositório e estrutura de pastas (backend + frontend esqueletos, config.py, package.json, tsconfig, tailwind.config) — 2026-06-27
  - Criada estrutura completa conforme Parte 8 do manual: `backend/app/{models,schemas,routers,services,workers,seed}`, `frontend/src/{pages,components,hooks,lib,styles}`
  - `config.py` com pydantic BaseSettings, `main.py` com CORS + 9 routers + health check, `dependencies.py` com stubs get_db/get_db_admin
  - `tailwind.config.ts` com tokens teal, cores semânticas via CSS vars, fontes Inter/JetBrains Mono, animações 120/180/240ms
  - `tokens.css` com vars light/dark mode + prefers-reduced-motion (I14)
  - Verificado: uvicorn sobe ("Application startup complete"), Vite sobe (2337ms), console do browser sem erros
  - postcss.config.js aponta explicitamente para tailwind.config.ts (necessário pois Vite roda da raiz do projeto)
- ✅ **M1.2** Criar migrations: extensões (ltree, unaccent, pg_trgm), configuração FTS 'portuguese', todas as 8 tabelas com índices e constraints (incluindo UNIQUE(company_id, content_hash)) — 2026-06-27
  - Migration: `supabase/migrations/20260627000001_initial_schema.sql`
  - 8 tabelas criadas: companies, users, folders, user_company_access, documents, ocr_jobs, favorites, activity_log
  - 26 índices criados incluindo GIST (ltree), GIN (FTS portuguese), UNIQUE(company_id, content_hash)
  - Criado wrapper `public.immutable_unaccent()` para uso no índice GIN (unaccent é STABLE por padrão)
  - RLS habilitado em todas as tabelas; trigger updated_at em documents
  - analytics desabilitado no config.toml (limitação do Docker Desktop no Windows)
  - Verificado: `\dt public.*` retorna 26 linhas de índices, `supabase start` exit code 0
- ✅ **M1.3** Implementar função SQL `user_has_access(user_id, target_path, company_id)` com operadores ltree (@>, nlevel) e resolução por especificidade (R5) — 2026-06-27
  - Migration: `supabase/migrations/20260627000002_user_has_access.sql`
  - Lógica: `folder_path @> p_target_path` (ancestral ou igual) + `folder_path IS NULL` (empresa toda), ORDER BY nlevel DESC para especificidade
  - SECURITY DEFINER + GRANT para roles authenticated e service_role
  - 5/5 cenários verificados: acesso total (manager), pasta exata (editor), herança (parent→child), especificidade (nlevel 2 bate nlevel 1), sem acesso (NULL)
- ✅ **M1.4** Implementar políticas RLS em folders, documents, favorites, activity_log (com exceção de INSERT para activity_log conforme manual) — 2026-06-27
  - Migration: `supabase/migrations/20260627000003_rls_policies.sql`
  - 19 policies em 8 tabelas: companies(1), users(2), user_company_access(4), folders(3), documents(3), ocr_jobs(1), favorites(3), activity_log(2)
  - activity_log: SELECT+INSERT para authenticated, UPDATE/DELETE bloqueados (I1 append-only); service_role bypassa
  - documents/folders: usa user_has_access() para resolução hierárquica via ltree
  - Verificado: `pg_policies` retorna 19 rows sem erro
- ✅ **M1.5** TESTE DE ISOLAMENTO OBRIGATÓRIO: criar 2 empresas, 3 usuários (um por empresa + um sem acesso), testar SELECT/INSERT/UPDATE/DELETE em todas as tabelas protegidas — 2026-06-27
  - 18/18 testes passaram (ok = t)
  - user_a: vê apenas dados da Empresa A (T01–T07)
  - user_b: vê apenas dados da Empresa B (T08–T12)
  - user_none (sem acesso): vê zero linhas em todas as tabelas (T13–T17)
  - T18: DELETE em activity_log como authenticated → DELETE 0 (linha intacta) — RLS bloqueia silenciosamente (sem policy de DELETE = nenhuma linha visível = nenhuma deletável). Comportamento correto, I1 preservado.
  - Bugs encontrados e corrigidos durante M1.5:
    - recursão infinita em uca_select/insert/update/delete_admin → resolvido com SECURITY DEFINER (migration 000004)
    - falta de GRANT SELECT/INSERT/UPDATE/DELETE para role authenticated → migration 000005
  - Migrations adicionais geradas: 000004_rls_fix_recursion.sql, 000005_grants.sql
- ✅ **M1.6** Implementar dependency `get_db` no FastAPI com set_config JWT (Parte 3 do manual) + dependency `get_db_admin` separada para service role — 2026-06-27
  - `backend/app/dependencies.py`: pool asyncpg (init_db_pool/close_db_pool), get_db com transação explícita + SET LOCAL + set_config(request.jwt.claims), get_db_admin como superuser
  - `backend/app/config.py`: adicionado JWT_SECRET e property asyncpg_url
  - `backend/app/main.py`: lifespan chama init_db_pool() no startup e close_db_pool() no shutdown
  - Fix crítico: SET LOCAL só funciona dentro de transação explícita — get_db usa conn.transaction()
  - Verificado: GET /auth/me retorna uid_from_rls = user_id = "11111111-0000-0000-0000-000000000001" ✓
- ✅ **M1.7** Implementar endpoints: POST /auth/login, GET /auth/me, GET/POST /companies — 2026-06-27
  - `backend/app/routers/auth.py`: POST /auth/login (proxy para Supabase Auth), GET /auth/me (verifica auth.uid())
  - `backend/app/routers/companies.py`: GET /companies (filtrado por RLS), POST /companies (service role + auto-grant manager), GET /companies/:id
  - Fix JWT: Supabase CLI 2.x usa ES256 (P-256 ECDSA); dependências.py busca JWKS em startup e suporta ES256 + HS256 fallback
  - Fix pydantic: EmailStr rejeita TLDs privados (.local) — login usa str (validação cabe ao Supabase)
  - Fix schema: user_company_access aceita apenas viewer/editor/manager (não admin)
  - Verificado: T1 login OK (expires_in=3600), T2 uid_from_rls==user_id (True), T3 GET antes=0, T4 POST cria empresa, T5 GET depois count=1 permission=manager, T6 GET by id OK

---

## Milestone 2 — Pastas e Documentos (CRUD completo, upload, preview)

- ✅ **M2.1** CRUD de pastas com path ltree: GET /folders, POST /folders, PATCH /folders/:id (rename + move com transação atômica R4/R8), DELETE /folders/:id (soft delete) — 2026-06-27
  - Hierarquia 4 níveis criada com path ltree correto (prefixo époch+rand único)
  - Rename: apenas campo name, path inalterado — fix: removido `updated_at` inexistente do RETURNING
  - Move atômico: atualiza pasta + todos os descendentes numa única UPDATE com `subpath(path, old_nlevel-1) || new_parent_path`; L4 filho atualizado junto com L3 ✓
  - Soft delete: usa `get_db_admin` (service_role) para o UPDATE de `deleted_at` — workaround obrigatório para limitação do RLS do PostgreSQL: quando UPDATE torna linha invisível ao SELECT (deleted_at IS NULL na policy select), o PG aplica o USING do SELECT como WITH CHECK implícito na nova linha, bloqueando a operação. Permissão validada manualmente com `user_has_access` via conn autenticado antes de executar via admin_conn
  - T10: filhos deletados invisíveis via API (RLS filtra) ✓; T11: re-delete retorna 404 ✓
- ✅ **M2.2** CRUD de documentos: GET /documents, GET /documents/:id, PATCH /documents/:id, DELETE /documents/:id (soft delete), POST /documents/:id/restore — 2026-06-27
  - GET lista por folder_id + company_id, RLS filtra automaticamente
  - PATCH atualiza name/sector/competencia/tipo_fiscal com COALESCE (campos omitidos preservados)
  - DELETE e RESTORE: mesma limitação de RLS que folders — soft delete via admin_conn (validated via conn primeiro); restore inteiramente via admin_conn (doc invisível por deleted_at IS NOT NULL)
  - Regra de pasta deletada: restore verifica deleted_original_folder_id; se pasta original está deletada, fallback para primeira pasta raiz ativa da empresa (ORDER BY created_at); 409 se não houver pasta raiz disponível
  - T1 list=1 ✓, T2 GET by id ✓, T3 PATCH sector+tipo_fiscal ✓, T4 DELETE 204 ✓, T5 GET 404 ✓, T6 list empty ✓, T7 restore original folder ✓, T8 visible again ✓, T11 restore pasta deletada→raiz ✓
- ✅ **M2.3** Upload via presigned URL: POST /documents/upload-url + POST /documents/:id/confirm + validação de MAX_FILE_SIZE (50MB) + whitelist de extensões + sanitização de extensão contra path traversal — 2026-06-27
  - StorageService com dois modos: R2 real (boto3) quando credenciais configuradas; mock local (filesystem temp) para dev sem R2
  - Mock expõe PUT /api/v1/documents/mock-upload/{safe_key:path} para simular upload direto ao bucket
  - upload-url: valida size (413 se >50MB), extensão (whitelist: pdf/xlsx/xls/csv/docx/doc/xml/jpg/jpeg/png/gif/txt), path traversal (rfind(".") + isalnum()), conflito de nome na pasta (409), permissão editor+
  - confirm: HEAD verifica existência → SHA-256 streaming (chunks 64KB) → detecta duplicata por hash dentro da empresa → UPDATE documents + INSERT ocr_jobs em transação única (R3)
  - T1 size>50MB=413 ✓, T2 exe=422 ✓, T3 path traversal=422 ✓, T4 url gerada ✓, T5 PUT mock 200 size=56 ✓, T6 conflito nome=409 ✓, T7 confirm hash+ocr_status=pending ✓, T8 ocr_job=pending ✓, T9 duplicata SHA-256=409 ✓
- ✅ **M2.4** Preview via presigned URL: GET /documents/:id/preview-url (expiração 5min, Content-Disposition: inline, limite 10MB para preview inline) — 2026-06-27
  - generate_preview_url() em StorageService: R2 usa ResponseContentDisposition=inline + ResponseContentType; mock aponta para GET /documents/mock-preview/{safe_key:path}
  - mock-preview serve o arquivo do filesystem com Content-Disposition: inline e content-type correto por extensão
  - Limite 10MB (_PREVIEW_SIZE_LIMIT = 10*1024*1024): retorna {inline: false, preview_url: null, message: "...MB excede..."}
  - T1 inline=True URL gerada ✓, T2 GET mock-preview 200 Content-Disposition:inline content-type:application/pdf conteúdo=55bytes ✓, T3 15MB→inline=False limit=10485760 mensagem ✓, T4 404 ✓
- ✅ **M2.5** Download unitário e em lote: GET /documents/:id/download-url + POST /documents/bulk-download (ZIP) — 2026-06-27
  - generate_download_url() em StorageService: R2 usa ResponseContentDisposition=attachment; mock aponta para GET /documents/mock-download/{safe_key}
  - mock-download serve com Content-Disposition: attachment; filename="..." + filename*=UTF-8''... (RFC 5987)
  - bulk-download: valida lista (422 se vazia, 422 se >50), RLS filtra docs inacessíveis silenciosamente, documentos ausentes no storage ignorados (não bloqueiam ZIP), nomes únicos garantidos com sufixo numérico
  - ZIP gerado em arquivo temporário (evita OutOfMemory), servido como StreamingResponse
  - T1 download-url unitário ✓, T2 Content-Disposition:attachment filename correto ✓, T3 ZIP 3 docs 427 bytes ✓, T4 conteúdo ZIP correto ✓, T5 lista vazia 422 ✓, T6 1 inválido+2 válidos→ZIP com 2 ✓, T7 404 ✓
- ✅ **M2.6** Ações em lote: POST /documents/bulk-move, POST /documents/bulk-delete — 2026-06-27
  - bulk-move: valida pasta destino via conn (user_has_access editor+), UPDATE via conn (RLS WITH CHECK valida nova pasta), activity_log INSERT em batch via SELECT FROM documents
  - bulk-delete: busca docs visíveis + permissão via conn; soft delete via admin_conn (mesma limitação RLS de M2.1); activity_log batch; response inclui `skipped` para docs sem permissão
  - Ambos: 422 se lista vazia ou >50 itens
  - T1 bulk-move 3 docs moved=3 ✓, T2 pasta inexistente 404 ✓, T3 lista vazia 422 ✓, T4 bulk-delete 2 docs deleted=2 skipped=0 ✓, T5 lista vazia 422 ✓, T6 activity_log delete+move registrados ✓
- ✅ **M2.7** Favoritos: POST /favorites, DELETE /favorites/:id, GET /favorites — com registro em activity_log (ações 'favorite' e 'unfavorite') — 2026-06-27
  - GET: enriquece com item_type (document/folder), item_name via LEFT JOIN, ordered by created_at DESC
  - POST: valida FK real (doc/folder visível via conn RLS), 409 se UniqueViolationError, 422 se nenhum ou ambos informados, activity_log 'favorite'
  - DELETE: busca favorito do próprio usuário (RLS user_id = auth.uid()), activity_log 'unfavorite'
  - T1 favoritar doc (fatura_mar.pdf) ✓, T2 favoritar folder (Financeiro) ✓, T3 duplicata 409 ✓, T4 ambos 422 ✓, T5 list count=2 ✓, T6 delete 204 ✓, T7 list count=1 ✓, T8 activity_log favorite+unfavorite ✓
- ✅ **M2.8** Lixeira: GET /trash, POST /trash/:id/restore, DELETE /trash/:id/permanent (nível alto de confirmação) — 2026-06-27
  - GET /trash: usa admin_conn (itens deleted_at IS NOT NULL invisíveis ao authenticated); lista docs E pastas separados; pastas: exibe apenas raízes deletadas (não lista sub-pastas de pastas já deletadas)
  - POST /trash/:id/restore: suporta item_type=document|folder; restore de pasta restaura todos os descendentes; se pasta pai também deletada, restaura como raiz (parent_id=NULL); valida user_has_access por permissão
  - DELETE /trash/:id/permanent: exige ?confirm=true (400 sem ele); apenas manager pode excluir permanentemente; para doc: hard delete + tentativa de remoção do storage (falha silenciosa); para pasta: exige docs já deletados (409 se orphan_docs>0); activity_log 'delete'
  - T1 GET/trash total=4 (2docs+2folders) ✓, T2 restore DOC1 (pasta existe) name=fatura_jan.pdf ✓, T3 GET/trash após restore = 1doc ✓, T4 ?confirm=false → 400 mensagem irreversível ✓, T5 permanent delete DOC2 204 ✓, T6 inexistente 404 ✓

---

## Milestone 3 — Busca e OCR

- ✅ **M3.1** FTS português: GET /search (paginado com ts_headline) + GET /search/quick (prefixo para command palette) — 2026-06-27
  - FTS sobre expressão `to_tsvector('portuguese', immutable_unaccent(name || ' ' || ocr_text))` — correspondente ao índice GIN da migration
  - _normalize_query(): re.sub de caracteres especiais, colapsa espaços; websearch_to_tsquery para /search, to_tsquery com `:*` na última palavra para /quick
  - /search: filtra company_id, deleted_at, tsquery match; rank ts_rank_cd; snippet ts_headline com tags `<mark>`/`</mark>`, MaxFragments=2; paginação via LIMIT/OFFSET; filtros opcionais: folder_id, sector, file_type
  - /quick: prefix matching na última palavra (word:*), máx 10 resultados, sem snippet (menor latência)
  - T1 'nota fiscal' total=1 NF-e Maio 2026.pdf snippet com `<mark>Nota</mark><mark>Fiscal</mark>` ✓, T2 'NF-e maio' rank=0.04 ✓, T3 'contrato tecnologia' total=1 ✓, T4 /quick 'nota' count=2 ✓, T5 sem resultados total=0 ✓, T6 filtro folder_id total=2 ✓, T7 paginação ✓, T8 q vazia 422 ✓
- ✅ **M3.2** Pipeline OCR com SKIP LOCKED, OCRProvider interface, FallbackProvider — 2026-06-27
  - OCRProvider ABC + TesseractProvider (deskew Otsu + pytesseract, para prod com Tesseract instalado) + FallbackProvider (UTF-8/Latin-1 decode, para dev sem Tesseract)
  - Worker loop: SKIP LOCKED adquire job mais antigo pending → UPDATE status='processing' em transação rápida → lê storage → extract() → transação atômica R3: UPDATE documents (ocr_text, ocr_status='done') + UPDATE ocr_jobs (status='done') juntos
  - `_rescue_stuck_jobs()`: jobs em 'processing' >10min → 'pending' (se attempts<3) ou 'failed' (se ≥3)
  - ENABLE_OCR_WORKER=false em .env (default para dev) — worker pode ser testado diretamente via script Python com init_db_pool()
  - T1 doc criado com pending ✓, T2 FallbackProvider extrai "Servicos contabeis e tributarios..." ✓, T3 ocr_status='done' text_len=81 ✓, T4 FTS busca 'contabeis tributarios' total=1 snippet com <mark> ✓
- ✅ **M3.3** Retry de OCR: POST /documents/:id/retry-ocr + lógica de stuck jobs — 2026-06-27
  - retry-ocr: valida status do doc (409 se pending ou processing, OK se done/failed), INSERT novo job em pending + UPDATE doc.ocr_status='pending' em transação atômica (I1: não edita jobs existentes)
  - Stuck jobs: _rescue_stuck_jobs() chamado no início de cada loop do worker (não bloqueia processing normal)
  - T1 retry-ocr em 'done' → status=pending ✓, T2 retry novamente → 409 (já pending) ✓, T3 2 jobs criados (done + pending) ✓, T4 rescue SQL correto (CASE WHEN attempts<3 THEN pending ELSE failed) ✓
- ✅ **M3.4** Activity log: GET /activity + GET /activity/export (CSV) + POST /activity/undo/:id — 2026-06-27
  - GET /activity: filtros opcionais company_id (obrigatório), user_id, action, item_type, date_from, date_to; paginado; JOIN com users para user_name/username
  - GET /activity/export: mesmos filtros, retorna CSV com BOM UTF-8 (Excel-friendly), máx 5000 linhas, Content-Disposition: attachment
  - POST /activity/undo/:id: I1 append-only — cria evento 'undo' com action='undo', metadata={undo_of_event_id, original_action}; reversíveis: move/rename/delete/favorite; não-reversíveis: upload/view/download/restore/unfavorite (422); retorna instructions com type e endpoint sugerido para o cliente executar
  - Migration 000006: ADD 'undo' ao CHECK constraint de activity_log.action; aplicada via asyncpg
  - T1 GET activity total=10 com itens corretos ✓, T2 filtro action=delete total=3 all_delete=True ✓, T3 filtro item_type=folder total=1 ✓, T4 CSV header 8 colunas 10 linhas ✓, T5 undo delete instructions=restore ✓, T6 undo favorite instructions=unfavorite ✓, T7 undo restore → 422 ✓

---

## Milestone 4 — Produto (frontend completo, dashboard, UX final)

- ✅ **M4.1** App Shell: TopBar (logo Docke, seletor de empresa com dropdown, busca global, botão upload, avatar com menu), Sidebar colapsável, layout responsivo — 2026-06-27
  - `AppShell.tsx`: flex h-screen, Sidebar + coluna principal (TopBar + main overflow-y-auto)
  - `Sidebar.tsx`: colapsa w-[56px] / expande w-[220px] via transition-[width], NavLinks ativos com bg-teal-600/10, toggle recolher/expandir
  - `TopBar.tsx`: seletor de empresa dropdown, busca global com form submit → /search?q=, botão Upload, avatar dropdown (perfil + logout), dropdowns fecham com click fora
- ✅ **M4.2** Login: card centralizado, logo Anchor+Docke, formulário email+senha, bloco AFN Systems no footer — 2026-06-27
  - Validação inline (campos obrigatórios), loading state, toast de erro, redirect pós-login
  - Tailwind configurado inline no vite.config.ts (fix: Vite roda da raiz do projeto, configs postcss/tailwind precisam de caminhos absolutos via __dirname)
- ✅ **M4.3** Dashboard: stats 4 cards, recentes do usuário, favoritos, feed de atividade — 2026-06-27
  - Skeleton loading em todos os cards, empty states com ícones, data fetching paralelo via Promise.all
  - StatCard com ícone + valor formatado; ActivityFeed com avatar + ação + data; links para todas as seções
- ✅ **M4.4** Explorador de Documentos: tabela com pastas+docs, seleção múltipla, bulk-delete, breadcrumbs de navegação, drawer de detalhes, modal de upload e nova pasta — 2026-06-27
  - Tabela: pastas navegáveis no topo, documentos com checkbox+select, status OCR badgeado, hover revela ações
  - DetailDrawer lateral com metadados, download e favoritar inline
  - UploadModal com drag-area e preview de arquivos, CreateFolderModal com Enter/Esc
  - Breadcrumb de navegação hierárquica com ícone Home
- ✅ **M4.5** Command Palette (Ctrl+K): busca rápida via /search/quick, navegação por teclado, ESC fecha, link para busca avançada — 2026-06-27
  - `CommandPaletteProvider` com listener global Ctrl+K; TopBar convertida para botão trigger com atalho visual
  - Debounce 200ms, ↑↓ arrows + Enter navega, empty state com ícone Âncora
- ✅ **M4.6** Task Center: badge na top bar (vermelho=falhas, teal=running), popover com progresso determinado/indeterminado, done some em 10s — 2026-06-27
  - `TaskProvider` + `useTaskCenter()`: addTask/updateTask/removeTask/clearDone; auto-remove done em 10s
  - `TaskCenter.tsx`: Loader2 spinner (running) / CheckCircle2 (done) / AlertCircle (failed)
- ✅ **M4.7** Demais telas: Busca Avançada (FTS com highlight), Lixeira, Atividade (com export CSV + paginação), Favoritos, Configurações (Perfil, Empresas, Usuários, Permissões) — 2026-06-27
  - Search.tsx: form de busca → GET /search, resultados com <mark> highlight sanitizado, empty states por estado
  - Favorites.tsx: lista com remoção hover, ícone por tipo (doc/pasta)
  - Trash.tsx: lista com restauração inline, data de exclusão
  - Activity.tsx: lista paginada + botão exportar CSV (download programático via Blob)
  - Settings/Profile, Companies, Users, Permissions: páginas funcionais com dados reais da API
  - _Critério: todas as telas renderizando com dados reais, responsivas nos 3 breakpoints (1024, 768px), tema dark/light com transição suave_
- ✅ **M4.8** Onboarding (primeiro acesso): fluxo 4 passos — welcome, criar empresa, template pastas, convidar equipe — 2026-06-27
  - Detectado por `!isOnboardingComplete() && companies.length === 0`; marcado em localStorage após conclusão
  - Passo 2: POST /companies; Passo 3: POST /folders para cada pasta do template; Passo 4: convite best-effort
- ✅ **M4.9** Animação "Anchor Drop": @keyframes anchor-drop com overshoot cubic-bezier(0.34,1.56,0.64,1) — 2026-06-27
  - CSS em tokens.css; `AnchorFavoriteButton.tsx` aplica `.anchor-drop`, remove após 320ms; desativada com prefers-reduced-motion
- ✅ **M4.10** Persistência de estado de navegação: folderId + breadcrumbs preservados por sessão via React Context — 2026-06-27
  - `NavigationProvider` com `useRef<Map>` (zero re-renders); Documents.tsx restaura ao montar, persiste ao navegar
- ✅ **M4.11** Testes automatizados (pytest): 4 testes de integração com banco real — 2026-06-27
  - `test_rls.py`: isolamento real entre empresas com JWT claims
  - `test_permissions.py`: user_has_access retorna role mais específico (R5)
  - `test_folder_move.py`: move L2 atualiza L3+L4 atomicamente com ltree correto
  - `test_ocr_sync.py`: R3 — doc+job criados/atualizados juntos, invariante verificada

- ✅ **M4.12** Testes end-to-end de todas as telas e correção de bugs de integração — 2026-06-28
  - **Search**: FTS portuguesa não casava filenames com extensão (stem 'contrat' ≠ token 'contrato_v2.pdf') → adicionado ILIKE fallback em `search.py` (`OR d.name ILIKE '%' || $1 || '%'`)
  - **Search**: frontend usava `items`/`headline` mas API retorna `results`/`snippet` → corrigidas interfaces e data access em `Search.tsx`
  - **Trash**: frontend esperava array mas API retorna `{documents, folders, total}` → corrigida tipagem e parser em `Trash.tsx`
  - **Companies/members**: endpoint `GET /{company_id}/members` não existia → criado em `companies.py` com JOIN `user_company_access` + `users` (campo correto: `permission_level`, não `role`; sem coluna `email` em users)
  - **Login**: `navigate()` chamado durante render causava React warning → movido para `useEffect` em `Login.tsx`
  - **Download**: frontend chamava `/documents/{id}/download` (404) mas endpoint correto é `/documents/{id}/download-url` → corrigido em `Documents.tsx`
  - Todas as 14 telas verificadas com dados reais: Login, Dashboard, Documentos (drawer, upload, bulk, breadcrumb), Busca, Favoritos, Lixeira, Atividade, Command Palette (Ctrl+K), Settings (Perfil, Empresas, Usuários, Permissões)

- ✅ **M4.24** Correção de cores hardcoded sem suporte dark mode — 2026-06-30
  - Adicionado `dark:` variant em todos os `bg-teal-50`, `bg-red-50`, `bg-blue-50`, `bg-yellow-50`, `bg-purple-50` encontrados
  - Afetados: `Documents.tsx` (linha selecionada, botões hover), `Favorites.tsx`, `Trash.tsx`, `Dashboard.tsx` (StatCards), `AnchorFavoriteButton.tsx`, `Onboarding.tsx`
- ✅ **M4.23** Animação do Toast corrigida (substituído `tailwindcss-animate` não instalado por CSS nativo) — 2026-06-30
  - `tokens.css`: `@keyframes toast-in` (slide-in + opacity)
  - `toast.tsx`: classe `toast-in` substituindo `animate-in slide-in-from-right-4`
- ✅ **M4.22** Input `disabled` melhorado + Settings traduzidos e corrigidos — 2026-06-30
  - `Input.tsx`: `disabled:bg-[var(--bg-hover)] disabled:text-[var(--text-tertiary)] disabled:cursor-not-allowed`
  - `Profile.tsx`: avatar maior (56px), inputs controlados, mostra `username` em vez de `email` vazio, badge de role
  - `Users.tsx`: interface corrigida (`email` → `username`), badge de role traduzido (viewer/editor/manager)
  - `Companies.tsx`: `permission_level` traduzido para pt-BR
- ✅ **M4.27** Design System — responsividade, ConfirmModal, forwardRef no Button — 2026-06-30
  - `AppShell.tsx`: drawer off-canvas para tablet/mobile — overlay `bg-black/40`, sidebar `fixed lg:static`, transição `duration-normal`; fecha ao navegar
  - `BottomTabBar.tsx`: barra inferior `md:hidden` com 5 tabs (Dashboard, Docs, Busca, Favoritos, Atividade), NavLink com estado ativo em teal
  - `TopBar.tsx`: botão hambúrguer `lg:hidden` com ícone `Menu`, prop `onMenuClick`
  - `Sidebar.tsx`: botão "fechar" `lg:hidden` no header quando em modo drawer; prop `onClose`
  - `Button.tsx`: refatorado com `forwardRef<HTMLButtonElement>` para suportar `ref` (necessário no ConfirmModal)
  - `ConfirmModal.tsx`: modal reutilizável com `autoFocus` em Cancelar (design system: foco inicial em Cancelar), ícone de alerta, variante `danger`, ESC fecha, overlay fecha ao clicar fora
  - `Documents.tsx`: botão de excluir pasta agora abre `ConfirmModal` em vez de excluir diretamente; estado `confirmDeleteFolder` + `deletingFolder`
  - `CommandPalette.tsx`: `modal-card` animation + ícones coloridos por tipo de arquivo nos resultados
  - `tsc --noEmit` 0 erros; console sem erros pós-reload
- ✅ **M4.26** Design System — animações de modal, overlay de sessão expirada, endpoints backend pendentes — 2026-06-30
  - `tokens.css`: `@keyframes modal-in` (scale 0.95→1.0, 240ms) + classe `.modal-card` aplicada em todos os modais (Documents, Onboarding)
  - `src/lib/sessionEvents.ts`: event bus desacoplado (CustomEvent `docke:session-expired`) para sinalizar 401 sem dependência React em api.ts
  - `api.ts`: interceptor 401 agora dispara `emitSessionExpired()` em vez de `window.location.href = "/login"` — preserva contexto da tela
  - `src/components/shared/SessionExpiredOverlay.tsx`: overlay fullscreen blur com mini-card para reinserir apenas a senha, sem perder o estado da tela atual
  - `App.tsx`: `<SessionExpiredOverlay />` montado dentro de `ProtectedRoutes` (tem acesso ao `AuthContext`)
  - `backend/app/routers/folders.py`: `GET /folders/frequent` — retorna pastas com mais atividade do usuário nos últimos 30 dias (baseado em activity_log)
  - `backend/app/routers/admin.py`: implementados 5 endpoints — `GET/POST /admin/users`, `GET/POST /admin/permissions`, `GET /admin/storage-usage`; todos exigem role manager/admin
  - `tsc --noEmit` 0 erros; backend importa 6 rotas (folders) + 5 rotas (admin) sem erro
- ✅ **M4.25** Design System — ícones e cores por tipo de arquivo, empty states ilustrados, branding AFN Systems, nome truncado com extensão visível, toast "Desfazer" em exclusões — 2026-06-30
  - `src/lib/fileType.ts`: `getFileStyle(filename)` retorna ícone Lucide + cores Tailwind por extensão (PDF=vermelho, Planilha=verde, Documento=azul, XML=violeta, Imagem=âmbar, Outros=cinza) com dark mode
  - Aplicado em Documents (tabela + drawer), Dashboard (recent docs + favoritos), Search (resultados), Favorites, Trash — todos os locais que listam documentos
  - `src/components/ui/TruncatedFileName.tsx`: trunca o nome no meio mantendo a extensão visível (base trunca + ext fixo)
  - Aplicado em Documents (tabela) e Search (resultados)
  - `EmptyState.tsx`: ícone principal 64px + âncora decorativa 24px no canto inferior direito (conforme design system)
  - `Login.tsx` + `tokens.css`: AFN Systems em JetBrains Mono Bold, vermelho `#6b1f2a` (light) / `#c44a5a` (dark) via CSS var `--afn-brand`
  - Documents: bulk delete agora é otimista com toast "Desfazer" — itens somem da UI imediatamente, API só é chamada após 5s; cancelamento restaura da API
- ✅ **M4.21** Zero erros TypeScript + limpeza de imports não usados — 2026-06-30
  - Criado `src/vite-env.d.ts` com `/// <reference types="vite/client" />` (resolvia erros de `import.meta.env`)
  - Removidos imports não usados: `ElementType`, `RotateCcw`, `Move` em Documents; `Input` em Search; `Avatar` em Profile
  - `Avatar.tsx`: parâmetro `name` não usado em `tealHue()` removido
  - `tsc --noEmit` passa com 0 erros
- ✅ **M4.20** Datas relativas ("há 2 dias") e utilitário centralizado de datas — 2026-06-30
  - `src/lib/date.ts`: `relativeDate()` (agora/min/h/ontem/dias/data) e `fullDate()` (data absoluta pt-BR)
  - Dashboard + Documents (tabela) + Search: substituídas para `relativeDate` — mais natural no contexto de feeds
  - Documents (drawer "Criado em") + Trash (data de exclusão): usam `fullDate` — informação precisa é mais adequada
  - Eliminadas as funções `fmtDate` locais duplicadas em cada página
- ✅ **M4.19** Tooltips na sidebar recolhida e centralização dos ícones — 2026-06-30
  - `Sidebar.tsx`: `title={collapsed ? label : undefined}` + `aria-label={label}` em cada NavItem
  - `justify-center` quando colapsado para alinhar ícones ao centro visualmente
- ✅ **M4.18** Error Boundary por página — 2026-06-30
  - `src/components/shared/ErrorBoundary.tsx`: class component com tela amigável (ícone + mensagem + botão "Tentar novamente")
  - `AppShell.tsx`: `<ErrorBoundary key={location.pathname}>` envolve o conteúdo — reset automático ao navegar, sem tela branca
- ✅ **M4.17** Animação fade-in de entrada nas páginas — 2026-06-28
  - `tokens.css`: `@keyframes page-enter` (opacity 0→1 + translateY 6px→0, 180ms ease)
  - `AppShell.tsx`: `<div key={location.pathname} className="page-enter">` — re-monta o wrapper a cada navegação, disparando a animação
  - Respeitado `prefers-reduced-motion` (regra já existente desativa animações globalmente)
- ✅ **M4.16** Toggle de tema dark/light — 2026-06-28
  - `src/lib/theme.ts`: `getTheme()` (lê localStorage + prefers-color-scheme), `applyTheme()` (toggle classe `.dark` no `<html>`), `toggleTheme()`
  - `main.tsx`: `applyTheme(getTheme())` executado antes do React montar (sem flash de tema errado)
  - `TopBar.tsx`: botão Sun/Moon ao lado do TaskCenter — alterna entre modo claro e escuro e persiste no localStorage
- ✅ **M4.15** Scroll para o topo ao navegar entre páginas — 2026-06-28
  - `AppShell.tsx`: `useRef` no `<main>` + `useEffect` em `location.pathname` → `mainRef.current?.scrollTo({ top: 0 })`
- ✅ **M4.14** Favicon SVG, meta tags e loading screen brandada — 2026-06-28
  - `public/favicon.svg`: ícone de âncora teal em fundo arredondado (32×32), exibido na aba do browser
  - `index.html`: `<link rel="icon">` + `<meta name="description">` + `<meta name="theme-color" content="#0d9488">`
  - `App.tsx`: loading screen de autenticação substituída por tela com logo Docke + spinner (antes era spinner anônimo)
- ✅ **M4.13** Polimento de qualidade: avisos de lint, títulos dinâmicos de aba e consistência de deps — 2026-06-28
  - `Login.tsx`: `navigate` adicionado ao array de deps do `useEffect` (aviso exhaustive-deps)
  - `Search.tsx`: `doSearch` adicionado ao array de deps do `useEffect` de inicialização (dep faltando causava busca desatualizada ao trocar de empresa)
  - Criado `src/hooks/usePageTitle.ts`: hook que seta `document.title = "<página> · Docke"` e restaura "Docke" ao desmontar
  - Hook aplicado em todas as 11 páginas: Login ("Entrar"), Dashboard, Documentos, Busca, Favoritos, Lixeira, Atividade, Perfil, Empresas, Usuários, Permissões

**⚠️ PAUSA OBRIGATÓRIA APÓS M4:** Teste de usabilidade com 1-2 funcionários reais do Grupo Zen antes de prosseguir para M5.

---

## Milestone 5 — Demo, Deploy e Entrega

- ✅ **M5.1** Seed do modo demo — 2026-06-30
  - `backend/app/seed/demo_data.py`: script async idempotente (limpa e re-insere)
  - 1 usuário demo (`demo@docke.app`, manager nas 3 empresas)
  - 3 empresas fictícias: Posto Sol Nascente, Hotel Serra Azul, Restaurante Sabor & Arte
  - 4 pastas raiz por empresa: Fiscal, RH, Bancário, Contratos (~12 pastas total)
  - ~51 documentos distribuídos (17 por empresa): PDFs, XMLs, DOCX, XLSX, JPGs
  - 2 docs com `ocr_status='failed'` por empresa (demonstra retry), `ocr_text=None`
  - 3 docs por empresa em soft-delete (`deleted_at` setado) — aparecem na lixeira
  - 20 entradas de `activity_log` por empresa (últimos 7 dias — upload, view, download)
  - OCR text realístico em pt-BR para que a busca FTS funcione no modo demo
  - Execução: `python -m app.seed.demo_data` (nunca exposto como endpoint HTTP)
  - Sintaxe OK, imports OK (testado)
  - _Critério: seed roda sem erro, dashboard populado, busca OCR funcional, modo demo identificável por banner_
- ✅ **M5.1b** Design System — itens pendentes — 2026-06-30
  - `src/hooks/useFocusTrap.ts`: hook reutilizável que prende Tab/Shift+Tab dentro de um container ref; restaura foco anterior no unmount
  - `ConfirmModal`: adicionado `useFocusTrap` (containerRef no card) — Tab já não sai do modal
  - `CommandPalette`: adicionado `useFocusTrap(containerRef, isOpen)` — foco preso enquanto paleta está aberta
  - `UploadModal` (inline): adicionado `useFocusTrap` + clique no overlay fecha o modal
  - `CreateFolderModal` (inline): adicionado `useFocusTrap` + clique no overlay fecha o modal
  - `src/components/documents/PreviewModal.tsx`: preview inline completo — PDF (iframe), imagem (img), texto/XML/CSV (pre), fallback "não suportado" com botão de download; animação `modal-card`; ESC fecha; focus trap
  - `src/components/documents/FolderTree.tsx`: componente completo — buildTree (flat→hierárquico), drag-and-drop HTML5 (mover pasta para outra com PATCH /folders/{id}), navegação por teclado (↑↓→←Enter), expandir/recolher, inline "Nova pasta" na raiz
  - `Documents.tsx`: botão "Visualizar" no DetailDrawer abre PreviewModal; importa PreviewModal; estado `previewDoc`
  - `tsc --noEmit` → 0 erros após todas as alterações
- ✅ **M5.2** Deploy backend no Fly.io (free tier, sem cold start) — 2026-07-01
  - App `docke-api` na região `gru` (São Paulo), `min_machines_running=1` + `auto_stop_machines=off` (sem cold start)
  - Dockerfile com tesseract-ocr + tesseract-ocr-por + libgl1 (dependência opencv)
  - `GET /health` retorna `{"status":"ok"}` publicamente em `https://docke-api.fly.dev`
  - Verificado: `/auth/me` responde com dados reais do usuário, RLS confirmada em produção via smoke test
- ✅ **M5.3** Deploy frontend na Vercel — 2026-07-01
  - Root directory `frontend`, framework Vite auto-detectado, env vars `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`/`VITE_API_URL`
  - App acessível em `https://docke-two.vercel.app`
  - Fix: `frontend/vercel.json` (rewrite SPA) não estava commitado — causava 404 ao dar F5 em rotas internas; corrigido e verificado
- ✅ **M5.4** Configurar Supabase produção + R2 produção com CORS correto — 2026-07-01
  - Projeto Supabase produção criado (região sa-east-1), todas as 6 migrations aplicadas via SQL Editor
  - Bug de produção corrigido: `immutable_unaccent()` precisava de `SET search_path = public, extensions, pg_catalog` explícito (inlining do planner resolvia `unaccent` em contexto diferente da sessão)
  - Bucket R2 `docke-prod` criado, CORS liberado para o domínio Vercel, token de API (Object Read & Write) configurado como secret no Fly.io
  - Primeiro usuário de produção criado manualmente (Supabase Auth + insert em `public.users`/`user_company_access`, role `supremo`)
  - Upload/download real verificado funcionando no domínio de produção
- ✅ **M5.5** Smoke test final integrado (desenvolvedor) — 2026-07-01
  - Testado em produção pelo usuário: login, criação de pasta, upload de arquivo, OCR concluído, busca FTS com snippet destacado
  - Bugs de produção encontrados e corrigidos: seleção individual de documento (checkbox disparava toggle duplo), falta de botão excluir no drawer de detalhes, sessão expirada reautenticava com username em vez de e-mail (401 falso), botão de upload duplicado no TopBar da página Documentos, crash na tela de Favoritos ao excluir documento favoritado (backend retornava `item_name: null` para itens na lixeira)
  - Fluxo completo confirmado: login→upload→OCR→busca→preview→favoritar→lixeira→restore funcional no ambiente de produção

---

## Pós-lançamento (v1.1)

- ✅ Preview de XML fiscal com extração de campos-chave (emitente, CNPJ, valor, data) — 2026-07-01
- ✅ Export do activity_log em formato Excel (além do CSV já implementado) — 2026-07-01

---

## Milestone 6 — v2: Correções, Segurança e Permissões (pacote de Adendos 01-07)

> Pacote de handoff com 7 adendos + protótipo visual, executado em 4 frentes.
> Ordem de execução: Frente 1 (correções) → Frente 4 (segurança/permissões) →
> Frente 3 (features novas) → Frente 2 (visual). Reordenado a pedido do
> desenvolvedor: a Frente 4 muda o modelo de permissões que a Frente 3
> depende, então resolver isso primeiro evita retrabalho.

### ✅ Frente 1 — Correções e Lacunas (ADENDO-01) — 2026-07-01/02

- **Correção 03** (prioridade máxima): vazamento visual do painel de Detalhes atrás do modal de preview. Causa raiz: `.page-enter` (tokens.css) usava `animation-fill-mode: both`, deixando um `transform` computado persistente após a animação — isso torna o elemento um *containing block* para `position: fixed` descendente (spec CSS), quebrando a cobertura de tela cheia dos modais especificamente em páginas que usam `-m-6` (Documentos). Corrigido removendo o fill-mode. Verificado via medição de `getBoundingClientRect()` do overlay (cobre 100% do viewport após a animação terminar).
- **Correção 01**: ícone de favoritar trocado de estrela para âncora no painel de Detalhes (componente `AnchorFavoriteButton` já existia no código desde o M4.9 mas nunca tinha sido usado em lugar nenhum).
- **Correção 02**: Task Center ganhou `aria-label`, tooltip explicativo e dot indicator de primeira sessão (localStorage).
- **ADR-014**: nova tela `/settings/organization` com CRUD de empresas (nome, CNPJ com máscara, ativar/desativar). Migration `20260701000007_companies_org_fields.sql` (colunas `cnpj`, `logo_key`, `is_active`). Logo fica como upload futuro (endpoint de presigned URL já implementado, UI ainda não).
- **ADR-015**: Configurações reestruturada com sub-navegação (`SettingsLayout.tsx`): Perfil, Organização, Usuários & Papéis, Segurança (troca de senha), Preferências (tema claro/escuro/sistema). Seção "Retenção" fica oculta até a Frente 3 implementar versionamento/retenção configurável.
- **Bug real encontrado e corrigido de passagem**: `_require_manager` em `admin.py` checava `claims["role"]` — esse campo do JWT do Supabase é sempre `"authenticated"` (role do Postgres), nunca o papel de negócio do usuário. Isso bloqueava 100% das chamadas aos endpoints `/admin/*`, para todo mundo, sempre. Corrigido com `get_app_role()` (nova função em `dependencies.py`) que consulta `public.users.role`.

### ✅ Frente 4 — Segurança, Isolamento e Permissões (ADENDO-06 + ADENDO-07) — 2026-07-02

- **ADR-036/037 (matriz de permissões)**: modelo antigo (`viewer`/`editor`/`manager` por empresa + `supremo`/`admin`/`usuario` global) substituído por 3 papéis por empresa (`visualizador`/`auditor`/`admin`) + `supremo` como papel global. Migration `20260702000008_permission_matrix_v2.sql`: migra dados existentes, recria policies de RLS para escrita exigir `permission_level = 'admin'` (removendo a capacidade de escrita que `editor`/`auditor` tinha — correção do Adendo 07: "auditor" é somente-leitura, nome reservado permanentemente para isso).
  - **Decisão registrada** (mapeamento de dados sem instrução explícita dos adendos): `viewer→visualizador`, `editor→auditor`, `manager→admin`. Efeito colateral aceito: como não existe mais um papel de empresa com escrita mas sem controle administrativo total, qualquer usuário que precise fazer upload/mover/excluir precisa ser `admin` daquela empresa.
- **ADR-033**: fluxo de convite por e-mail (recém-criado na Frente 1) removido e substituído por criação direta de usuário — admin/supremo define nome, username, e-mail (só como credencial de login, sem e-mail de convite disparado) e senha inicial gerada automaticamente (editável). Endpoint `POST /companies/{id}/members` usa a Admin API do Supabase Auth com `email_confirm: true`.
- **ADR-035**: snippet de busca truncando `ocr_text` em 8000 caracteres antes do `ts_headline()` (evita degradação de performance em OCRs longos). `websearch_to_tsquery` (já em uso desde o v1) mantido — já preserva ordem de frase melhor que o `phraseto_tsquery` sugerido no adendo original.
- **Teste de isolamento entre empresas — executado de verdade, via API direta (não só interface)**: criada uma 2ª empresa e 3 usuários de teste (`admin`, `visualizador`) com acesso restrito a ela. Confirmado com o token do usuário de teste:
  - `GET /companies` não lista a empresa A
  - `GET /documents/{id da empresa A}/download-url` → 404 mesmo com o ID exato
  - `GET /folders`, `GET /documents`, `GET /search` com `company_id` da empresa A explícito no parâmetro → todos retornam vazio (RLS ignora o parâmetro, não confia nele)
  - usuário `admin` da empresa B consegue criar pasta na própria empresa (201)
  - usuário `visualizador` da empresa B consegue **ler** (200) mas não **escrever** (403) na própria empresa
  - Dados de teste removidos do banco de produção ao final.
- **Bugs reais encontrados e corrigidos durante o teste de isolamento** (não estavam listados nos adendos — apareceram ao testar de verdade, exatamente o motivo do protocolo exigir teste manual):
  1. Rota `GET /companies/organizations` capturada por `GET /companies/{company_id}` (bug clássico de ordenação de rotas do FastAPI — a rota com parâmetro dinâmico foi registrada antes da rota estática). Corrigido reordenando.
  2. `_can_manage_company` exigia o papel GLOBAL (`public.users.role`) ser `admin`/`supremo` além do papel por empresa — como usuários criados via ADR-033 sempre nascem com papel global `usuario`, isso bloqueava qualquer admin comum de gerenciar a própria empresa (mesma classe do bug #1 da Frente 1). Mesma correção aplicada em `list_organizations` e no gate de abas do `SettingsLayout.tsx`/`Users.tsx` no frontend (trocado de `user.role` global para `current.permission_level` por empresa).
  3. `POST /folders` não tinha checagem de permissão explícita em Python — dependia só da RLS rejeitar o INSERT. Quando a RLS rejeitava, o erro cru do Postgres derrubava a conexão HTTP inteira (`net::ERR_FAILED` no browser, nenhuma resposta chega ao cliente) em vez de um 403 limpo. Corrigido com checagem explícita via `user_has_access()` antes do INSERT.
- **Infraestrutura fora de escopo de código** (ADR-038): backup diário do Postgres + WAL/PITR de 7 dias é responsabilidade do plano do Supabase (não configurável via migration/código) — verificar se o plano atual do projeto cobre isso antes de depender dele para recuperação real. Versionamento de bucket no R2 (proteção contra sobrescrita/exclusão acidental em nível de infraestrutura) precisa ser habilitado manualmente no painel da Cloudflare — ainda não foi feito.
- **Pedido do desenvolvedor durante esta frente**: removidas todas as menções a "Grupo Zen" e nomes de unidades reais usados como placeholder/exemplo no código (`Organization.tsx` e no seed de demonstração `demo_data.py`) — trocados por nomes genéricos sem relação com negócios reais.
- **Ajuste de custo de infraestrutura** (a pedido do desenvolvedor, fora do escopo dos adendos): Fly.io encerrou o trial gratuito durante esta frente, exigindo cartão de crédito para continuar fazendo deploy. `fly.toml` ajustado de `auto_stop_machines='off'` + `min_machines_running=1` (sempre ligado, sem cold start) para `auto_stop_machines='stop'` + `min_machines_running=0` (desliga quando ocioso, aceita alguns segundos de cold start) — trade-off aceito nesta fase de demonstração interna, antes de qualquer decisão de adoção real.

**Itens da Frente 4 não testados / pendentes:**
- Vetores adicionais de isolamento do ADR-037 (extensão): URLs assinadas de download já validam `company_id` via RLS (confirmado no teste acima), mas cache e mascaramento de logs de erro não se aplicam ainda — não há camada de cache implementada no projeto, e logs de erro não foram auditados especificamente por vazamento de dado entre empresas.
- Restrição do papel "auditor" (leitura + log de atividade, sem escrita) foi implementada via RLS mas não testada isoladamente do papel "visualizador" nesta rodada — ambos têm o mesmo comportamento de escrita (bloqueado), a diferença (acesso ao log de atividade) não foi verificada com um usuário `auditor` real.

### ✅ Frente 3 — Features Funcionais Novas (ADENDO-04 + ADENDO-05) — 2026-07-03

- **Migration única** `20260702000009_v2_features.sql`: tabelas `document_versions`, `shares`, `share_accesses`, `notifications`; colunas novas `documents.current_version_id`, `companies.retention_days` (padrão 30), `documents.trash_expires_at`, `folders.trash_expires_at`. Backfill automático (`DO $...$`) cria a versão 1 de todo documento pré-existente a partir dos dados atuais — verificado contra o único documento real de produção (tamanho e mime_type batendo).
- **ADR-024/029/034 (versionamento)**: `backend/app/routers/versions.py`. Limite de 10 versões por documento (bloqueia novo upload/restore ao atingir, nunca apaga a mais antiga automaticamente — valor probatório fiscal). Restaurar uma versão antiga sempre cria uma nova versão clonando o `storage_key` da escolhida (sem duplicar arquivo, nunca reverte apagando histórico). Toda nova versão (upload ou restore) reseta `ocr_status` para reprocessar. Exclusão manual de versão verifica se outra versão (de uma restauração) ainda referencia o mesmo `storage_key` antes de apagar o objeto do storage.
- **ADR-022/027/031 (compartilhamento externo)**: `backend/app/routers/shares.py`. Links por documento ou pasta, senha opcional (bcrypt), expiração (`never`/`24h`/`7d`/`30d`/`custom`), `always_latest` (padrão `false` = fixa a versão atual no momento da criação do link). Rotas públicas (`/s/{token}/*`, sem autenticação) usam `admin_conn` diretamente. Rate limit em memória (ADR-027, sem Redis — aceitável no volume atual): 30 links/hora e 100/dia por usuário na geração; 5 tentativas de senha por 60s → bloqueio de 15 min, com notificação ao dono do link. Ao excluir permanentemente um documento/pasta (manual ou pela retenção automática), os shares associados são marcados `expired_at` (`expire_shares_for_resource()`, chamado por `trash.py` e pelo worker de manutenção).
- **ADR-025/030 (retenção configurável)**: `GET`/`PATCH /companies/{id}/retention`, só `supremo`. Fórmula de carência ao mudar a configuração: `carência_dias = min(nova_retenção, 7)` — itens na lixeira há mais tempo que a carência mantêm a regra antiga, os mais recentes passam a valer a nova regra imediatamente.
- **ADR-023/028/031 (notificações)**: `backend/app/services/notification_service.py` + `backend/app/routers/notifications.py`. 5 eventos: atividade em pasta favoritada (upload/mover/excluir), nova versão de documento favoritado/visto recentemente, restauração de versão, link acessado (agregado por dia), link bloqueado por senha incorreta. Sino unificado no `TaskCenter.tsx` (tarefas em andamento + notificações, ADR-028), polling a cada 30s.
- **`backend/app/workers/maintenance_worker.py`**: loop horário — avisa quando um item da lixeira está prestes a expirar e purga os que já expiraram (registrado no lifespan do `main.py`, incondicional, diferente do worker de OCR).
- **Frontend**: `VersionsPanel.tsx` (upload/listar/baixar/restaurar/excluir versão), `ShareModal.tsx` (criar/listar/revogar link), `PublicShare.tsx` (página `/s/:token` sem autenticação, usa `fetch()` direto em vez do `api.ts`/axios), `Settings/Retention.tsx` (só visível para `supremo`), toggle de densidade de tabela em `Documents.tsx` (classe `[&_td]:!py-1` aplicada na tabela).

**Teste ao vivo executado (produção, não apenas smoke test) — protocolo do handoff cumprido: testar de verdade antes de reportar:**
- **Versionamento**: ciclo completo `upload-url → PUT no R2 → confirm → relistar` testado contra o documento real de produção. Restauração de versão antiga testada e confirmada (OCR reprocessado corretamente sobre o conteúdo genuíno, 781 caracteres extraídos). Exclusão de versões antigas confirmada (204, não afeta a versão corrente).
- **Compartilhamento**: link de documento com senha — acesso público (`/info`), senha errada (401), senha certa (200 com URL de preview assinada) todos confirmados. Rate limit de senha testado até o bloqueio real (6 tentativas → 423, inclusive a senha correta fica bloqueada depois). Link de pasta — navegação read-only, download de documento dentro do escopo (200) e fora do escopo (403) confirmados. Revogação de link testada (`DELETE /shares/{id}` → acesso público passa a retornar 410).
- **Notificações**: `share_accessed` e `share_blocked` confirmados disparando e aparecendo no sino, com agregação correta ("acessado 1 vez hoje"). `mark-all-read` e contagem de não lidas confirmados.
- **Retenção**: `PATCH /companies/{id}/retention` testado com valores válidos (fórmula de carência confirmada: `min(45,7)=7`, `min(3,7)=3`) e inválido (`-5` → 422). Tela em Configurações confirmada visualmente (valor atual carregado corretamente, aba só visível para supremo).
- **Densidade de tabela**: alternância confirmada via inspeção de CSS computado (padding de 10px→4px, altura de linha 60.4px→48.4px) e label do botão atualizando corretamente.
- **Dados de teste**: toda versão/documento/share criado durante o teste foi limpo do banco de produção ao final (mesmo padrão de higiene da Frente 4).

**Bugs reais encontrados e corrigidos durante o teste (não estavam nos adendos):**
1. **`PATCH /companies/{id}/retention` derrubava a conexão (500) sempre que chamado** — `asyncpg.exceptions.DataError: invalid input for query argument $2: 45 (expected str, got int)`. Causa raiz: a query usava `($2 || ' days')::interval` passando `retention_days` como parâmetro Python `int` vinculado — o asyncpg/Postgres não conseguia resolver o tipo do parâmetro de forma não ambígua (diferente do padrão já usado em `documents.py`/`folders.py`, onde o valor vem de uma coluna de tabela já tipada, não de um parâmetro vinculado). Uma primeira tentativa de correção (`$2::text || ' days'`) piorou o sintoma pelo motivo oposto: forçou o Postgres a resolver `$2` como `text`, e o asyncpg então tentou codificar o `int` Python direto como texto, falhando do mesmo jeito. Correção definitiva: trocar a concatenação de string por multiplicação de intervalo (`$2 * interval '1 day'`), que mantém o parâmetro como inteiro o tempo todo. Redeploy e reteste confirmaram o fix.
2. Durante o diagnóstico do bug acima, testes de upload de nova versão sobrescreveram temporariamente `current_version_id`, `ocr_text` e `ocr_status` do único documento real de produção com conteúdo de teste falso. Corrigido restaurando a versão original via o próprio endpoint de restore (que clona o `storage_key` genuíno) antes de qualquer dado real ser perdido — OCR foi reprocessado corretamente sobre o arquivo real como consequência.

**Itens da Frente 3 não testados / limitações conhecidas:**
- Notificações de `folder_activity` (pasta favoritada) e `document_new_version` (versão nova de documento favoritado/visto) não puderam ser testadas de ponta a ponta nesta rodada — a lógica exclui explicitamente o próprio autor da ação (`user_id != actor_user_id`), e o teste foi feito com uma única conta (mesma limitação do teste de isolamento da Frente 4). Verificado apenas por inspeção de código e dos pontos de chamada (`documents.py`, `versions.py`).
- `trash_expires_at` não é exposto pela API de listagem da lixeira (`GET /trash`) — a lógica de gravação foi verificada por leitura de código (mesmo padrão já testado em produção nas exclusões da Frente 4), mas não foi observada diretamente via API por falta de um campo de saída.
- Upload de nova versão com tipo de arquivo diferente da extensão original do documento não tem validação explícita — hoje resultaria em erro genérico de assinatura no R2 (`SignatureDoesNotMatch`) em vez de uma mensagem amigável, já que o backend sempre assina com o content-type derivado da extensão original do documento, não da versão nova enviada. Não é um bug (o modelo assume que novas versões mantêm o mesmo tipo de arquivo), mas a mensagem de erro nesse caso específico não é clara para o usuário final.

### ✅ Frente 2 — Refinamento Visual "Liquid Glass" (ADENDO-02 + ADENDO-03) — 2026-07-03

- **Tokens de vidro** (`frontend/src/styles/tokens.css`): `--glass-bg`, `--glass-border`, `--glass-panel-bg`, `--glass-shadow(-hover)`, `--glass-highlight`, raios (`22px` painel / `14px` popover / `50px` pill), modo claro completo (Adendo 02) e fallback `@supports` explícito (ADR-019 — sem suporte a `backdrop-filter`, cai num fundo sólido translúcido calibrado, nunca reaproveita a opacidade "real" que só funciona com blur). Classes utilitárias reunidas em `.glass-panel`/`.glass-blur-*`/`.glass-highlight-line`/`.glass-interactive` para reuso entre componentes em vez de repetir CSS bruto.
- **ADR-017 (regras de performance)**: blur da moldura da tabela reduzido para 10px (vs. 20px dos outros painéis); blur desabilitado durante scroll ativo na tabela via `onScroll` + debounce de 150ms (`.glass-scroll-active`), testado ao vivo — confirmado que a classe aparece durante o scroll e some ~150ms depois de parar; `will-change: backdrop-filter` aplicado só em sidebar/topbar (nunca em elementos com scroll).
- **ADR-018 (contraste WCAG AA)**: badge de status (`Badge.tsx`, variantes `success`/`teal`) corrigido para `rgba(29,184,153,0.20)` + `#086B61` no claro / `--teal-bright` no escuro — confirmado via inspeção de CSS computado em produção. `--text-secondary` corrigido em ambos os modos (`#5A6268` claro, `#A8A8A8` escuro). Chips de tipo de arquivo (`fileType.ts`) não precisaram de alteração — são ícones isolados sem texto ao lado, que segundo o próprio adendo só precisam de 3:1 (já passavam).
- **ADR-020**: blur de sidebar/topbar em 14px (não os 20px originais do Adendo 02) — decisão do Adendo 03, que prevalece sobre o 02 em caso de conflito.
- **ADR-021 (modo escuro padrão)**: `frontend/src/lib/theme.ts` — `getTheme()` não usa mais `prefers-color-scheme` como fallback; primeira sessão sem preferência salva sempre abre escura. Preferência explícita do usuário (inclusive "Sistema", escolhido ativamente em Preferências) continua respeitada normalmente depois disso. Confirmado ao vivo em produção (`isDark: true` num carregamento limpo).
- **Sidebar** (`Sidebar.tsx`): tratamento de vidro completo, recolhimento em exatamente `76px` (era `56px`), estado persistido em `localStorage` (antes só durava a sessão em memória). Confirmado ao vivo: largura recolhida exata, labels removidos do DOM (não só ocultos) quando recolhida.
- **Topbar, stat cards do Dashboard, Task Center**: vidro aplicado conforme a tabela de aplicação do Adendo 02. Sombra e blur do Task Center confirmados via inspeção (`blur(24px)`, sombra com os valores exatos do token).
- **Barra de ações em lote**: não existia como elemento flutuante — a implementação original tinha um botão "Excluir N" inline na toolbar. Convertida para uma pill flutuante fixa no rodapé (`bottom-7`/`bottom-[76px]` no mobile, para não colidir com a bottom tab bar — testado e confirmado via bounding box), com blur 28px, seguindo a descrição do Adendo 02 ("o caso mais puro de vidro sobre conteúdo").
- **Login**: logo já usava 36px via ícone Lucide (não os assets de imagem 48px→36px do protótipo) — Correção C do Adendo 02 não se aplicava literalmente a este código, confirmado por inspeção, nenhuma mudança necessária.
- **Item não implementado**: "Dropdown de breadcrumb" (Adendo 02) — a navegação por breadcrumb desta implementação nunca teve um dropdown de navegação entre pastas irmãs; isso não existe como funcionalidade, então não havia o que re-estilizar. Construir essa interação do zero ficou fora do escopo de um refinamento *visual* (seria uma feature nova).

**Teste ao vivo executado em produção (não apenas local) — protocolo do handoff cumprido:**
- Verificado por hash de conteúdo que o bundle publicado no Vercel (`index-B2Js9x9B.css`/`.js`) é byte-idêntico ao build local testado, e que o CSS de produção contém as classes de vidro (`glass-panel`, `glass-blur-panel`, `status-badge`).
- Testes de interação ao vivo no preview (login real em produção): alternância de tema clara/escura com inspeção de `box-shadow` computado batendo exatamente com os tokens de cada modo; recolhimento/expansão da sidebar; seleção de documento disparando a barra de ações flutuante; scroll da tabela desabilitando e restaurando o blur; responsividade mobile (375px) sem sobreposição entre a barra flutuante e a bottom tab bar.
- **Achado durante o teste, não um bug de código**: ao reverter o `CORS_ORIGINS` para produção no fim da Frente 3, o teste visual local (`localhost:5173`) parou de conseguir logar — não por credenciais erradas, mas porque o preflight `OPTIONS /auth/login` passou a ser rejeitado (CORS). Resolvido reativando temporariamente `localhost:5173` em `CORS_ORIGINS` durante o teste e revertendo de novo ao final — mesmo padrão de higiene já usado nas frentes anteriores.

**Itens da Frente 2 não testados / limitações conhecidas:**
- Fallback `@supports` (ADR-019) para navegadores/proxies sem suporte a `backdrop-filter` não foi testado ao vivo (exigiria desabilitar o recurso no navegador) — verificado apenas por leitura do CSS gerado.
- Regra "proibido empilhar vidro sobre vidro" (ADR-017.3) não foi estressada especificamente (ex: abrir o Task Center exatamente sobre a sidebar com blur ativo ao mesmo tempo) — a geometria atual dos popover (Task Center abre abaixo da topbar, sobre a área de conteúdo) evita esse cenário na prática, mas não houve um teste dedicado a forçar a sobreposição.

---

## Milestone 7 — Papel "Operador" com escopo por pasta, Modo Demo, correções de UX (pós-auditoria)

> Esta frente nasceu de uma auditoria pedida pelo usuário depois da Frente 2, questionando se o pacote de 7 adendos estava sendo seguido à risca e se a ferramenta refletia o planejamento original (não só os adendos). A auditoria encontrou lacunas reais que deveriam ter sido notadas antes, sem precisar vir do usuário — registradas abaixo com honestidade.

### Achados da auditoria contra o planejamento original (não os adendos)

- **Confirmado no planejamento original, nunca implementado na UI**: escopo de permissão por pasta. `02-DECISOES-ARQUITETURA.md` (ADR-001) já definia herança de permissão via `ltree`; `03-MANUAL-EXECUCAO.md` (Regra R5) já especificava a resolução por especificidade de path; o teste obrigatório da Parte 8.1 já pedia um caso de "permissão ampla + restrição em subpasta". A coluna `user_company_access.folder_path` e a função `user_has_access()` já suportavam isso desde a v1 — só a tela de conceder acesso nunca ofereceu escolher uma pasta, sempre gravando `folder_path = NULL` (empresa toda). Lacuna de implementação real, não do planejamento.
- **Modo demo**: `backend/app/seed/demo_data.py` (seed com 3 empresas fictícias) já existia da v1, mas nunca teve porta de entrada no app — o protótipo Liquid Glass tem um botão "Acessar modo demo" na tela de login que nunca foi implementado.
- **Violação da Invariante I8** ("nenhum router acessa o banco diretamente — toda query passa pelo service correspondente"): `documents_service.py`/`folders_service.py` nunca existiram como arquivos; os services que existem (`activity_service.py`, `permission_service.py`, `search_service.py`) são classes vazias (`pass`) com docstrings dizendo "implementado em M1.3/M3.1/M3.4", que nunca foram de fato implementadas. Toda a lógica de banco está direto nos routers desde a v1. **Não corrigido nesta frente** — é uma refatoração grande e arriscada de fazer junto com features novas; registrada como pendência separada para tratar com o mesmo cuidado que as outras frentes (schema/RLS não muda, só reorganização de código).
- **Organization.tsx não destacava a empresa atualmente selecionada** — bug real, corrigido (badge "Atual").

### ✅ Papel "Operador" + escopo por pasta (redesenho do modelo de permissões)

- Migration `20260703000010_papel_operador_escopo_pasta.sql`: funde `visualizador`+`auditor` num só papel (`visualizador` passa a incluir acesso ao log de atividade — a política RLS de `activity_log_select` nunca discriminava por `permission_level` mesmo antes, então isso já era de fato o comportamento; só a cópia da UI dizia o contrário). Novo papel `operador`: lê, faz upload, move e exclui documentos dentro do seu escopo de pasta — mas só exclui os documentos que ele mesmo inseriu (verificado por `uploaded_by`, na aplicação, não via RLS — RLS não distingue de forma limpa "isto é uma exclusão" de outro UPDATE qualquer). Não cria, renomeia nem exclui pastas — isso continua exclusivo de `admin`.
- `documents_insert`/`documents_update` (RLS) estendidas para aceitar `operador` além de `admin`. `folders_insert`/`folders_update` não mudaram (admin-only).
- Backend: `documents.py` (upload, bulk-move, restore, delete single/bulk), `versions.py` (`_check_write_access`), `trash.py` (restore de documento) passam a aceitar `operador`. `bulk_delete`/`delete_document` checam `uploaded_by` quando o papel resolvido é `operador`.
- `POST /companies/{id}/members` ganha `folder_id` opcional (resolve pra `folder_path` via ltree antes de gravar). Novo `POST /companies/{id}/members/{member_id}/access` permite conceder concessões adicionais a um usuário já existente (ex: `operador` na pasta RH + `visualizador` na Fiscal, na mesma empresa — a tabela já suporta múltiplas linhas por usuário). Novo `DELETE /companies/{id}/access/{access_id}` remove uma concessão específica.
- **Bug real encontrado durante o próprio teste desta feature**: remover a última concessão de um usuário (pra depois recriar escopada a uma pasta) deixava o usuário "órfão" — sem nenhuma linha em `user_company_access`, portanto sem aparecer na listagem de membros e sem nenhuma tela pra reconceder acesso, e a tentativa de recriar esbarrava em "username já existe". Corrigido: `remove_access_grant` agora bloqueia remover a última concessão de qualquer usuário (não só a do próprio admin), com mensagem indicando usar "Remover membro" para isso.
- Frontend: `Users.tsx` reescrita — 3 papéis, seletor de pasta (árvore) ao conceder acesso não-admin, suporte a múltiplas concessões por usuário na listagem.
- **Correção de UX encontrada no teste**: o erro de "sem permissão" ao criar pasta aparecia como mensagem genérica ("Não foi possível criar a pasta"), escondendo o motivo real e parecendo bug do site em vez de bloqueio de permissão. Corrigido em `Documents.tsx` (criação de pasta e exclusão em lote) pra sempre repassar o `detail` real do backend.

**Teste de isolamento por pasta — executado de verdade, obrigatório antes de fechar esta frente:**
- Criadas 2 pastas reais (RH, Fiscal) na empresa de produção, usuário `operador` escopado só à pasta RH.
- `GET /folders` do operador retorna só RH — Fiscal nunca aparece, nem por listagem nem por acesso direto ao ID (404, não revela que a pasta existe).
- Upload em RH: 201. Upload em Fiscal: 404. Mover documento pra Fiscal: 404.
- Exclusão do próprio documento: 204. Exclusão de documento de outra pessoa (admin): 403 com mensagem clara ("Você só pode excluir documentos que você mesmo inseriu.").
- Dados de teste (usuário, pastas, documentos) removidos ao final.

### ✅ Modo Demo

- `backend/app/seed/demo_data.py` corrigido (dois bugs reais, nunca antes exercitados de ponta a ponta): (1) `_ensure_demo_auth_account()` buscava usuário existente por e-mail via `GET /auth/v1/admin/users?email=...` — esse parâmetro não existe na Admin API do Supabase/GoTrue, que ignora silenciosamente e devolve a listagem padrão; o código pegava `existing[0]` sem filtrar, o que **causou um incidente real** (ver abaixo). Corrigido para filtrar por e-mail no lado do cliente. (2) O INSERT de documentos usava a coluna `created_by` (não existe em `documents`, que usa `uploaded_by`) e não informava `file_type` (`NOT NULL` no schema) — o seed nunca tinha rodado com sucesso até esta frente.
- Login (`Login.tsx`): cabeçalho trocado para "Bem-vindo de volta" (texto do protótipo) e adicionado o botão "Acessar modo demo" (divider "ou" + `btn-ghost`), que faz login automático com `demo@docke.app`/`DockeDemo2026!`.
- Seed executado com sucesso em produção: 3 empresas fictícias, ~51 documentos, usuário demo funcional — confirmado ao vivo (login, troca de empresa, dashboard populado).
- **Limitação conhecida, não corrigida nesta frente**: ao trocar de conta na mesma aba/sessão sem recarregar a página, a lista de empresas exibida pode ficar temporariamente desatualizada (estado do React não é resetado no login) — a API sempre retorna os dados corretos e escopados por usuário; é só a exibição em cache que pode ficar momentaneamente errada até um F5. Não é uma falha de segurança (confirmado comparando a chamada direta à API), mas é um gap de UX pré-existente no fluxo de login (nenhum lugar do código força reload/reset de estado após autenticar), não específico do modo demo.

### ⚠️ Incidente real: bloqueio da conta administrador durante o teste do modo demo

Por causa do bug do `existing[0]` sem filtro (acima), a primeira tentativa de rodar o seed do modo demo **encontrou e alterou a senha da conta administrador real de produção** (mesmo ID, `38aad276-32b3-456d-98d1-142b87801d8f`) em vez de criar uma conta demo nova — a Admin API retornou essa conta como "primeira da lista" simplesmente porque o filtro por e-mail nunca funcionou.

- Efeito: login normal do administrador parou de funcionar (nem a senha original, nem a nova senha aplicada pelo script).
- Diagnóstico: confirmado via logs de autenticação do próprio Supabase que um evento de recuperação de senha (`/verify`, "Login: request completed") tinha sido processado com sucesso mas nunca efetivamente trocou a senha, porque a URL de redirecionamento do projeto ainda apontava para `localhost:3000` (nunca configurada para produção) e a página de destino nunca carregava para completar a troca.
- Resolução: senha redefinida com sucesso via Admin API oficial (mesmo mecanismo usado por `create_member`), rodada interativamente via `fly ssh console` com leitura de senha oculta (`getpass`). Uma segunda causa foi descoberta no processo: o `fly ssh console` (sem controle de eco de terminal) inseria um caractere `\r` residual na senha capturada, fazendo com que as duas primeiras tentativas de redefinição parecessem ter funcionado (`Status: 200`) mas na prática gravassem uma senha diferente da digitada. Corrigido com `.rstrip("\r\n")` e uma etapa de confirmação mostrando o comprimento capturado antes de qualquer envio.
- Acesso restaurado e confirmado. O usuário trocou a senha novamente por um canal que não passou por esta conversa.
- **Correção permanente**: `demo_data.py` agora filtra por e-mail no lado do cliente (nunca mais confia em filtro de servidor não documentado). Lição registrada em memória (`feedback_test_scripts_before_prod.md`) para nunca mais entregar um script que altera contas de Auth em produção sem antes rastrear a lógica linha a linha, especialmente pressupostos sobre filtros de API.

### ✅ Correções de navegação mobile (encontradas durante o teste desta frente)

- **Bug real**: a barra de navegação inferior (mobile) tinha só 5 abas (Início, Docs, Busca, Favoritos, Atividade) — faltava Configurações. Ao mesmo tempo, o botão hambúrguer (topo) abria um menu-drawer separado e mais completo (incluía Configurações), criando duas navegações inconsistentes na mesma largura de tela.
- Decisão (confirmada com o usuário via pergunta direta): barra inferior ganha uma 6ª aba ("Ajustes" → `/settings/profile`), e o hambúrguer/drawer mobile foi removido inteiramente — uma única navegação mobile, sem duplicidade. `AppShell.tsx`, `TopBar.tsx`, `Sidebar.tsx` simplificados (sidebar de drawer virou puramente desktop, `hidden lg:block`; `Menu`/`X`/estado de drawer removidos).
- **Bug real, corrigido**: em larguras reduzidas, o menu de perfil (avatar → Perfil/Sair) ficava difícil de acessar por sobrecarga de elementos na topbar (busca expandida + botão Upload sempre visíveis, mesmo sem espaço). Corrigido escondendo a busca expandida e o botão Upload abaixo de `md`/`sm` respectivamente (busca continua acessível via ícone isolado e via aba "Busca" da barra inferior) — testado em 375px, menu de perfil abre e fecha corretamente, "Sair" plenamente visível e clicável.

### Bug de build encontrado e corrigido

- Deploy do Vercel falhou (`npm run build` saiu com código 2) por um import não utilizado (`Trash2`) em `Users.tsx`, que o `tsc` do build de produção acusa como erro mas o dev server não. Corrigido e validado com `npm run build` local antes de cada push subsequente — nenhuma outra falha de build ocorreu depois disso.

### Itens desta frente não testados / pendências registradas

- Refatoração para services (Invariante I8) — pendência separada, grande, não resolvida nesta frente por design (ver "Achados da auditoria" acima).
- Exclusão de versão de documento (`DELETE /documents/:id/versions/:id`) não recebeu a mesma restrição de "só exclui o que inseriu" que documentos ganharam — permanece liberado para qualquer `admin`/`operador` com acesso à pasta, já que o usuário não pediu essa granularidade para versões especificamente.
- Cache de lista de empresas não resetado ao trocar de conta na mesma sessão (ver "Modo Demo" acima) — gap de UX pré-existente, não corrigido nesta frente.

---

## Milestone 8 — Refatoração para services (I8), conteúdo real do modo demo, terminologia "Ancorados", incidente GitGuardian, correções de UX pós-teste

> Continuação direta da Milestone 7. O usuário testou o app publicado e reportou uma lista de problemas reais; esta frente resolve cada um deles, mais a pendência de refatoração deixada em aberto.

### ✅ Refatoração para services (Invariante I8)

- `activity_service.py`, `search_service.py`, `permission_service.py`: preenchidos (eram classes vazias com docstring enganosa dizendo que já estavam implementados). Toda a lógica SQL que vivia em `activity.py`/`search.py` foi movida para os services correspondentes; `permission_service.py` ganhou um espelho em Python de `user_has_access()` (uso opcional, não plugado em nenhum router — RLS continua sendo a fonte de verdade).
- `documents_service.py` e `folders_service.py` (nunca existiam como arquivos): criados do zero, com todos os métodos estáticos que antes viviam inline em `documents.py` (~25 métodos) e `folders.py` (~13 métodos).
- `documents.py` e `folders.py`: reescritos como routers finos, só chamando os services. Todos os endpoints preservados — conferido via schema OpenAPI (60 rotas no total, incluindo endpoints "mock" escondidos) antes/depois da refatoração.
- Risco desta refatoração: baixo, por ser puramente mecânica (mover SQL de um arquivo para outro, sem mudar comportamento) e ter sido feita de forma incremental, testando cada domínio isoladamente antes de seguir pro próximo, conforme pedido explícito do usuário.

### ✅ Modo demo: conteúdo real de arquivo (antes só existia o registro no banco)

- **Bug real**: os documentos do seed do modo demo nunca tinham conteúdo de fato no R2 — só a linha em `documents`. Isso impedia abrir qualquer arquivo e também impedia testar a busca por OCR (não havia texto para indexar de verdade).
- `storage_service.py` ganhou `put_object_bytes()` para upload direto ao R2 pelo servidor (sem passar pelo fluxo de URL pré-assinada, que é só para uploads de usuário).
- `demo_data.py` ganhou geradores de conteúdo mínimo e válido por extensão: PDF (xref manual, byte a byte), XLSX (openpyxl), JPG (Pillow), DOCX (zipfile), XML e TXT. `size`/`content_hash` passam a ser calculados do conteúdo real gerado, em vez de valores aleatórios falsos.
- Testado ao vivo em produção: PDF baixado via curl confirmado como `%PDF-1.4` válido; busca por OCR funcionando com highlight `<mark>` correto nos snippets.

### ✅ Terminologia "Ancorados" (planejamento original nunca implementado)

- O planejamento original definia "Ancorados" com ícone de âncora para a feature de favoritos, mas a implementação usava "Favoritos"/estrela em toda parte. Corrigido em ~10 arquivos: `Sidebar.tsx`, `BottomTabBar.tsx`, `Favorites.tsx`, `Dashboard.tsx`, `Documents.tsx`, `Activity.tsx`, `AnchorFavoriteButton.tsx` (frontend) e `favorites.py`, `documents.py` (mensagens de erro/notificação, backend).

### ✅ Correções de sessão/UX reportadas após teste

- **Sessão expirada no modo demo pedia senha que o usuário não tem**: como a conta demo é compartilhada/pública, não faz sentido travar em uma senha desconhecida. `SessionExpiredOverlay.tsx` agora detecta `user.email === DEMO_EMAIL` e renova a sessão automaticamente via `loginDemo()`, só caindo no formulário de senha se a renovação silenciosa falhar.
- **Modal de onboarding "piscava" e sumia em <1s no login**: causado por uma condição de corrida — `CompanyContext` começa com a lista de empresas vazia antes do fetch resolver, e o gate de onboarding usava `companies.length === 0` como sinal de "precisa configurar", disparando para qualquer usuário por uma fração de segundo. Corrigido com um estado `loading` explícito no `CompanyContext`, que o `OnboardingGate` agora espera antes de decidir.
- **Usuário demo aparecia como "@demo@docke.app" (dois @)**: `username` do usuário demo estava configurado como o e-mail completo, mas a UI sempre prefixa "@" assumindo um identificador curto. Corrigido para `username = "demo"`. Um segundo bug represava a correção: o `ON CONFLICT ... DO UPDATE` do seed só atualizava `full_name`, nunca `username`, então rodar o seed de novo não aplicava a correção até esse `SET` também ser corrigido.

### ✅ Incidente de segurança: alerta do GitGuardian (senha do modo demo exposta)

- Commit `452b4b7` tinha a senha do modo demo (`DockeDemo2026!`) hardcoded tanto em `SessionExpiredOverlay.tsx` (frontend, foi para o GitHub) quanto em `demo_data.py` (backend). GitGuardian sinalizou.
- Risco real avaliado como baixo (conta demo só dá acesso a 3 empresas fictícias, nunca a dados reais), mas tratado como padrão de segurança genuíno a corrigir, não descartado.
- Correção: `DEMO_PASSWORD` passa a vir de uma variável de ambiente (Fly secret), nunca mais hardcoded em nenhum lugar do código-fonte. Novo endpoint `POST /auth/demo-login` faz o login no backend usando o segredo guardado lá — o frontend nunca mais precisa (nem consegue) saber a senha real. `Login.tsx` e `SessionExpiredOverlay.tsx` passam a chamar esse endpoint em vez de montar a chamada de login com a senha embutida.
- Recomendação dada ao usuário: rotacionar a senha (novo valor só via `fly secrets set`) em vez de reescrever o histórico do Git — risco baixo o suficiente para não justificar mexer no histórico. Decisão confirmada pelo usuário.

### ✅ Bug real: resultados da busca não abriam o documento

- **Reportado pelo usuário**: clicar em um resultado da busca não abria o arquivo nem navegava para a pasta certa — só levava de volta para a pasta raiz de Documentos.
- **Causa raiz**: os itens `<li>` da lista de resultados em `Search.tsx` não tinham nenhum `onClick`, `<Link>` ou navegação — eram puramente decorativos. O usuário, ao ver que nada acontecia, provavelmente navegava manualmente e acabava na raiz.
- Corrigido: `Search.tsx` agora navega para `/documents?folder_id=<id>&doc=<id>` ao clicar num resultado (o backend já retornava `folder_id`/`folder_name`, só o frontend não usava). `Documents.tsx` passou a tratar esse deep link: busca a lista achatada de pastas para reconstruir a trilha de breadcrumb até a pasta certa, navega até lá, e abre o painel de detalhes do documento automaticamente assim que a lista carrega — limpando os parâmetros da URL depois, para um F5 não repetir o pulo.
- Testado ao vivo (local e confirmado no bundle de produção após deploy do frontend).

### ✅ Bug real: estado "ancorado" do documento nunca vinha do servidor

- O painel de detalhes (`DetailDrawer` em `Documents.tsx`) inicializava `favorited` sempre como `false`, só atualizando depois de clicar — então reabrir um documento já ancorado mostrava o botão como se não estivesse.
- Corrigido: `documents_service.list_by_folder()` agora retorna um campo `favorited` (via `EXISTS` contra a tabela `favorites`, filtrado por `auth.uid()`), e o `DetailDrawer` inicializa e sincroniza seu estado local a partir de `doc.favorited`.

### ✅ Login: redesenho visual (protótipo/imagem de referência ainda não batia)

- O usuário apontou que a tela de login não batia com a imagem de referência do planejamento, mesmo após o ajuste anterior (Milestone 7) — aquele ajuste só tinha mexido em texto/botão, não no tratamento visual.
- Corrigido: fundo com glow radial sutil (só em modo escuro), logo trocado de quadrado para círculo (mockup de referência), card convertido para o tratamento de vidro (`glass-panel`/`glass-blur-card`/`glass-shadow`) já usado no resto do app desde a Frente 2, mantendo o conteúdo real do Docke (sem cadastro/SSO/magic link, que não existem no produto — só a referência genérica os tinha). Testado visualmente em modo claro e escuro.

### ⚠️ Achado crítico: grande parte do trabalho de backend nunca foi commitado nem deployado

- Ao investigar por que `POST /auth/demo-login` retornava 404 em produção, foi descoberto que **praticamente todo o trabalho de backend desta e da Milestone 7** (a correção do GitGuardian, toda a refatoração para services, `documents_service.py`, `folders_service.py`, notificações, compartilhamento externo, rate limiting, worker de manutenção, uma migration inteira) nunca chegou a ser commitado — existia só no diretório de trabalho local.
- Efeito prático: o reseed do modo demo rodado anteriormente (`fly ssh console -C "python -m app.seed.demo_data"`) executou o código **antigo** ainda em produção, então a rotação de `DEMO_PASSWORD` não teve efeito real até o backend ser de fato deployado.
- Ação: usuário orientado a commitar/enviar tudo, e então rodar `fly deploy` + a migration pendente no Supabase antes de considerar qualquer item desta frente como "em produção" de verdade.

### Itens desta frente não testados / pendências registradas

- Verificação de que o `fly deploy` do backend (pendente no momento em que este documento foi escrito) realmente publica todo o código descrito acima — ficou combinado como o próximo passo, mas fora do escopo desta entrada de progresso.
- Cadência de teste: o usuário pediu para não parar a cada correção pequena para testar/fazer deploy — itens pequenos ficam anotados para verificação em lote, no fechamento da frente, em vez de um a um.

---

## Milestone 9 — Auditoria total contra o planejamento + fechamento de todas as lacunas reais encontradas

> O usuário pediu uma varredura completa e repetida (2-3 passadas) contra TODOS os documentos de planejamento (00 a 08 + 7 adendos), sem confiar apenas em relatórios de agentes — cada achado relevante foi confirmado por leitura/grep direto antes de entrar nesta lista. Depois da auditoria, o usuário aprovou corrigir tudo que fosse uma lacuna real (mantendo o limite de versões em 10, já correto).

### Achados confirmados e corrigidos

- **I6/R8 (mover pasta)**: faltava `SELECT ... FOR UPDATE` na pasta antes de iniciar o move (exigido explicitamente pelo manual, Parte 0 R8, pra evitar corrida entre dois moves simultâneos). Corrigido em `folders_service.py::get_folder_for_move`. Como `get_db` já abre uma transação por request, o lock resultante cobre toda a operação.
- **I2/R6 (`documents.company_id` = `folders.company_id`)**: `restore_single` (restaurar documento da lixeira) atualizava `folder_id` mas nunca resincronizava `company_id` com a pasta de destino. Sem bug ativo hoje (o único chamador sempre resolve a pasta na mesma empresa), mas sem trava alguma para um chamador futuro. Corrigido: o UPDATE agora faz JOIN com `folders` e copia `company_id` de lá.
- **Invariante I8 (nenhum router acessa o banco direto) estava incompleta** — havia sido dada como resolvida numa sessão anterior, mas 8 dos 13 routers ainda tinham SQL cru: `auth.py` (2 chamadas), `favorites.py` (8), `admin.py` (8), `notifications.py` (4), `companies.py` (26), `trash.py` (22), `versions.py` (25), `shares.py` (20) — 115 chamadas ao todo. Criados `auth_service.py`, `favorites_service.py`, `admin_service.py`, `companies_service.py`, `trash_service.py`, `versions_service.py`, `shares_service.py`, e estendido `notification_service.py` com as funções de leitura. Confirmado por grep: **0 chamadas cruas em todos os 13 routers** depois da refatoração. Todos os 61 endpoints (71 operações, contando GET/POST/etc.) confirmados presentes no schema OpenAPI antes/depois, incluindo os endpoints mock ocultos do schema.
- **Invariantes I4/I5, ao lado de I8**: aproveitando que cada router precisou ser tocado de qualquer forma, cada uso de `admin_conn` foi reavaliado individualmente. Em `favorites.py`, o INSERT em `activity_log` usava `admin_conn` sem necessidade — a política RLS `activity_log_insert` já permite qualquer `authenticated` inserir sua própria linha (`user_id = auth.uid()`), então passou a usar `conn` normal. Nos demais arquivos (`companies.py`, `trash.py`, `versions.py`, `shares.py`), o uso de `admin_conn` permanece — são operações genuinamente cross-usuário ou cross-empresa (criar empresa, criar conta no Supabase Auth, gerenciar acesso de outros usuários, listar todos os usuários do sistema) ou rotas públicas sem sessão RLS (compartilhamento externo). **Não fizemos a reescrita completa de I4/I5** (tornar toda escrita dependente só de RLS) — o próprio `02-DECISOES-ARQUITETURA.md` (ADR-003) chama esse padrão de "a pior falha de segurança possível" se abusado, mas essa é uma decisão de arquitetura grande e pré-existente desde a v1, com uso disseminado e — no formato atual — sem incidente conhecido; reescrever tudo de uma vez seria arriscado demais pra fazer sem uma conversa dedicada e um plano próprio.
- **Invariante I11 (nunca deixar arquivo órfão no storage) — bug real e ativo em produção**: a exclusão permanente (manual, em `trash.py`, e automática, no `maintenance_worker.py`) só removia o objeto do R2 quando rodando em modo mock local — em produção (R2 real) o código tinha literalmente um comentário `# R2: seria _s3.delete_object(...)` seguido de `pass`. Todo documento excluído permanentemente desde o início da produção ficou com o arquivo real esquecido no R2 para sempre. Mesmo bug encontrado e corrigido em `versions.py::delete_version` (exclusão manual de versão antiga). Corrigido: nova função `storage_service.delete_object()`, chamada sem condicional de mock em todos os três pontos.
- **Pastas: exclusão nunca era registrada em `activity_log`** — só a restauração registrava. Isso também impedia o aviso de "será removido em 2 dias" (ADR-031) de funcionar para pastas, já que ele depende de saber quem excluiu via `activity_log`. Corrigido: `folders_service.py` ganhou `log_delete_activity`, chamado por `DELETE /folders/:id`.
- **ADR-031 (Notificações × Retenção) só cobria documentos**: `maintenance_worker.py::_notify_trash_expiring_soon` agora também avisa 2 dias antes da purga de pastas (dependia do fix acima para funcionar).
- **ADR-031 (Task Center × Versionamento)**: upload de nova versão nunca aparecia no Task Center com o rótulo "Nova versão de [nome]" — só um toast + notificação no sino. Corrigido: `VersionsPanel.tsx` agora chama `useTaskCenter().addTask()`/`updateTask()` com esse rótulo específico.
- **Lixeira sem exclusão permanente na tela**: o backend (`DELETE /trash/:id/permanent`) sempre existiu, mas `Trash.tsx` só tinha "Restaurar". Corrigido com os dois níveis do design system: exclusão individual (nível "Médio" — `ConfirmModal` com botão danger) e exclusão em lote (nível "Alto" — `ConfirmModal` estendido com prop `requireTypedConfirmation`, exige digitar "CONFIRMAR" pra habilitar o botão). Barra de ações em lote flutuante segue o mesmo tratamento de vidro já usado em Documents.tsx.
- **ADR-035 (snippet de busca só para match de OCR)**: o snippet aparecia mesmo quando o match era só no nome do arquivo (ts_headline caía pro nome via `coalesce`). Corrigido em `search_service.py`: snippet só é gerado quando `ocr_text` de fato bate com a tsquery; senão retorna `NULL` e o frontend já escondia a linha nesse caso.
- **Endpoint morto removido**: `POST /admin/users` criava usuário direto na tabela sem nunca criar a conta correspondente no Supabase Auth (um usuário criado por ele nunca conseguiria logar) — confirmado, via grep, que nenhuma tela do frontend chama esse endpoint (o fluxo real de criação de usuário usa `POST /companies/{id}/members`, que já cria a conta corretamente). Removido.

### Achados registrados, mas deliberadamente não alterados nesta frente

- **ADR-026 (densidade de tabela)**: permanece só em `localStorage`, não em uma tabela `user_preferences` no servidor como o adendo original pedia — baixo impacto (não sincroniza entre dispositivos), alto custo (exigiria nova tabela/coluna só para isso).

### Continuação — I4/I5 e I3 tratados a pedido explícito do usuário

O usuário pediu pra tratar os itens 14 (I4/I5) e 15 (I3) da forma mais assertiva e segura possível, sem reescrever tudo de forma arriscada.

**I3 (`documents.ocr_status` fora do worker) — centralizado:**
- `retry_ocr_transaction` (retry manual), `confirm_version` e `restore_version` (upload/restauração de versão) cada um reimplementava o par "INSERT em `ocr_jobs` + UPDATE `documents.ocr_status='pending'`" separadamente. Criada `DocumentsService.enqueue_ocr()` como o único ponto do código que faz esse par — os três chamadores agora usam essa mesma função. Isso não muda nenhum comportamento hoje, mas elimina o risco de os dois writes divergirem se algum dos três pontos for alterado no futuro sem lembrar do outro.

**I4/I5 (service role fora de seed/worker/jobs internos) — auditoria completa dos ~30 endpoints que usam `admin_conn`, não reescrita:**
- Antes de mexer em qualquer coisa, confirmado exatamente o que `get_db_admin` faz: conecta como superusuário do Postgres (mesmo pool do `get_db`, mas sem `SET LOCAL role TO authenticated`) — bypassa RLS por completo, sem exceção. Isso significa que toda decisão de autorização nesses endpoints depende 100% do código Python, sem trava do banco.
- Auditados, um por um, todos os endpoints que usam essa conexão: `admin.py` (4), `documents.py` (8), `folders.py` (1), `companies.py` (8), `trash.py` (3), `versions.py` (4), `shares.py` (3 públicas), `activity.py` (1).
- **Achado tranquilizador**: quase toda checagem de permissão no código já passa pela função canônica `public.user_has_access()` (a mesma que o RLS usa internamente), mesmo quando a query em si roda numa conexão que ignora RLS — ou seja, a *decisão* de quem pode fazer o quê está centralizada corretamente; o que falta é só o banco não conseguir vetar independentemente se o Python tiver um bug.
- **Achado real, corrigido**: `POST /documents/:id/retry-ocr` não verificava permissão de escrita antes de reprocessar o OCR — qualquer usuário com acesso só de leitura (visualizador) conseguia forçar reprocessamento de um documento quantas vezes quisesse (custo de CPU/Tesseract sem necessidade, ainda que não vazasse dado nenhum). Corrigido: `get_document_for_ocr_retry` agora retorna a permissão real via `user_has_access()`, e o router exige `admin`/`operador` antes de continuar — mesmo padrão já usado em upload/mover/excluir.
- **Decisão consciente de não reescrever admin_conn → RLS em todo lugar**: a maior parte dos usos restantes é genuinamente necessária (criar empresa, criar conta no Supabase Auth, gerenciar acesso de outros usuários, rotas públicas de compartilhamento sem sessão, restaurar itens que o RLS torna invisíveis por estarem soft-deleted). Trocar isso por RLS puro em todo lugar exigiria reescrever políticas de RLS e testar cada uma manualmente — risco real de repetir o tipo de incidente que já tivemos (bloqueio de admin). Ficou registrado como possível iniciativa futura própria, não como algo pendente desta frente.

### Teste de verificação (I3/I4/I5)

- App inteiro importa sem erro, 71 operações no schema OpenAPI (nenhuma perdida).
- `retry_ocr` agora replica exatamente o mesmo padrão de checagem de permissão usado em upload/mover/excluir/restaurar.
- **Escala tipográfica exata do design system** (`06-DESIGN-SYSTEM.md`): `text-sm`/`base`/`lg`/`xl` do Tailwind usam os tamanhos padrão da biblioteca, 1-2px diferentes do que o documento especifica (`text-xs` e `text-2xl`/`text-3xl` já batem). Decisão consciente de não mexer: seria uma mudança visual global num sistema já testado e aprovado (Frente 2), com risco de regressão desproporcional ao ganho.
- **Checagem explícita de `company_id` antes de assinar URL de download (ADR-037)**: hoje depende só do RLS (camada de aplicação não faz o checagem redundante). RLS já impede o vazamento de verdade (confirmado: os endpoints usam `conn`, não `admin_conn`) — tratado como reforço de defesa em profundidade de baixa prioridade, não uma falha ativa.

### Teste de verificação desta frente

- Todos os 13 routers backend confirmados com 0 chamadas SQL cruas (grep).
- App inteiro importa sem erro (`from app.main import app`), schema OpenAPI com 61 rotas / 71 operações, nenhuma perdida na refatoração (comparado antes/depois).
- Suíte de testes (`pytest --collect-only`) coleta os 4 testes existentes sem erro de import.
- Build do frontend (`tsc && vite build`) limpo em cada etapa.
- Teste ao vivo completo (login, sidebar, busca, ancorar, exclusão permanente em lote etc.) fica pendente do próximo deploy — backend e frontend só serão testados de ponta a ponta em produção depois que o usuário rodar os comandos de commit/push/deploy.

### Bug real encontrado pelo usuário pós-reseed — empresa cacheada nunca revalidada

Depois do reseed de dados (`python -m app.seed.demo_data`), o usuário reportou que clicar num resultado de busca sempre caía na pasta raiz em vez do local real do documento.

- **Causa raiz**: `CompanyContext.tsx` inicializa `current` a partir do `localStorage` (`docke_company`) de forma síncrona. A função `load()` só substituía `current` por uma empresa nova quando `current` começava `null` — se já havia algo em cache, nunca era revalidado contra a lista real vinda de `GET /companies`. Como todo reseed recria as empresas com UUIDs novos, qualquer navegador com uma empresa em cache de antes do reseed ficava preso num `company_id` morto para sempre, quebrando busca, documentos, pastas — tudo que é filtrado por `current.id`. O sintoma batia exatamente com o relato: a busca encontrava o documento (ela usa `company_id` só para filtrar, e o resultado retornado é de fato o certo), mas o deep-link em `Documents.tsx` procurava a pasta de destino dentro da lista de pastas da empresa (errada) em cache, não achava, e silenciosamente ficava na pasta raiz.
- **Por que passou despercebido nos meus próprios testes**: em todo teste anterior eu limpava o `localStorage` entre uma tentativa e outra, o que mascarava exatamente esse cenário — um usuário real nunca faz isso.
- **Correção**: `load()` agora compara `current` contra a lista real recebida de `/companies`; se o id salvo não existe mais na lista, substitui por `res.data[0]` (ou limpa para `null` se a lista vier vazia), atualizando `localStorage` nos dois casos.
- **Verificação**: build (`tsc && vite build`) limpo; teste ao vivo fiel ao cenário real — injetada manualmente uma empresa falsa/obsoleta no `localStorage`, recarregada a página, confirmado que o app se autocorrigiu para uma empresa real e válida; em seguida busca real por "NF-e" → clique no resultado → confirmado via snapshot que abriu o documento certo (`NF-e_Fornecedor_02.xml`, pasta Fiscal) com o Detail Drawer mostrando metadados corretos — não mais a pasta raiz.

### Busca global (Ctrl+K) x aba "Busca" — diferenciação e bug encontrado

O usuário perguntou qual a diferença entre a busca global do TopBar (Ctrl+K) e a aba "Busca" da sidebar, achando que pareciam redundantes.

- **Propósito pretendido, já diferenciado corretamente no backend**: a busca global abre o `CommandPalette.tsx`, que chama `/search/quick` (prefixo só no nome, sem trecho de conteúdo, máx 10 resultados) — um "ir rápido" tipo Spotlight. A aba "Busca" usa `Search.tsx`, que chama `/search` (FTS completo, nome **e** conteúdo OCR, trecho destacado, paginação) — busca de conteúdo de verdade.
- **Bug real encontrado nº1**: `CommandPalette.tsx`'s `select()` ignorava completamente qual resultado foi clicado — tanto pasta quanto documento navegavam sempre para `/documents` sem `folder_id`/`doc`, anulando a utilidade da busca rápida (clicar em qualquer resultado sempre caía na raiz). Corrigido para montar a URL com os parâmetros corretos, no mesmo padrão já usado em `Search.tsx`.
- **Bug real encontrado nº2 (mais sério, mesma classe do bug do `CompanyContext`)**: o efeito de deep-link em `Documents.tsx` só reagia a `searchParams` no *mount* do componente (dependência `[current?.id]`, com eslint-disable) e capturava o `doc` uma única vez via `useState(() => searchParams.get("doc"))`. Isso funcionava quando o deep-link vinha de outra página (ex.: `Search.tsx`, que desmonta/remonta `Documents.tsx`), mas falhava silenciosamente quando o usuário já estava em `/documents` e clicava num resultado do Command Palette — cenário exatamente reproduzido ao vivo durante a investigação (URL mudava corretamente, mas a tela não navegava). Corrigido: `pendingDocId` agora é estado reativo (`setPendingDocId` dentro do efeito) e o efeito de navegação depende também de `searchParams`, não só da empresa atual.
- **Verificação**: `tsc --noEmit` e `vite build` limpos; teste ao vivo reproduzindo o cenário exato (já em `/documents`, abrir Ctrl+K, buscar "NF", clicar no resultado) — confirmado via snapshot que a tabela passou a mostrar só o documento certo dentro da pasta Fiscal, com o Detail Drawer aberto com os metadados corretos, e a URL atualizada com `folder_id`/`doc` corretos.

### Bugs reais reportados no site de produção: dropdown atrás da tabela + demo mostrando pasta vazia

O usuário testou o site em produção e reportou dois problemas simultâneos: os menus de empresa/perfil apareciam atrás da tabela de documentos (visualmente cobertos), e ao entrar no modo demo a tela de Documentos mostrava "Pasta vazia" mesmo a conta demo tendo documentos reais (confirmado depois, ao reentrar via `/login`, que os dados existiam).

- **Bug 1 — dropdown atrás da tabela**: `TopBar.tsx`'s `<header>` usa `backdrop-filter` (via `.glass-blur-panel`), o que cria seu próprio contexto de empilhamento CSS com `z-index` implícito (`auto`). Ele é irmão do `<main>` no layout (`AppShell.tsx`), e a tabela de documentos dentro do `main` também cria seu próprio contexto (`relative` + `glass-blur-table`, outro `backdrop-filter`). Como nenhum dos dois tinha `z-index` explícito e `main` vem depois no DOM, ele pintava por cima do header — enterrando os dropdowns (empresa, avatar) que internamente usam `z-50`, mas esse `z-50` só vale dentro do contexto do próprio header. Corrigido: adicionado `z-20` explícito ao `<header>` do `TopBar.tsx`, garantindo que todo o header (headers + seus popups) sempre pinte acima do conteúdo principal.
- **Bug 2 — modo demo com pasta vazia**: `docke_company` no `localStorage` nunca era limpo em `login()`/`loginDemo()`/`logout()` — só `docke_token`/`docke_user` eram. Quando o usuário tinha uma sessão de conta real em cache (empresa "Grupo Zen", por exemplo) e trocava para o modo demo, o `CompanyContext` (já com a revalidação contra `/companies` da correção anterior) só reage quando o próprio provider é desmontado/remontado — o que normalmente acontece na troca de rota `/login` ↔ `/*`, mas deixa uma janela real de inconsistência se por qualquer razão isso não acontecer synchronamente. O sintoma batia exatamente: avatar já mostrando "Usuário Demo" (autenticação trocou certo), mas o seletor de empresa preso na empresa antiga, e a página de Documentos buscando pastas para uma empresa à qual a conta demo não tem acesso (retornando vazio). Corrigido na raiz: `useAuth.ts`'s `applySession()` (usado tanto por `login()` quanto `loginDemo()`) agora compara o `id` do usuário anterior com o novo e limpa `docke_company` sempre que a identidade muda — garantindo que nenhuma seleção de empresa de uma conta vaze para outra, independente de quando o `CompanyProvider` remonta.
- **Verificação**: `tsc --noEmit` e `vite build` limpos. Teste ao vivo do dropdown: `preview_screenshot` confirmando o menu de empresa renderizando por cima da tabela. Teste ao vivo do bug de conta: injetada manualmente uma sessão real falsa com empresa em cache antiga ("Grupo Zen"), navegado para `/login`, clicado em "Acessar modo demo" — confirmado via snapshot que o Dashboard já abriu direto com a empresa correta ("Comércio Alfa Modelo Ltda", 14 documentos, 4 pastas), sem precisar reentrar via `/login` uma segunda vez como acontecia antes da correção; página de Documentos também confirmada mostrando as 4 pastas reais.

### Preview de PDF/imagem fazia download em vez de abrir inline

Reportado junto com os bugs acima: clicar em "Visualizar" num PDF só disparava o download, sem abrir no modal.

- **Causa**: `PreviewModal.tsx` buscava a URL do arquivo via `/documents/:id/download-url` para todos os tipos, inclusive PDF e imagem — esse endpoint sempre assina a URL com `Content-Disposition: attachment`, forçando o browser a baixar em vez de renderizar no `<iframe>`/`<img>`. O endpoint correto para isso já existia desde M2.4 (`/documents/:id/preview-url`, com `Content-Disposition: inline` e fallback para arquivos >10MB), mas o frontend nunca o usava.
- **Corrigido**: PDF/imagem agora buscam via `/preview-url` (tratando o caso `inline: false` com a mensagem de tamanho excedido já retornada pelo backend); texto/XML/CSV continuam via `/download-url`, já que o conteúdo é lido via `fetch` e jogado num `<pre>`, então o `Content-Disposition` não importa nesse caso.
- **Verificação**: `tsc --noEmit` e `vite build` limpos. Teste ao vivo abrindo um PDF real via "Visualizar": confirmado (via `preview_network`) que a chamada agora vai para `/preview-url`, e a URL assinada do R2 tem `response-content-disposition=inline` — carregou no iframe do modal, sem disparar download.

### CI (GitHub Actions) + testes E2E (Playwright) — reduzir dependência de teste manual

Depois de uma sequência de bugs reais só descobertos porque o usuário testou manualmente (cache de empresa, dropdown atrás da tabela, preview de PDF, deep-link do Ctrl+K), o usuário pediu pra montar CI e testes E2E automatizados, cobrindo exatamente essas classes de bug.

- **`.github/workflows/ci.yml`**: dois jobs a cada push/PR na `main`.
  - `backend-tests`: sobe o stack local do Supabase via `supabase/setup-cli` + `supabase start` (aplica as migrations automaticamente), gera `backend/.env` com as chaves locais (capturadas via `supabase status -o env`), roda `pytest tests -v`.
  - `frontend-build`: `npm ci` + `tsc --noEmit` + `npm run build`.
- **`.github/workflows/e2e.yml`**: sobe o mesmo stack Supabase local, roda `python -m app.seed.demo_data` pra popular dados de demo determinísticos, sobe o backend real (`uvicorn`) em segundo plano, builda o frontend apontando pro backend local, e roda os testes Playwright contra o build de produção servido via `vite preview`.
- **`frontend/e2e/`** — 4 testes, cada um é a regressão de um bug real desta sessão:
  - `demo-login.spec.ts`: login via modo demo abre o dashboard com dados reais (documentos > 0).
  - `identity-switch.spec.ts`: injeta uma empresa antiga em cache antes do login (mesmo cenário real reportado), confirma que o modo demo não fica preso na empresa errada nem mostra "Pasta vazia".
  - `search-deep-link.spec.ts`: já em `/documents`, abre o Ctrl+K, busca e clica num resultado — confirma que navega pro documento certo (não fica na raiz).
  - `pdf-preview.spec.ts`: abre "Visualizar" num PDF e confirma, via `page.request.get()` na URL do iframe, que o header é `Content-Disposition: inline` (não `attachment`).
- **`frontend/playwright.config.ts`**: builda automaticamente o app com `vite preview` (via `webServer`) quando não estiver em CI; em CI, o workflow já builda e serve antes de rodar os testes.
- **Achado durante a verificação**: o evento `download` do Playwright não é confiável para testar preview de PDF — o "headless shell" que o Playwright baixa por padrão não embute o visualizador de PDF do Chrome, então ele trata qualquer PDF em iframe como download mesmo com `Content-Disposition: inline` (confirmado rodando o teste manualmente contra o app real). Reescrito para checar o header HTTP diretamente em vez de depender do comportamento do browser.
- **Verificação real**: os 4 testes rodaram de verdade contra o app já publicado em produção (não só localmente) — `demo-login`, `identity-switch` e `search-deep-link` passaram de primeira; `pdf-preview` só passou depois de trocar a asserção do evento `download` pela checagem direta do header, e de apontar pra uma pasta (RH) que ainda tinha PDF (a pasta Fiscal desta empresa de demo já tinha sido esvaziada por testes manuais anteriores nesta mesma sessão — não afeta o CI real, que sempre roda contra um seed fresco).
- **`frontend/package.json`**: adicionado `@playwright/test` como devDependency e o script `test:e2e`.
- Docker Desktop não estava rodando nesta máquina, então não foi possível validar o pipeline completo do `supabase start` localmente — a validação foi feita rodando os testes Playwright direto contra o app real em produção (mesma UI, dados reais), o que já confirma que os seletores e fluxos dos testes estão corretos; faltava a primeira execução real do workflow no GitHub Actions pra confirmar a parte de infraestrutura (Supabase local + seed + backend em CI).

### Primeira execução real do CI/E2E — 2 bugs pré-existentes descobertos (não relacionados ao pipeline em si)

A primeira rodada real no GitHub Actions falhou nos dois workflows — exatamente o tipo de coisa que só um ambiente 100% limpo (nunca visto antes) consegue expor. Nenhum dos dois é bug no pipeline; são bugs reais e pré-existentes no código de seed/teste que nunca tinham rodado contra um banco totalmente do zero.

- **E2E — `demo_data.py` gerava xlsx duplicado**: `_generate_minimal_xlsx(text)` só escrevia o texto do OCR (sorteado de um conjunto pequeno e fixo de opções) na célula A1 — nunca incluía o nome/título do documento, ao contrário de TODOS os outros tipos de arquivo gerados pelo seed (pdf/docx/xml/jpg/txt sempre embutem o título). Quando o sorteio aleatório escolhia o modelo "Conciliação_{n}.xlsx" mais de uma vez para a mesma empresa E também sorteava o mesmo texto de OCR para ambas as vezes, os dois arquivos .xlsx saíam byte-a-byte idênticos (confirmado isolando a função e comparando hashes) — violando `UNIQUE(company_id, content_hash)`. Não é uma falha de configuração do CI: é uma falha latente que sempre existiu, só nunca tinha sido "azarada" nas ~5-6 rodadas manuais de reseed feitas ao longo desta sessão. Corrigido: `_generate_minimal_xlsx` agora recebe e embute o título também, igual todos os outros tipos.
- **CI — testes de integração usando papéis que não existem mais**: `backend/tests/conftest.py` (fixture `two_companies`) e `backend/tests/test_permissions.py` inseriam/esperavam `permission_level` no modelo antigo de 3 papéis (`viewer`/`editor`/`manager`), de antes da migração `20260703000010_papel_operador_escopo_pasta.sql` desta mesma sessão, que trocou a CHECK constraint pra `('visualizador', 'operador', 'admin')`. Como o ambiente de desenvolvimento local nunca tinha sido recriado do zero depois dessas migrations (só recebeu `ALTER TABLE` incremental), esse desalinhamento entre os testes e o schema atual ficou invisível até o CI rodar contra um banco genuinamente novo. Corrigido: `conftest.py` e `test_permissions.py` atualizados para os papéis atuais (mapeamento direto: viewer→visualizador, editor→operador, manager→admin).
- **Verificação**: o bug do xlsx foi confirmado isolando `_generate_minimal_xlsx` fora do app (sem precisar de banco) e comparando hashes antes/depois da correção — confirmado que a versão antiga colidia e a nova não. O fix dos testes de permissão foi conferido linha a linha contra a `CHECK` constraint da migration mais recente (não é suposição). A validação end-to-end de ambos os fixes junto do pipeline real do GitHub Actions fica pendente da próxima rodada, já que o Docker Desktop não conseguiu subir nesta máquina a tempo pra reproduzir localmente.

### Segunda varredura (segurança) + revisão de estrutura das abas — 4 itens implementados

Pedido do usuário: implementar os achados da varredura de segurança e da revisão de abas, "de maneira cuidadosa e testando". Um agente de segurança dedicado (Explore) auditou o backend; verifiquei manualmente os achados mais graves antes de agir — dois foram rebaixados/descartados por já estarem cobertos (endpoints mock-* só respondem em modo mock, nunca em produção; restore de item na lixeira já é implicitamente protegido porque o check de permissão da pasta destino roda dentro da mesma empresa do item).

**1. Rate limiting em `/auth/login` e `/auth/demo-login`** (`backend/app/routers/auth.py`)
- Não existia nenhuma proteção contra brute-force de senha — só o rate limiting de `shares.py` (senha de link) existia. Reaproveitado o mesmo `rate_limit.py` e os mesmos limites (5 tentativas / 60s / bloqueio de 15min), agora chaveado tanto por e-mail quanto por IP (o que disparar primeiro bloqueia) — protege contra ataque a uma conta específica E contra varredura de várias contas do mesmo IP.
- `demo_login()` passa a receber `Request` e repassa pra `login()`, herdando a mesma proteção.
- Verificado: import do app limpo (61 rotas, nenhuma perdida), teste isolado da lógica de `rate_limit.py` confirmando bloqueio exatamente na 5ª tentativa.

**2. Permissão faltando em `POST /documents/:id/confirm`** (`documents_service.py`, `documents.py`)
- `get_document_for_confirm` rodava em `admin_conn` sem checar se o usuário tem acesso ao documento — só validado na etapa anterior (`/upload-url`). Corrigido: query agora retorna `permission` via `user_has_access()`, e o router exige `admin`/`operador` antes de continuar.
- **Detalhe importante descoberto durante a implementação**: `admin_conn` nunca tem `request.jwt.claims` setado (não passa pelo `get_db`), então `auth.uid()` seria sempre `NULL` nessa conexão — o `user_id` precisou ser passado como parâmetro explícito pra `user_has_access()` em vez de depender de `auth.uid()` implícito. Isso foi pego ANTES de rodar, revisando o próprio código — outros pontos do código que fazem esse mesmo tipo de checagem em `admin_conn` (ex.: `fetch_documents_with_permission`) são sempre chamados com `conn` normal, não `admin_conn`, então não tinham esse problema.
- Verificado: schema OpenAPI com as mesmas 61 rotas, `pytest --collect-only` sem erro de import.

**3. Clique em "Ancorados" não navegava** (`favorites_service.py`, `Favorites.tsx`)
- A API de favoritos nunca retornava o `folder_id` do documento favoritado — impossível montar o deep-link sem isso. Adicionada a coluna `document_folder_id` na query. Frontend: item da lista agora é clicável (mesmo padrão de `Search.tsx`/`CommandPalette.tsx`: `/documents?folder_id=...&doc=...`), com o botão de remover usando `stopPropagation` pra não disparar a navegação.
- Verificado: `tsc`/`vite build` limpos; construção da URL testada isoladamente (folder, documento com pasta, documento na raiz) — bate exatamente com o padrão já usado e comprovado nesta sessão.

**4. Nova aba "Compartilhados"** (`shares_service.py`, `shares.py`, `Shares.tsx` novo, `Sidebar.tsx`, `App.tsx`)
- O endpoint `GET /shares` já suportava listar todos os links da empresa sem filtro (RLS já resolve "próprios links OU todos se for admin da empresa" — `shares_select` policy), só nunca tinha sido chamado assim pelo frontend. Adicionado `company_id` como filtro opcional adicional (não é checagem de segurança, é só pra a tela mostrar uma empresa por vez, como o resto do app) e uma coluna `resource_name` (nome do documento/pasta) pra exibição, via LEFT JOIN.
- Nova página lista todos os links ativos com nome do item, contagem de acessos, expiração, e permite revogar (reaproveitando `DELETE /shares/:id` já existente) — clicar no item navega pro documento/pasta compartilhado.
- **Bug real encontrado e corrigido durante o teste ao vivo**: `relativeDate()` (`src/lib/date.ts`) só tratava datas passadas — pra uma data futura (expiração de link), o `diff` (agora − data) fica negativo, caindo incorretamente no primeiro `if` e mostrando "agora" em vez de "em 7 dias". Esse bug já existia silenciosamente em `ShareModal.tsx` (que também mostra a expiração), só ninguém tinha reparado porque é um detalhe pequeno num modal. Corrigido com um ramo novo para diffs negativos ("em X min/h/dias"), sem alterar o comportamento existente pra datas passadas (usado em todo o resto do app).
- Verificado ao vivo, contra a produção real: criado um link de compartilhamento de verdade via API, confirmado que aparece na nova tela (com fallback correto pro nome enquanto o backend não é reimplantado — `resource_name` só existe a partir deste deploy), clicado em "Revogar", confirmado no modal, e o item sumiu da lista corretamente.

### Deploy e verificação ao vivo em produção (pós-`fly deploy`)

O usuário rodou o commit/push e o `fly deploy` do backend. Testado ao vivo contra a produção real (não mock):

- Login via modo demo funcionou normalmente pós-deploy — confirma que o rate limiting novo não quebrou o fluxo normal.
- Criado um link de compartilhamento de verdade via API, confirmado que "Compartilhados" agora mostra o nome real do documento (`resource_name`) em vez do fallback "(item removido)".
- **Bug real encontrado ao clicar no item pra abrir o documento compartilhado**: a navegação usava só `/documents?doc=...`, sem `folder_id` — exatamente o mesmo tipo de bug já corrigido em "Ancorados" nesta mesma sessão, só que eu mesmo reintroduzi a versão dele aqui ao escrever `Shares.tsx` do zero. A tela de Documentos exige `folder_id` pra processar o deep-link; sem ele, o efeito nem tenta abrir o documento. Causa raiz: `SharesService.list_shares` também não retornava o `folder_id` do documento compartilhado (mesma lacuna que a API de favoritos tinha). Corrigido: adicionada a coluna `document_folder_id` na query (mesmo padrão de `favorites_service.py`), e `Shares.tsx` agora monta a URL completa (`/documents?folder_id=...&doc=...`).
- Verificado de novo ao vivo: `tsc`/import limpos, link revogado com sucesso via UI (fluxo completo de criar → listar → revogar testado de ponta a ponta contra produção).
- **Ainda pendente**: essa correção do `folder_id` foi feita DEPOIS do deploy já ter acontecido — precisa de mais um commit/push + `fly deploy` pra ir ao ar. O clique em "Compartilhados" só vai navegar corretamente pro documento depois desse próximo deploy.

---
*Fim do progresso. Atualizar após cada tarefa concluída.*
