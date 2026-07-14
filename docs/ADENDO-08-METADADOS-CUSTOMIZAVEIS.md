# ADENDO 08 — Metadados Personalizados (campos customizáveis)

> **Status:** Proposta para revisão · **Depende de:** modelo de permissões atual
> (papéis + concessões por pasta, já implementado) e do resolvedor `ltree`
> (`permission_service.py` / RLS `user_has_access`).
> **Não inicia código antes da aprovação do Alyssom.**

---

## 1. Objetivo

Permitir que cada empresa defina **campos de metadados próprios** (data, razão
social, competência, CPF/CNPJ, instituição financeira, etc.), aplique esses
campos **nas pastas que quiser** (com herança para subpastas), marque alguns como
**obrigatórios**, e use esses campos como **colunas** (ordenar/filtrar) na tabela
de Documentos — inspirado no GED Arquivar e no Explorer do Windows.

Três camadas independentes, como no Arquivar:

1. **Catálogo** — onde se *criam* os campos (tipados).
2. **Aplicação na árvore** — onde se *penduram* os campos nas pastas.
3. **Preenchimento** — no upload/edição do documento, os campos aplicados àquela
   pasta aparecem para preencher.

---

## 2. Modelo de dados

Três tabelas novas, todas com `company_id` (isolamento por RLS, Invariante de
multi-tenant).

### 2.1 `custom_field` — catálogo (definição)

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid FK | isolamento |
| `label` | text | nome exibido ("Competência", "Razão Social") |
| `field_key` | text | slug estável para a coluna (`competencia`) |
| `type` | enum | ver §3 |
| `format_config` | jsonb | opções do tipo (casas decimais, lista de seleção, formato de data) |
| `created_by` | uuid | auditoria |
| `created_at` | timestamptz | |
| `archived_at` | timestamptz null | soft-delete (não apaga valores já preenchidos) |

Único: `(company_id, field_key)`.

### 2.2 `folder_field` — aplicação (na árvore)

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid FK | |
| `folder_path` | ltree null | **null = empresa toda** (raiz); senão o path da pasta |
| `custom_field_id` | uuid FK | |
| `mode` | enum `apply`/`exclude` | `exclude` = "tombstone" para cancelar herança numa subpasta |
| `required` | bool | **obrigatório vs opcional** — escolha por pasta (§4); default `false` |
| `display_order` | int | ordem da coluna |
| `column_width` | int null | largura da coluna, em px. `null` = usa a largura mínima calculada
  (§5.6) até o usuário redimensionar manualmente uma vez |
| `created_at` | timestamptz | |

### 2.3 `document_field_value` — valores preenchidos

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `company_id` | uuid FK | |
| `document_id` | uuid FK | |
| `custom_field_id` | uuid FK | |
| `value_text` | text | armazenamento canônico (sempre preenchido) |
| `value_date` | date null | sombra indexável p/ `data` e `competência` (dia 01) |
| `value_number` | numeric null | sombra indexável p/ `número` |
| `updated_at` | timestamptz | |

Único: `(document_id, custom_field_id)`.
As colunas-sombra existem só para **ordenar/filtrar** com índice; a exibição usa
sempre o `value_text` formatado.

---

## 3. Tipos de campo (MVP aprovado)

| Tipo | Formato/validação | Armazenamento sombra |
|---|---|---|
| `texto` | livre | — |
| `cpf` | 11 dígitos, máscara `000.000.000-00` | — |
| `cnpj` | 14 dígitos, máscara `00.000.000/0000-00` | — |
| `data` | `dd/mm/aaaa` | `value_date` |
| `competencia` | `mm/aaaa` (mês/ano) | `value_date` (dia 01) |
| `numero` | casas decimais configuráveis (`format_config.decimals`) | `value_number` |
| `selecao` | lista de opções em `format_config.options[]` (single) | — |

> Multi-seleção, moeda e outros tipos ficam para uma iteração futura — não
> bloqueiam o MVP.

---

## 4. Herança na árvore (regra confirmada)

Idêntica à das permissões (reusa a lógica `ltree` "ancestral mais profundo
vence"):

- Um `folder_field` aplicado numa pasta **cascateia para todas as subpastas**.
- Uma subpasta pode **sobrescrever**: redeclarar o campo com `required`/ordem
  diferentes, ou marcá-lo como `exclude` para removê-lo só naquele ramo.
- **Resolução para uma pasta-alvo:** juntam-se todos os `folder_field` cujo
  `folder_path` é ancestral-ou-igual ao alvo; para cada `custom_field`, vence a
  linha do path **mais profundo**. Se a vencedora for `exclude`, o campo não
  aparece.

Isso reaproveita `_is_ancestor_or_equal` / `_depth` que já existem — metadados e
permissões ficam consistentes.

---

## 5. Telas

### 5.1 Configurações → Metadados · aba "Campos" (catálogo)
- Tabela dos campos da empresa (label, tipo, formato).
- Criar/editar campo: modal com label, tipo, e config do formato (ex.: opções da
  seleção, casas decimais).
- Arquivar campo (soft-delete): some das colunas, mas mantém valores históricos.

### 5.2 Configurações → Metadados · aba "Aplicação" (árvore)
- Árvore de pastas (reusa `FolderTree`) à esquerda.
- Ao selecionar uma pasta: painel com os campos **herdados** (marcados como tal,
  read-only com botão "sobrescrever aqui") e os **aplicados diretamente**.
- Para cada campo aplicado: toggle `obrigatório`, ordem, largura; e ação
  `remover neste ramo` (cria `exclude`).

### 5.3 Cópia entre empresas
- Botão "Copiar campos de outra empresa" no catálogo → duplica as definições de
  `custom_field` da empresa escolhida.
- **A aplicação na árvore não é copiada** (estruturas de pastas diferem entre
  empresas); só o catálogo. A aplicação é refeita na empresa destino.

### 5.4 Upload / edição de documento
- O formulário renderiza dinamicamente os campos **resolvidos para a pasta
  destino** (§4).
- Validação: obrigatórios bloqueiam a confirmação; cada tipo valida o formato.
- Ao editar um documento existente, os mesmos campos aparecem para ajuste.

### 5.5 Tabela de Documentos (integra com a "casca Finder" da Fase 1)
- Os campos aplicados viram **colunas**, respeitando ordem/largura e o
  mostrar/esconder colunas (menu de cabeçalho estilo Explorer).
- Ordenar por coluna de metadado usa as colunas-sombra (`value_date`,
  `value_number`) ou `value_text`.

### 5.6 Redimensionamento de coluna (estilo Excel)
- Cada coluna tem uma **largura mínima calculada** por tipo de dado (ex.: CPF
  cabe em ~110px, data em ~90px, texto livre num mínimo maior) — dado nunca
  aparece cortado por padrão.
- **Arrastar a borda** da coluna redimensiona livremente (para mais largo ou
  mais estreito, até o mínimo do tipo — não deixa cortar à força).
- **Duplo clique na borda** faz autofit: ajusta a largura ao conteúdo mais
  largo visível na página, igual ao Excel.
- A largura ajustada manualmente persiste em `folder_field.column_width`; sem
  ajuste manual, usa a largura mínima calculada.

---

## 6. Permissões (sem reescrita — usa o que já existe)

- **Gerenciar catálogo e aplicação:** `admin` ou `supremo` (capacidade já
  disponível hoje). Operador/visualizador **não** configuram.
- **Preencher valores:** quem já pode subir/editar documento naquela pasta
  (operador+), respeitando as concessões por pasta atuais.
- Nenhuma nova tabela de permissão; nenhuma mudança no modelo de papéis.

---

## 7. Ordem de implementação (milestones)

| # | Escopo | Camada |
|---|---|---|
| **M-A** | Migration (3 tabelas) + RLS por `company_id` + resolvedor de campos (reusa ltree) | Backend |
| **M-B** | Endpoints CRUD do catálogo | Backend |
| **M-C** | Endpoints de aplicação na árvore (apply/exclude/required/ordem) + leitura resolvida por pasta | Backend |
| **M-D** | Leitura/escrita de `document_field_value` (no confirm do upload e na edição) + validação de obrigatórios/formato | Backend |
| **M-E** | Tela catálogo (Configurações → Metadados · Campos) | Frontend |
| **M-F** | Tela aplicação na árvore | Frontend |
| **M-G** | Campos dinâmicos no upload/edição | Frontend |
| **M-H** | Colunas de metadados na tabela (depende da casca Finder / show-hide colunas) | Frontend |
| **M-I** | Cópia entre empresas | Full-stack |
| **M-J** | Testes: isolamento por empresa, herança/override, obrigatórios | QA |

> Sugestão: fechar **M-A → M-D** (backend) primeiro num deploy, validar por API,
> e só então as telas. Evita retrabalho de UI sobre contrato instável (mesma
> cadência de "testar em milestones" que já usamos).

---

## 8. Decisões — FECHADAS (aprovadas por Alyssom em 2026-07-10)

1. **Campo aplicado na raiz (empresa toda):** ✅ sim, `folder_path = null` vale
   para toda a empresa.
2. **Redimensionamento de coluna:** ✅ largura mínima por tipo (dado nunca corta
   por padrão) + arrastar borda / duplo-clique autofit, estilo Excel — ver §5.6.
   Casas decimais do tipo `número` seguem fixas por campo (`format_config.decimals`)
   como recomendado.
3. **Validação de CPF/CNPJ:** ✅ com dígito verificador.
4. **Competência:** ✅ guardada como data (dia 01) para ordenar.
5. **Documentos já existentes** quando surge um campo obrigatório novo: ✅ ficam
   "pendentes" com aviso, sem travar o acervo antigo.
6. **Obrigatório vs opcional é por pasta** (não é uma propriedade fixa do
   campo): o mesmo `custom_field` pode ser obrigatório na pasta A e opcional na
   pasta B — já modelado em `folder_field.required` (§2.2) e escolhido na tela
   de aplicação (§5.2).

**Escopo travado. Iniciando implementação pelo backend (M-A).**

---

## 9. Impacto e riscos

- **Isolamento:** as 3 tabelas entram no RLS por `company_id` — cobrir no teste
  de isolamento entre empresas (obrigatório antes de fechar).
- **Performance:** colunas-sombra + índices em `value_date`/`value_number`
  mantêm ordenação/filtro rápidos mesmo com muitos documentos.
- **Escopo:** feature bem delimitada; **não** toca em permissões nem no OCR.
- **Dependência de UI:** a exibição como coluna (M-H) depende da "casca Finder"
  (Fase 1) estar pronta para o menu de mostrar/esconder colunas — as duas podem
  andar em paralelo, mas M-H fecha depois da Fase 1.

---

## 10. Relação com a Fase 1 (casca Finder)

Esta feature (Fase 2) assume que a Fase 1 — sidebar de pastas, view switcher,
path bar e menu de colunas estilo Explorer — será feita antes ou em paralelo,
pois é ela que dá o "chassi" onde as colunas de metadados aparecem. A Fase 1 é
só frontend e de baixo risco; esta Fase 2 é o projeto de fundo (backend + UI).
