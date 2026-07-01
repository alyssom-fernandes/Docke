# Docke — Decisões de Arquitetura (ADRs)
> Registro cronológico de decisões estruturais com motivo e alternativas descartadas.
> Se o Claude Code quiser propor uma mudança que conflite com uma decisão aqui,
> ele deve PARAR e consultar o desenvolvedor. Estas decisões já foram avaliadas
> e validadas por 5 IAs independentes em múltiplas rodadas.

---

## ADR-001: Herança de permissão via ltree (não recursão)
**Decisão:** Coluna `path` tipo `ltree` na tabela `folders`. Políticas RLS usam `folder_path @> target_path`.
**Motivo:** 5/5 IAs recomendaram ltree sobre recursão. Recursão em RLS causa: lentidão em árvores profundas, risco de "infinite recursion detected in policy" (erro conhecido do Postgres/Supabase quando políticas se referenciam), complexidade de debug para dev solo.
**Alternativas descartadas:** Recursive CTE em política RLS; closure table.

## ADR-002: OCR via tabela de jobs + worker com SKIP LOCKED (não BackgroundTasks puro)
**Decisão:** Tabela `ocr_jobs` separada de `documents`. Worker em loop assíncrono usa `SELECT ... FOR UPDATE SKIP LOCKED`.
**Motivo:** 5/5 IAs alertaram que BackgroundTasks do FastAPI não é fila durável — se o processo cair (deploy, crash), a tarefa desaparece silenciosamente. A tabela de jobs + SKIP LOCKED garante durabilidade só com PostgreSQL, sem Celery/Redis.
**Alternativas descartadas:** BackgroundTasks do FastAPI sem tabela de jobs; Celery+Redis (overengineering para o volume esperado).

## ADR-003: JWT repassado ao Postgres via set_config (não service role para queries de usuário)
**Decisão:** Toda requisição de usuário repassa o JWT via `set_config('request.jwt.claims', ..., true)` na transação. Service role key é exclusiva para jobs administrativos.
**Motivo:** Se o backend usar service role key para queries de usuário (atalho comum), o RLS é completamente ignorado — bypass nativo. 4/5 IAs convergiram neste alerta como "a pior falha de segurança possível".
**Alternativas descartadas:** Usar service role key globalmente e reimplementar autorização no Python (duplicaria lógica e perderia a garantia do RLS).

## ADR-004: Sidebar colapsável + top bar (não top-nav pura nem sidebar fixa)
**Decisão:** Sidebar colapsável (estilo Notion) + top bar minimalista (logo, busca, upload, perfil).
**Motivo:** 5/5 IAs na primeira validação visual apontaram que top-nav pura contraria o modelo mental de navegação de arquivos. A sidebar colapsável preserva largura quando recolhida e mantém a árvore acessível. A top bar fica para ações globais.
**Alternativas descartadas:** Top-nav horizontal pura; sidebar fixa expandida (ocupa espaço demais em telas menores).

## ADR-005: Dashboard orientado a tarefas (não métricas)
**Decisão:** Dashboard com busca proeminente + recentes + favoritos + stats compactos + feed de atividade. Sem gráficos de upload por período ou storage breakdown detalhado (estes ficam em admin/configurações).
**Motivo:** 4/5 IAs convergem que usuário de contabilidade/RH entra no sistema para RETOMAR O TRABALHO, não para ver gráficos. O dashboard ideal é orientado a tarefas.
**Alternativas descartadas:** Dashboard com donut chart de storage, gráficos de upload por período, KPIs abstratos no topo.

## ADR-006: Favoritos com FK real (não modelo polimórfico)
**Decisão:** `favorites(document_id nullable, folder_id nullable)` com CHECK constraint `(document_id IS NOT NULL) <> (folder_id IS NOT NULL)`.
**Motivo:** O modelo polimórfico (`item_type` + `item_id`) perde FK real, cascata automática, e validação do banco. O redesenho mantém integridade referencial nativa do Postgres.
**Alternativas descartadas:** `favorites(item_type enum, item_id uuid)` (polimórfico sem FK).

## ADR-007: Fly.io para backend demo (não Render)
**Decisão:** Backend de demo hospedado no Fly.io (free tier sem cold start).
**Motivo:** 5/5 IAs apontaram que Render free tier "dorme" após ~15 min de inatividade, com cold start de 30-50+ segundos. Risco real de causar má impressão na apresentação para os superiores do Grupo Zen.
**Alternativas descartadas:** Render free tier; Railway (mencionado mas com menos suporte entre as IAs).

## ADR-008: Versionamento de documentos adiado para v2 (sem placeholder)
**Decisão:** Não criar coluna `version` no schema da v1. O versionamento será desenhado em rodada própria antes da v2, provavelmente com tabela `document_versions` separada.
**Motivo:** Quando o versionamento real chegar, o modelo conceitual muda — "documento" deixa de ser um arquivo e passa a ser uma identidade lógica. Qualquer placeholder hoje seria removido depois. Registrar como ADR é suficiente.
**Alternativas descartadas:** Coluna `version int default 1` como placeholder (falsa preparação, seria descartada na v2).

## ADR-009: Task Center unificado (substituindo widget de upload + toasts fragmentados)
**Decisão:** Um único Task Center (ícone na top bar com badge numérico, popover com lista de tarefas) agrupa upload, OCR, ZIP, export CSV. Substitui: widget de upload no canto inferior direito e toasts de operação longa como sistemas separados.
**Motivo:** 5/5 IAs convergem que múltiplos sistemas de feedback simultâneos fragmentam atenção. Um único ponto de consciência reduz carga cognitiva. Padrão usado por Vercel (deployments), Linear (notifications), Arc (downloads).
**Alternativas descartadas:** Widget de upload persistente estilo Google Drive + toasts de lote separados.

## ADR-010: Splash screen removida (skeleton imediato)
**Decisão:** Sem splash screen com logo pulsando. O app mostra skeleton estrutural imediatamente ao carregar.
**Motivo:** Gemini e ChatGPT argumentaram que splash screens demoradas violam "profundidade sutil, não enfeite" — o usuário quer ver dados, não logo. React+Vite carrega em milissegundos quando bem configurado.
**Alternativas descartadas:** Splash com âncora pulsando em loop de 1.5s.

## ADR-011: Escala de animação restrita a 3 valores
**Decisão:** 120ms / 180ms / 240ms. Sem exceções.
**Motivo:** Múltiplas durações diferentes espalhadas pelo sistema (100, 150, 200, 250, 300) são impossíveis de manter consistentes. 3 valores fixos geram consistência automática.
**Alternativas descartadas:** Escala de 6+ valores de duração.

---

## RESPONSABILIDADE ARQUITETURAL POR SERVICE (OWNERSHIP)

Cada service é "dono" de uma responsabilidade. Não misturar.

| Service | Responsável por | NUNCA faz |
|---|---|---|
| `documents_service` | CRUD de documentos, upload/confirm, preview URL, metadados, soft delete, restore | OCR, permissões, busca |
| `folders_service` | CRUD de pastas, move com ltree, templates de pasta | Permissões, documentos |
| `storage_service` | Presigned URLs (upload/preview), HEAD request, interação com R2 | Metadados, banco |
| `ocr_service` | Pipeline de OCR (Tesseract), pré-processamento de imagem, interface OCRProvider | Documentos (só recebe document_id) |
| `search_service` | Full-text search, normalização de query, ts_headline | OCR, storage |
| `permission_service` | Equivalente Python de user_has_access para UX/validação prévia | Autorização real (isso é RLS) |
| `activity_service` | Inserção em activity_log, export CSV, derivar "pastas frequentes" | Nunca edita/deleta logs |

---

## ITENS DELIBERADAMENTE DESCARTADOS (não implementar)

| Item | Motivo |
|---|---|
| Versionamento de documentos na v1 | Exige redesenho de schema (ver ADR-008) |
| Integração com sistemas contábeis/SPED | Escopo de integração externa, prematuro |
| Upload via e-mail (inbound email) | Complexidade de infra desproporcional |
| Modo compacto/toggle de densidade de tabela | Duplicaria testes visuais, v2 |
| Compartilhamento externo (link público/senha) | v2 |
| Workflow de aprovação | Fora do propósito — Docke organiza, não orquestra |
| App nativo iOS/Android | PWA em v2+ se necessário |
| Splash screen com animação de logo | Ver ADR-010 |
| Glassmorphism em tabelas/listagens | Só em overlays de modais e Task Center |
| Parallax, neon, gradientes extras | Viola "profundidade sutil, não enfeite" |

---

## LIMITAÇÕES CONHECIDAS DA V1 (não são bugs)

| Limitação | Contexto |
|---|---|
| Seletor de empresa com 10+ itens pode precisar de busca interna | Volume inicial é 3 empresas |
| Árvore com 6+ níveis de profundidade pode ter UX degradada | Recomendação é até 4 níveis |
| Pasta com 500+ documentos sem paginação otimizada | Paginação de 50 itens cobre o volume real |
| OCR (Tesseract) tem qualidade irregular em scans de baixa qualidade | Pré-processamento (deskew/binarização) mitiga parcialmente |
| Preview de XML mostra texto bruto (sem parsing fiscal) | Preview renderizado de XML fiscal é v1.1, alta prioridade |

---
*Fim das decisões de arquitetura. Consultar antes de propor mudanças estruturais.*
