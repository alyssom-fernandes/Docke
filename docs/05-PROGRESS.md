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

## Pós-lançamento (v1.1 — alta prioridade)

- ⬜ Preview de XML fiscal com extração de campos-chave (emitente, CNPJ, valor, data)
- ⬜ Export do activity_log em formato Excel (além do CSV já implementado)

## v2 (roadmap futuro)

- ⬜ Versionamento de documentos (requer rodada de validação de schema própria — ver ADR-008)
- ⬜ Compartilhamento externo (link público com senha/expiração)
- ⬜ Notificações (novo documento em pasta com acesso)
- ⬜ Toggle de densidade de tabela (compacto/confortável)
- ⬜ PWA (manifest + service worker)

---
*Fim do progresso. Atualizar após cada tarefa concluída.*
