================================================================================
DOCKE — MANUAL DE EXECUÇÃO PARA O CLAUDE CODE
================================================================================
Documento de referência única para implementação. Consolida as decisões
das Fases 1 a 4 do planejamento, já validadas por 5 IAs em múltiplas
rodadas de revisão cruzada. Este documento é a fonte de verdade.

================================================================================
PARTE 0 — REGRAS ARQUITETURAIS NÃO-NEGOCIÁVEIS
================================================================================

Estas regras não são sugestões. Violá-las introduz vulnerabilidades de
segurança ou inconsistência de dados que serão caras de corrigir depois.

R1. NUNCA usar a Supabase service role key para queries de usuário comum.
    Service role key é exclusiva para: seed do modo demo, jobs administrativos
    internos do sistema. Toda requisição de usuário autenticado deve repassar
    o JWT dele até o Postgres (ver Parte 3).

R2. `activity_log` é append-only. Nenhuma linha é jamais editada ou
    deletada. "Undo" cria um evento novo (ex: ação `restore` após
    ação `delete`), nunca modifica o evento original.

R3. `ocr_jobs` é a única autoridade sobre o estado de processamento de
    OCR. `documents.ocr_status` é um espelho de leitura. Toda escrita em
    `documents.ocr_status` ocorre na MESMA transação que a escrita
    correspondente em `ocr_jobs`. Nenhum outro código escreve nesse campo.

R4. Mover uma pasta é uma operação transacional: atualizar o path da
    pasta movida + atualizar o path de todos os descendentes acontece
    dentro de uma única transação. Falha em qualquer etapa = rollback
    completo. Nunca deixar a árvore em estado parcialmente atualizado.
    TESTE OBRIGATÓRIO: validar a operação de mover com árvores de pelo
    menos 4 níveis de profundidade antes de confiar nela em produção --
    erros de lógica na propagação de paths para descendentes podem
    passar despercebidos em árvores rasas e só aparecer com profundidade
    real.

R5. Resolução de permissão por herança: quando um usuário tem permissões
    em múltiplos pontos da árvore de pastas que afetam uma mesma pasta,
    o caminho MAIS ESPECÍFICO (path mais longo/profundo) sempre prevalece
    sobre o mais genérico — independente de ser mais ou menos permissivo
    que o ancestral. Implementação: ordenar os paths de acesso do usuário
    que sejam ancestrais (ou iguais) à pasta-alvo por profundidade
    decrescente e usar a permissão do primeiro resultado.

R6. `documents.company_id` deve ser idêntico ao `company_id` da pasta
    (`folders.company_id`) que o contém. Validar isso via CHECK
    constraint/trigger no banco OU validação obrigatória no service
    layer antes de qualquer INSERT/UPDATE que mude `folder_id` de um
    documento.

R7. `permission_service.py` (Python, fora do banco) pode existir para
    UX/validação prévia (ex: desabilitar um botão no frontend antes
    mesmo de chamar a API), mas NUNCA substitui o RLS como mecanismo
    de autorização real. A fonte de verdade sobre quem pode acessar o
    quê é sempre a função `user_has_access` em SQL + as políticas RLS.
    Duas implementações da mesma regra (uma em SQL, uma em Python)
    divergem com o tempo se uma delas não for puramente decorativa.

R8. Mover uma pasta usa `SELECT ... FOR UPDATE` na pasta antes de
    iniciar a operação (evita condição de corrida se dois usuários
    tentarem mover a mesma pasta simultaneamente). Validar que o
    destino não é um descendente da própria pasta sendo movida (evita
    ciclos na árvore) antes de aplicar qualquer mudança de path.

================================================================================
PARTE 1 — SCHEMA DE BANCO DE DADOS (FINAL)
================================================================================

-- Extensões necessárias (validar disponibilidade no Supabase antes de migrar)
CREATE EXTENSION IF NOT EXISTS ltree;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Configuração de busca em português (não existe por padrão, precisa
-- ser criada explicitamente ou to_tsvector('portuguese', ...) falha)
CREATE TEXT SEARCH CONFIGURATION portuguese (COPY = pg_catalog.portuguese);

-- companies
companies (
  id uuid PK,
  name text,
  is_single_company_mode bool default false,
  created_at timestamptz
)

-- users (espelha auth.users)
users (
  id uuid PK references auth.users,
  username text unique,
  full_name text,
  role text check (role in ('supremo','admin','usuario')),
  is_active bool default true,
  created_at timestamptz,
  last_login_at timestamptz
)

-- folders
folders (
  id uuid PK,
  company_id uuid FK companies,
  parent_id uuid FK folders nullable,
  path ltree not null,           -- ex: '1.5.3'
  name text,
  deleted_at timestamptz nullable,
  created_at timestamptz,
  created_by uuid FK users
)
CREATE INDEX idx_folders_path ON folders USING GIST (path);

-- user_company_access
user_company_access (
  id uuid PK,
  user_id uuid FK users,
  company_id uuid FK companies,
  folder_path ltree nullable,    -- null = acesso a toda a empresa
  permission_level text check (permission_level in ('viewer','editor','manager')),
  granted_by uuid FK users,
  created_at timestamptz
)

-- documents
documents (
  id uuid PK,
  folder_id uuid FK folders,
  company_id uuid FK companies,  -- deve igualar folders.company_id (R6)
  name text,
  mime_type text,
  file_type text,                -- extensão
  size_bytes bigint,
  storage_path text,             -- "documents/{company_id}/{document_id}.{ext}"
  content_hash text,             -- SHA-256, UNIQUE(company_id, content_hash)
                                  -- evita duplicata dentro da mesma empresa,
                                  -- mas permite mesmo arquivo em empresas
                                  -- diferentes
  sector text nullable,
  competencia date nullable,
  tipo_fiscal text nullable,
  ocr_status text check (ocr_status in ('pending','processing','done','failed')),
  ocr_text text nullable,
  ocr_completed_at timestamptz nullable,
  uploaded_by uuid FK users,
  created_at timestamptz,
  updated_at timestamptz,
  deleted_at timestamptz nullable,
  deleted_original_folder_id uuid nullable
)
CREATE INDEX idx_documents_company_folder ON documents (company_id, folder_id);
CREATE INDEX idx_documents_deleted ON documents (deleted_at);
CREATE INDEX idx_documents_search ON documents USING GIN (
  to_tsvector('portuguese', unaccent(name || ' ' || coalesce(ocr_text, '')))
);

-- ocr_jobs
ocr_jobs (
  id uuid PK,
  document_id uuid FK documents,
  status text check (status in ('pending','processing','done','failed')),
  attempts int default 0,
  started_at timestamptz nullable,
  finished_at timestamptz nullable,
  error_message text nullable,
  next_retry_at timestamptz nullable,
  created_at timestamptz
)

-- favorites (redesenhado, sem modelo polimórfico)
favorites (
  id uuid PK,
  user_id uuid FK users,
  document_id uuid FK documents nullable,
  folder_id uuid FK folders nullable,
  created_at timestamptz,
  CHECK ((document_id IS NOT NULL) <> (folder_id IS NOT NULL))
)

-- activity_log (append-only, nunca UPDATE/DELETE)
activity_log (
  id uuid PK,
  user_id uuid FK users,
  company_id uuid FK companies,
  action text check (action in ('upload','view','move','rename','delete',
    'restore','download','favorite','unfavorite')),
  item_type text check (item_type in ('document','folder')),
  item_id uuid,
  item_name_snapshot text,
  metadata jsonb nullable,
  created_at timestamptz
)
CREATE INDEX idx_activity_user_date ON activity_log (user_id, created_at desc);
CREATE INDEX idx_activity_item ON activity_log (item_id, item_type);
CREATE INDEX idx_activity_company_date ON activity_log (company_id, created_at desc);

================================================================================
PARTE 2 — POLÍTICAS RLS (ORDEM DE IMPLEMENTAÇÃO)
================================================================================

IMPLEMENTAR NESTA ORDEM, ANTES DE QUALQUER ROUTER:

1. Função `user_has_access(user_id uuid, target_path ltree, company_id uuid)
   RETURNS text` (retorna o permission_level efetivo ou null).
   Lógica: buscar em user_company_access todas as linhas do usuário
   nessa company onde folder_path é null (acesso total) OU é ancestral/
   igual a target_path. Ordenar por profundidade de folder_path
   decrescente (nulls por último, são os menos específicos). Retornar
   o permission_level da primeira linha.

2. Policy de SELECT em `folders`: usuário só vê pastas onde
   user_has_access() retorna não-null.

3. Policy de SELECT em `documents`: mesma lógica, usando o path da
   pasta que contém o documento.

4. Policies de INSERT/UPDATE/DELETE em `folders` e `documents`: exigir
   permission_level >= 'editor' (editor ou manager) para escrita,
   'manager' para exclusão permanente e gestão de permissões.

   EXCEÇÃO: `activity_log` tem política de INSERT própria e separada,
   independente de permission_level: qualquer usuário autenticado pode
   inserir uma linha, desde que `user_id` da nova linha seja igual ao
   seu próprio `auth.uid()`. Sem essa exceção, um usuário `viewer`
   seria bloqueado de registrar que visualizou ou baixou um documento
   — ação que ele tem permissão de fazer, mas que falharia ao tentar
   logar.

   Operadores ltree a usar na função `user_has_access`:
   - `folder_path @> target_path` verifica se folder_path é ancestral
     (ou igual) a target_path
   - `folder_path IS NULL` sempre resulta em match (acesso à empresa toda)
   - Ordenar resultados por `nlevel(folder_path) DESC` (mais específico
     primeiro), tratando NULL como nlevel 0 (menos específico)

5. TESTE OBRIGATÓRIO antes de prosseguir: criar 2 empresas fictícias,
   2 usuários com permissões diferentes, confirmar que um usuário NUNCA
   vê dados da empresa do outro, e que a regra de especificidade (R5)
   funciona com um caso de permissão ampla + restrição em subpasta.

================================================================================
PARTE 3 — FLUXO JWT → POSTGRES (CONTRATO EXATO)
================================================================================

Toda requisição autenticada segue este fluxo, implementado como
dependency do FastAPI:

```
1. Frontend envia header: Authorization: Bearer <jwt_supabase>
2. FastAPI dependency:
   a. Extrai e valida o JWT (verificar assinatura com a chave pública
      do Supabase)
   b. Decodifica claims: sub (user_id), role, email
   c. Abre conexão/transação com o Postgres
   d. Executa: SELECT set_config('request.jwt.claims', 
        '{"sub": "<user_id>", "role": "authenticated", "email": "<email>"}',
        true)   -- o terceiro parâmetro 'true' é OBRIGATÓRIO (is_local).
                   Sem ele, o claim pode persistir além da transação
                   atual no connection pool e vazar para outra requisição.
   e. yield da conexão para a rota usar
3. Rota executa suas queries normalmente — RLS age via auth.uid() lendo
   o claim que foi setado
4. Ao final da rota: COMMIT (ou ROLLBACK em erro), conexão devolvida
   ao pool com claims já expirados (graças ao is_local=true)
```

TESTE DE SANIDADE OBRIGATÓRIO: após implementar a dependency, criar uma
rota de debug temporária que executa `SELECT auth.uid()` e confirmar que
retorna o user_id correto — nunca null, nunca de outro usuário.

Rotas administrativas (seed demo, manutenção) usam um client Postgres
separado, com service role key, claramente isolado do client usado
pelas rotas de usuário comum. Nunca compartilhar a mesma dependency.

================================================================================
PARTE 4 — PIPELINE DE OCR (CONTRATO EXATO)
================================================================================

1. Upload confirmado (POST /documents/:id/confirm):
   - INSERT em documents com ocr_status='pending'
   - INSERT em ocr_jobs com status='pending', document_id=<novo doc>
   (mesma transação)

2. Worker (processo separado, loop assíncrono, SEM Celery/Redis):
   AUTENTICAÇÃO: o worker não recebe requisições HTTP com JWT de
   usuário -- ele roda em background. Por isso, é uma das exceções
   válidas à Regra R1: o worker se conecta ao Postgres usando a
   service role key, pois atua como processo administrativo do
   sistema, não em nome de um usuário específico.

   INICIALIZAÇÃO: no evento de startup do FastAPI (`@app.on_event
   ("startup")` ou lifespan handler), se a variável de ambiente
   `ENABLE_OCR_WORKER=true`, disparar `asyncio.create_task()` com o
   loop abaixo, para que o worker rode junto com a aplicação sem
   precisar de um processo separado no MVP.

   ```python
   while True:
       job = fetch_one("""
           SELECT * FROM ocr_jobs 
           WHERE status = 'pending' 
           ORDER BY created_at 
           LIMIT 1 
           FOR UPDATE SKIP LOCKED
       """)
       if job:
           process(job)  # marca processing -> roda OCR -> done/failed
       await asyncio.sleep(30)
   ```

3. Ao concluir (sucesso ou falha), numa única transação:
   - UPDATE ocr_jobs SET status=..., finished_at=now(), error_message=...
   - UPDATE documents SET ocr_status=..., ocr_text=..., ocr_completed_at=now()
   Nenhuma outra rota, service ou worker pode alterar
   `documents.ocr_status` fora desta rotina de sincronização (reforço
   da regra R3).

4. Pré-processamento antes do OCR (usando Pillow/OpenCV): deskew
   (correção de inclinação), binarização adaptativa. Isso melhora
   significativamente a taxa de acerto do Tesseract em scans reais.

5. Retry manual: POST /documents/:id/retry-ocr cria um NOVO registro em
   ocr_jobs (não reaproveita o antigo) e seta documents.ocr_status='pending'.

6. Jobs travados: se um job fica em 'processing' por mais de N minutos
   (definir N=10 como padrão) sem finalizar, considerar travado e
   resetar para 'pending' com attempts+1. Job com attempts >= 3 vai
   para 'failed' definitivo, exigindo retry manual do usuário.

7. Interface abstrata para o motor de OCR (`OCRProvider.extract()`)
   para permitir troca futura por serviço em nuvem sem reescrever o
   pipeline.

================================================================================
PARTE 5 — STORAGE (R2)
================================================================================

Path: `documents/{company_id}/{document_id}.{ext}`

Upload: 
1. POST /documents/upload-url
   Body: { "folder_id": "...", "name": "...", "size_bytes": ...,
           "content_type": "..." }
   VALIDAÇÕES OBRIGATÓRIAS ANTES DE GERAR A URL:
   - MAX_FILE_SIZE: 50MB. Rejeitar com erro amigável se exceder.
     Validar TAMBÉM no frontend antes de chamar a API.
   - Extensão extraída de forma segura e restrita a whitelist:
     pdf, xlsx, xls, csv, docx, doc, xml, jpg, jpeg, png, gif, txt.
     Rejeitar extensões fora da lista. Sanitizar contra path
     traversal (nunca usar input do usuário diretamente no path).
   - Conflito de nome: se já existe arquivo com mesmo nome na pasta,
     retornar indicação de conflito para o frontend decidir
     (substituir / manter ambos com sufixo / cancelar).
   Cria registro em `documents` com status indicando upload pendente.
   Retorno: { "document_id": "...", "upload_url": "...", "expires_at": "..." }
2. Cliente faz PUT direto no R2 usando upload_url
3. POST /documents/:id/confirm
   Body: opcional, ex: { "actual_size": ... }
   Backend faz HEAD request no R2 para confirmar que o objeto existe
   antes de marcar como uploaded, calcula content_hash (SHA-256),
   dispara pipeline de OCR (Parte 4)

Preview:
1. GET /documents/:id/preview-url retorna presigned GET URL,
   expiração de 5 minutos, header Content-Disposition: inline
2. Frontend carrega em <iframe> (PDF) ou <img> (imagens)
3. Limite de 10MB para preview inline — acima disso, mostrar aviso
   e oferecer apenas download

CONFIGURAÇÃO OBRIGATÓRIA ANTES DO PRIMEIRO TESTE DE UPLOAD: o bucket
R2 precisa ter regras de CORS configuradas (painel Cloudflare ou CLI)
permitindo os métodos GET, PUT, HEAD e os headers necessários para o
domínio do frontend (Vercel). Sem isso, o navegador bloqueia o upload
no preflight (requisição OPTIONS) por violação de CORS, mesmo que a
presigned URL esteja correta.

================================================================================
PARTE 6 — BUSCA
================================================================================

PostgreSQL full-text search nativo, configuração 'portuguese' + unaccent.
Coluna indexada combina name + ocr_text, ambos passados por unaccent().

GET /search?q=&company_id=&type=&date_from=&date_to=
  -> usa ts_headline para gerar snippet com highlight do termo

GET /search/quick?q=
  -> versão rápida para a Command Palette, retorna top 5 (documentos +
     pastas), sem filtros avançados, latência mínima

================================================================================
PARTE 7 — ENDPOINTS COMPLETOS (LISTA FINAL)
================================================================================

AUTH
  POST   /auth/login
  GET    /auth/me

COMPANIES
  GET    /companies
  POST   /companies
  GET    /companies/:id

FOLDERS
  GET    /folders?company_id=&parent_id=
  POST   /folders
  PATCH  /folders/:id              (rename, move -- ver R4)
  DELETE /folders/:id              (soft delete)
  GET    /folders/frequent         (derivado de activity_log do usuário)

DOCUMENTS
  GET    /documents?folder_id=&company_id=
  GET    /documents/:id
  POST   /documents/upload-url
  POST   /documents/:id/confirm
  PATCH  /documents/:id
  DELETE /documents/:id            (soft delete)
  POST   /documents/:id/restore
  GET    /documents/:id/preview-url
  POST   /documents/bulk-download
  POST   /documents/bulk-move
  POST   /documents/bulk-delete
  POST   /documents/:id/retry-ocr

SEARCH
  GET    /search?q=&company_id=&type=&date_from=&date_to=
  GET    /search/quick?q=

FAVORITES
  GET    /favorites
  POST   /favorites
  DELETE /favorites/:id

ACTIVITY
  GET    /activity?company_id=&user_id=
  POST   /activity/undo/:id

TRASH
  GET    /trash
  POST   /trash/:id/restore     (se deleted_original_folder_id não existir
                                  mais -- pasta também foi excluída
                                  permanentemente -- restaurar na pasta
                                  raiz da empresa em vez de falhar)
  DELETE /trash/:id/permanent

ADMIN  (exigem permission_level='manager' ou role='admin'/'supremo')
  GET    /admin/users
  POST   /admin/users
  GET    /admin/permissions
  POST   /admin/permissions
  GET    /admin/storage-usage

================================================================================
PARTE 8 — ESTRUTURA DE PASTAS DO PROJETO
================================================================================

backend/
  app/
    main.py
    config.py                    (pydantic BaseSettings, sem os.getenv solto)
    dependencies.py              (get_db com JWT->RLS, ver Parte 3;
                                   get_db_admin com service role, isolado)
    models/
      company.py, document.py, folder.py, user.py, activity.py, ocr_job.py
    schemas/                     (Pydantic request/response)
      company.py, document.py, folder.py, ...
    routers/
      auth.py, companies.py, folders.py, documents.py, search.py,
      favorites.py, activity.py, trash.py, admin.py
    services/
      storage_service.py, ocr_service.py, search_service.py,
      permission_service.py      (contém user_has_access equivalente em
                                   Python para uso fora de RLS quando necessário)
    workers/
      ocr_worker.py               (loop assíncrono, Parte 4)
    seed/
      demo_data.py                (modo demo + templates de pasta por empresa)
  requirements.txt
  README.md                      (convenções: nomenclatura, onde cada
                                   coisa vai, regras da Parte 0)

frontend/
  src/
    main.tsx, App.tsx
    pages/
      Dashboard.tsx, Documents.tsx, Search.tsx, Trash.tsx, Activity.tsx,
      Favorites.tsx, Login.tsx,
      Settings/{Profile,Companies,Users,Permissions}.tsx
    components/
      layout/{TopBar,Sidebar,AppShell}.tsx
      documents/{FileTable,FileRow,FolderTree,UploadModal,PreviewModal}.tsx
      dashboard/{StatCard,RecentFiles,PinnedFolders,ActivityFeed}.tsx
      shared/{CommandPalette,Toast,EmptyState,Breadcrumbs}.tsx
      ui/{Button,Input,Badge,Checkbox,Avatar}.tsx
    hooks/
      useAuth.ts, useDocuments.ts, useCommandPalette.ts
    lib/
      api.ts, supabase.ts
    styles/
      tokens.css                 (variáveis do design system -- ver
                                   documento de identidade visual)
  package.json

Heurística de crescimento: se um domínio (ex: documents) ultrapassar
~800-1000 linhas somadas entre router+service+model+schema, considerar
migrar esse domínio para uma pasta própria (app/features/documents/).
Não antecipar essa migração -- fazer só quando o limite for atingido.

================================================================================
PARTE 8.1 — ORDEM DE IMPLEMENTAÇÃO (validada por consenso entre 5 IAs)
================================================================================

Seguir esta sequência minimiza retrabalho ao colocar a segurança
(RLS/permissões) validada antes de qualquer lógica de negócio depender
dela:

1. Setup do projeto (FastAPI + Vite/React esqueletos), config.py central
2. Schema completo: extensões, configuração FTS portuguese, tabelas,
   índices, constraints (incluindo R6 e UNIQUE(company_id, content_hash))
3. Função `user_has_access` + políticas RLS (Parte 2)
4. TESTE DE ISOLAMENTO: criar 2 empresas fictícias + usuários com
   permissões diferentes, confirmar isolamento total entre empresas e
   a regra de especificidade (R5) funcionando, ANTES de prosseguir
5. Dependency JWT → Postgres (Parte 3) + rota de debug /auth/me para
   validar com SELECT auth.uid()
6. CRUD básico de folders e documents (sem upload ainda)
7. Storage: upload-url + confirm + integração R2 (configurar CORS antes)
8. OCR: tabela ocr_jobs + worker + inicialização no startup
9. Busca (FTS) + favorites + activity + trash
10. Bulk actions + undo
11. Frontend: setup, autenticação, Login
12. Frontend: Dashboard, navegação, FileTable
13. Frontend: refinamento (Command Palette, ações em massa, admin)
14. Seed do modo demo (Parte 10)
15. Onboarding (Parte 11)
16. Deploy (Parte 9) + testes integrados finais

================================================================================
PARTE 9 — DEPLOY
================================================================================

Demo:
  Frontend: Vercel (free)
  Backend: Fly.io (free tier, SEM cold start -- não usar Render)
  Banco: Supabase (free tier)
  Storage: Cloudflare R2 (free tier, 10GB)

Produção (quando a primeira empresa real começar a usar):
  Backend: VPS dedicada (~€10-20/mês) ou manter Fly.io se performance
           permitir
  Banco: Supabase Pro ($25/mês) quando ultrapassar limites do free tier
  Storage: R2 pago (~$0.015/GB, egress sempre grátis)

================================================================================
PARTE 10 — MODO DEMO (SEED)
================================================================================

Script de seed (`app/seed/demo_data.py`), executado isoladamente, usa
o client com service role key (isolado do client de usuário, conforme
R1 e Parte 3) e NUNCA é exposto como endpoint público acessível pela
internet. Roda como comando administrativo (CLI/script), não como rota
HTTP.

Conteúdo do seed:
- 3 empresas fictícias (Posto Sol Nascente, Hotel Serra Azul,
  Restaurante Sabor & Arte)
- Estrutura de pastas por empresa usando o template padrão (Fiscal, RH,
  Bancário, Contratos)
- ~50 documentos fictícios distribuídos, com ocr_status='done' na
  maioria e 2-3 propositalmente em 'failed' (para demonstrar o retry)
- Atividade simulada nos últimos 7 dias em activity_log
- 3 documentos em soft-delete (lixeira)
- Usuário demo com acesso de manager a todas as 3 empresas

Dados resetam a cada 24h (job agendado que limpa e re-executa o seed).

================================================================================
PARTE 11 — ONBOARDING (PRIMEIRO ACESSO)
================================================================================

1. "Como se chama sua organização?"
2. "Quais empresas fazem parte?" (1 ou mais -- se for 1, ativa
   is_single_company_mode=true e a UI simplifica, removendo o filtro
   de empresa das listagens e o nível de empresa na sidebar)
3. Para cada empresa: "Deseja criar uma estrutura de pastas sugerida?"
   [Sim, criar estrutura] [Não, começar vazio]
   Se sim: aplica template (Fiscal, RH, Bancário, Contratos)
4. "Convide sua equipe" (emails dos primeiros usuários)
→ Dashboard com empty state amigável + CTA de upload

================================================================================
FIM DO MANUAL
================================================================================
NOTAS COMPLEMENTARES:
- O feedback visual de todas as operações assíncronas (upload, OCR, ZIP,
  export CSV) é unificado no TASK CENTER (ver 06-DESIGN-SYSTEM.md).
  Não existem sistemas de feedback separados (widget de upload
  independente, toasts de operação longa) — tudo vive no Task Center.
- Backup do banco é responsabilidade do Supabase. Arquivos permanecem
  no R2. Banco e storage devem ser tratados como conjunto consistente:
  nenhuma rotina de limpeza remove arquivo físico do R2 cujo registro
  ainda exista no banco (Invariante I11).
- Este documento deve ser lido junto com: 01-INVARIANTES.md,
  02-DECISOES-ARQUITETURA.md, 06-DESIGN-SYSTEM.md, e
  07-VOICE-AND-MICROCOPY.md para ter o contexto completo.
================================================================================
