# Docke — Adendo 06: Gaps Finais do Planejamento

> Fecha os pontos identificados na auditoria completa do planejamento
> pós-v1. Migração de dados foi descartada como gap (não há documentos
> reais em produção — o schema v2 nasce como schema principal).

---

## ADR-033 — Criação Direta de Usuários (substitui convite por e-mail no ADR-015)

**Decisão:** não existe fluxo de convite por e-mail. Admin/supremo cadastra
usuários diretamente na área Usuários & Papéis — define nome, username,
senha inicial (ou gera uma temporária) e papel. O próprio usuário pode
trocar a senha depois, em Configurações → Segurança (já especificado).

**Efeito:** remove a dependência de infraestrutura de e-mail transacional
para este fluxo — ela só voltará a ser necessária se/quando notificação por
e-mail (v3) for implementada.

---

## ADR-034 — Busca Indexa Apenas a Versão Atual do Documento

**Decisão:** o índice de busca (full-text search + conteúdo OCR) reflete
sempre a **versão atual** de cada documento — versões antigas não aparecem
em resultados de busca, mesmo que o texto delas seja diferente.

**Justificativa:** buscar em todas as versões duplicaria resultados
(mesmo documento aparecendo várias vezes) e prejudicaria a relevância. Se
o usuário precisa localizar conteúdo de uma versão antiga especificamente,
ele acessa o histórico de versões do documento já aberto — não é um caso
de busca geral.

**Implementação:** ao criar nova versão, o índice de busca é atualizado
para refletir o conteúdo da nova versão (substitui, não acumula).

---

## ADR-035 — Preview de Contexto nos Resultados de Busca (OCR)

**Problema:** hoje a busca mostra só o nome do arquivo. Quando o match
vem do conteúdo OCR (não do nome), o usuário não tem como saber, sem abrir
o documento, se aquele é realmente o arquivo que procura.

**Decisão:** quando o resultado de busca vier de match no conteúdo OCR
(não no nome do arquivo), exibir um **trecho de contexto** abaixo do nome
— um snippet de texto ao redor da palavra encontrada, com o termo
buscado destacado (negrito/cor), similar ao resultado de um buscador
convencional.

### Implementação técnica
PostgreSQL já tem a ferramenta certa para isso nativamente — a função
`ts_headline()` gera automaticamente um trecho de texto com o termo de
busca destacado a partir de uma coluna indexada por full-text search.
Não é necessário armazenar posição/coordenadas do texto na página do
documento — só o texto extraído do OCR já indexado.

```sql
SELECT ts_headline(
  'portuguese',
  documents.ocr_text,
  plainto_tsquery('portuguese', :termo_busca),
  'StartSel=<mark>, StopSel=</mark>, MaxWords=25, MinWords=15'
) AS snippet
FROM documents
WHERE ...
```

### UI
```
📄 NF-e Maio 2026.pdf
   Posto Rosário · Fiscal
   "...valor total da nota de <mark>R$ 4.230,00</mark> referente ao
   fornecimento de..."
```
- Snippet só aparece quando o match vem do conteúdo OCR — se o match for
  só no nome do arquivo, não mostra snippet (evita ruído sem propósito)
- Snippet limitado a ~20-25 palavras ao redor do termo, para não
  transformar o resultado de busca em bloco de texto longo

### Fora de escopo nesta rodada (registrar como ideia futura)
Destacar visualmente a posição do texto **dentro da imagem/PDF** (ex: um
recorte da página mostrando onde o texto aparece, com caixa desenhada em
volta) exigiria capturar coordenadas de bounding box por palavra durante o
OCR — dado que hoje não é armazenado. Tecnicamente possível (a maioria dos
motores de OCR devolve isso), mas é escopo maior. Fica registrado como
melhoria de v3, não bloqueia o v2.

---

## ADR-036 — Matriz de Permissões Completa

**Papéis existentes:** `visualizador`, `auditor`, `admin`, `supremo`
(já nomeados na v1, nunca antes consolidados numa matriz única).

| Ação | Visualizador | Auditor | Admin | Supremo |
|---|:---:|:---:|:---:|:---:|
| Ver documentos da empresa | ✅ | ✅ | ✅ | ✅ |
| Upload de documento | ❌ | ✅ | ✅ | ✅ |
| Mover / renomear documento | ❌ | ✅ | ✅ | ✅ |
| Enviar para lixeira | ❌ | ✅ | ✅ | ✅ |
| Restaurar da lixeira | ❌ | ✅ | ✅ | ✅ |
| Excluir permanentemente (fora do ciclo automático) | ❌ | ❌ | ✅ | ✅ |
| Gerar link de compartilhamento externo | ✅ | ✅ | ✅ | ✅ |
| Revogar link próprio | ✅ | ✅ | ✅ | ✅ |
| Revogar link de outro usuário | ❌ | ❌ | ✅ | ✅ |
| Upload de nova versão | ❌ | ✅ | ✅ | ✅ |
| Restaurar versão antiga | ❌ | ✅ | ✅ | ✅ |
| Ver log de atividade da empresa | ❌ | ✅ (leitura) | ✅ | ✅ |
| Configurar limite de versões | ❌ | ❌ | ❌ | ✅ |
| Configurar retenção de lixeira | ❌ | ❌ | ❌ | ✅ |
| Ver dados da própria empresa (Organização) | ❌ | ❌ | ✅ | ✅ |
| Criar / editar empresa | ❌ | ❌ | ❌ | ✅ |
| Desativar empresa | ❌ | ❌ | ❌ | ✅ |
| Criar / editar usuário | ❌ | ❌ | ✅ | ✅ |
| Definir papel de usuário até "admin" | ❌ | ❌ | ✅ | ✅ |
| Definir papel de usuário "supremo" | ❌ | ❌ | ❌ | ✅ |
| Trocar tema / preferências pessoais | ✅ | ✅ | ✅ | ✅ |

**Regra de implementação:** esta tabela vira a fonte única de verdade para
checagem de permissão no backend — cada endpoint deve referenciar uma
linha específica desta matriz, não decisão ad-hoc por tela.

---

## ADR-037 — Isolamento de Dados Entre Empresas

**Decisão:** toda tabela que guarda dado pertencente a uma empresa
(`documents`, `folders`, `shares`, `document_versions` via `documents`,
`notifications`, `activity_log`) tem coluna `company_id` obrigatória
(NOT NULL, com índice).

**Duas camadas de proteção, não uma:**
1. **Camada de aplicação:** toda query passa pelo filtro de `company_id`
   da empresa ativa na sessão do usuário — nunca uma query sem esse filtro
2. **Camada de banco (defesa em profundidade):** Row-Level Security (RLS)
   do PostgreSQL como segunda barreira, caso a camada de aplicação falhe
   por erro de programação:
```sql
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_isolation ON documents
  USING (company_id = current_setting('app.current_company_id')::uuid);
```
A aplicação define `app.current_company_id` no início de cada
sessão/transação, a partir da empresa ativa do usuário autenticado.

**Por que duas camadas:** um bug isolado na camada de aplicação (uma
query esquecendo o filtro) hoje vazaria dado de uma empresa para outra
sem nenhum aviso. Com RLS, o próprio banco recusa a linha mesmo que a
aplicação erre — é a rede de segurança.

---

## ADR-038 — Política de Backup e Recuperação

**Banco de dados (PostgreSQL):**
- Backup completo diário automatizado
- WAL archiving contínuo para recuperação em ponto no tempo (point-in-time
  recovery) — permite restaurar para qualquer momento dos últimos 7 dias,
  não só o snapshot diário
- Retenção de backups: 30 dias
- Backups armazenados em região/conta diferente do banco principal

**Storage de arquivos (Cloudflare R2):**
- Versionamento de objeto habilitado no bucket (proteção contra
  sobrescrita/exclusão acidental em nível de infraestrutura, independente
  do versionamento de documento do ADR-024)
- Retenção de objetos deletados: alinhada com a política de retenção de
  lixeira já definida (ADR-030)

**Teste de restauração:**
- Restauração de backup testada a cada trimestre, não só configurada e
  esquecida — backup nunca testado é backup que não existe de fato

**Fora de escopo nesta rodada:** réplica geográfica ativa (multi-região)
— justificável só se/quando o volume de uso justificar o custo adicional.

---

## Referência

Este documento fecha a auditoria completa de gaps do planejamento
pós-v1, junto com os Adendos 01-05. Próximo passo: rodada de validação
cruzada nos itens técnicos mais sensíveis (matriz de permissões,
isolamento de dados, backup, e a abordagem de snippet de busca).
