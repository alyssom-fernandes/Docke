# Docke — Guia de Ambiente e Testes
> Primeira parte: instalação (desenvolvedor, uma vez só).
> Segunda parte: como subir o ambiente a cada sessão (Claude Code).
> Terceira parte: divisão de testes — o que o Claude Code testa sozinho e o que só o desenvolvedor pode testar.

---

# PARTE 1 — INSTALAÇÃO (desenvolvedor, uma vez só)

## Pré-requisitos

### Node.js
```
node --version
```
Se `v20.x.x` ou superior, ok. Senão: https://nodejs.org (versão LTS).

### Python 3.11+
```
python --version
```
Se `3.11+`, ok. Senão: https://python.org (versão estável mais recente).

### Supabase CLI
```
npm install -g supabase
supabase --version
```
Se aparecer versão, ok. O Supabase CLI sobe containers locais de Postgres, Auth e Storage — é o equivalente ao Firebase Emulator para esta stack.

### Docker Desktop
O Supabase CLI depende de Docker para rodar os containers locais. Instale em https://docker.com e confirme:
```
docker --version
```

### Tesseract OCR
Necessário para o pipeline de OCR local.
- **Windows:** https://github.com/UB-Mannheim/tesseract/wiki (baixar installer, adicionar ao PATH)
- **macOS:** `brew install tesseract`
- **Linux:** `sudo apt install tesseract-ocr tesseract-ocr-por`

Confirme:
```
tesseract --version
```

### Cloudflare R2 (bucket de desenvolvimento)
Crie um bucket `docke-dev` no painel da Cloudflare com regras de CORS configuradas:
- Allowed origins: `http://localhost:5173` (Vite dev server)
- Allowed methods: `GET, PUT, HEAD, OPTIONS`
- Allowed headers: `*`
- Max age: `3600`

Guarde as credenciais (Account ID, Access Key ID, Secret Access Key) para o `.env`.

## Setup inicial do projeto

```bash
# Clonar o repositório
# (via GitHub Desktop, não por CLI — o desenvolvedor cuida disso)

# Backend
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Frontend
cd ../frontend
npm install

# Supabase local
cd ..
supabase init  # só na primeira vez
supabase start
```

O `supabase start` sobe Postgres local com todas as extensões (ltree, unaccent, pg_trgm) já disponíveis. Anote as URLs e chaves que o CLI imprime — elas vão para o `.env`.

## Arquivo .env (backend)

```env
SUPABASE_URL=http://localhost:54321
SUPABASE_ANON_KEY=<chave anon do CLI>
SUPABASE_SERVICE_ROLE_KEY=<chave service do CLI>
DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
R2_ACCOUNT_ID=<seu account id>
R2_ACCESS_KEY_ID=<sua access key>
R2_SECRET_ACCESS_KEY=<seu secret>
R2_BUCKET_NAME=docke-dev
ENABLE_OCR_WORKER=true
```

## Arquivo .env (frontend)

```env
VITE_SUPABASE_URL=http://localhost:54321
VITE_SUPABASE_ANON_KEY=<chave anon do CLI>
VITE_API_URL=http://localhost:8000
```

**Pronto.** O desenvolvedor não precisa fazer mais nada aqui. O Claude Code cuida do resto a cada sessão.

---

# PARTE 2 — SUBIR O AMBIENTE (Claude Code, a cada sessão)

## Verificar e subir os serviços

```bash
# 1. Supabase (banco + auth + storage locais)
supabase start
# Se já estiver rodando, ok. Se parou, suba novamente.

# 2. Backend (FastAPI)
cd backend
source venv/bin/activate
uvicorn app.main:app --reload --port 8000

# 3. Frontend (Vite + React)
cd frontend
npm run dev
# Roda em http://localhost:5173
```

## Aplicar migrations

```bash
# Na raiz do projeto, com Supabase rodando:
supabase db push
# Isso aplica todas as migrations de supabase/migrations/ no banco local.
```

Se precisar resetar o banco do zero:
```bash
supabase db reset
# Recria tudo a partir das migrations. Dados locais são perdidos.
```

## Rodar o seed (modo demo)

```bash
cd backend
python -m app.seed.demo_data
# Popula o banco local com dados fictícios (3 empresas, ~50 docs, etc.)
```

## Verificar que tudo funciona

1. Acesse `http://localhost:5173` — o frontend deve carregar.
2. Acesse `http://localhost:8000/docs` — o Swagger do FastAPI deve aparecer.
3. Acesse `http://localhost:54323` — o Supabase Studio local (banco, auth, storage).
4. Execute `GET /auth/me` com um JWT de teste — deve retornar dados do usuário.

---

# PARTE 3 — DIVISÃO DE TESTES

## O Claude Code TESTA SOZINHO (a grande maioria)

Tudo isto roda no ambiente local e o Claude Code verifica por conta própria:

- **RLS e isolamento entre empresas:** criar 2 empresas + 2 usuários com permissões diferentes via seed, confirmar que um NUNCA vê dados do outro (queries SQL diretas ou via endpoints).
- **Regra de especificidade (R5):** testar com permissão ampla em empresa + restrição em subpasta, confirmar que a mais específica prevalece.
- **CRUD completo:** criar/editar/mover/renomear/excluir pastas e documentos.
- **Fluxo de upload:** upload-url → PUT no R2 (pode usar curl) → confirm → verificar registro no banco.
- **OCR pipeline:** disparar job, verificar transição pending → processing → done/failed, confirmar sincronização entre ocr_jobs e documents.ocr_status.
- **Busca FTS:** inserir documentos com texto OCR, buscar termos, verificar snippets com ts_headline.
- **Favoritos:** favoritar/desfavoritar, verificar activity_log registrando a ação.
- **Lixeira:** soft delete, restore (inclusive com pasta original deletada — deve restaurar na raiz), exclusão permanente.
- **Ações em lote:** selecionar múltiplos, mover/deletar em lote, verificar transação atômica.
- **Task Center (frontend):** upload + OCR aparecendo no mesmo painel, progresso atualizando.
- **Command Palette:** Ctrl+K abrindo, busca rápida retornando resultados, navegação por teclado.
- **Responsividade:** redimensionar janela para breakpoints (1280, 1024, 768px), verificar sidebar → drawer, tabelas → cards.
- **Tema dark/light:** alternar, verificar transição suave (180ms), verificar contraste WCAG AA.
- **Acessibilidade:** focus visible com ring teal, navegação por Tab, aria-labels em botões icon-only.
- **Empty states:** verificar que cada contexto (pasta vazia, busca sem resultado, lixeira vazia, sem permissão) exibe o estado correto com ilustração e microcopy.
- **Persistência de estado:** navegar para preview e voltar — scroll e seleção preservados.
- **Validações de formulário:** campos obrigatórios, nome duplicado de pasta, tamanho máximo de arquivo.
- **Testes automatizados (pytest):** RLS com múltiplos perfis, resolução de permissão por especificidade, transação de move de pasta, sincronização ocr_jobs ↔ documents.

## SÓ O DESENVOLVEDOR pode testar

Estas coisas dependem de serviços externos reais ou julgamento humano:

- **Upload real para Cloudflare R2 em produção** (presigned URLs funcionando no domínio real, não localhost).
- **Qualidade do OCR com documentos reais** (scans de notas fiscais do Grupo Zen, fotos de recibos, PDFs com carimbos — Tesseract varia muito com qualidade de input).
- **Deploy funcional no Fly.io + Vercel** (configuração de variáveis de ambiente, domínio, HTTPS).
- **Performance real com volume de dados** (1000+ documentos, múltiplos usuários simultâneos).
- **O olhar estético final no monitor** (espaçamentos, contraste percebido, "sensação" geral da interface, ritmo visual, peso dos cards). O Claude Code garante que o CSS está correto conforme spec, mas a aprovação estética final é humana.
- **Teste em dispositivos físicos reais** (celular de verdade no posto de combustível, tablet na cozinha do restaurante — não só janela redimensionada).
- **Teste de usabilidade com funcionários do Grupo Zen** (pausa obrigatória após M4, antes do deploy).

## Princípio da divisão

Se dá para testar no ambiente local, **é responsabilidade do Claude Code** e ele não deve empurrar para o desenvolvedor. O desenvolvedor só recebe o que é genuinamente impossível automatizar: serviços externos reais, performance de escala, e julgamento estético/humano.

---
*Fim do guia de ambiente.*
