# Docke — Adendo 01: Correções e Lacunas Pós-v1

> Este documento complementa `06-DESIGN-SYSTEM.md` e `02-DECISOES-ARQUITETURA.md`.
> Não substitui nenhum dos dois — adiciona o que ficou faltando na primeira rodada
> de planejamento, identificado após teste real da v1 em produção.

---

## ADR-014 — Gerenciamento de Organizações/Empresas

**Contexto:** O Design System original especificou o *Seletor de empresa* (trocar
entre empresas já existentes) mas nunca especificou a tela de *gerenciar* empresas
(criar, editar, listar). Isso nunca foi implementado porque nunca foi desenhado.

**Decisão:** Nova seção em Configurações: **Organização**.

### Escopo

- Nova rota: `/settings/organization`
- Visível apenas para usuários **supremo** (criação/edição/exclusão de empresa) e
  **admin** (apenas visualização + edição de dados básicos da empresa que administra)
- Tabela `companies` já existe no schema atual (usada pelo seletor) — esta tela
  passa a fazer CRUD completo sobre ela

### Wireframe verbal

1. **Lista de empresas** (estilo tabela, reaproveitando componente `Table` do DS):
   Nome, CNPJ, nº de documentos, nº de usuários vinculados, ação (editar/desativar)
2. Botão primário "Nova empresa" (canto superior direito, mesmo padrão visual do
   botão "Upload" na tela de Documentos)
3. **Modal de criar/editar empresa** (max-width 560px, conforme padrão de modal do DS):
   - Nome (obrigatório)
   - CNPJ (obrigatório, com máscara e validação)
   - Logo da empresa (upload opcional — usado futuramente em `configRelatorio.logo`,
     já previsto no backlog do Fuel Mind, mesmo padrão aqui)
   - Toggle "Empresa ativa"
4. **Desativar empresa** (não excluir — soft state) usa o modal de confirmação
   **Médio** já especificado no DS (botão Danger, foco em Cancelar)
5. Empty state (nenhuma empresa cadastrada além da atual) reaproveita o padrão
   visual dos empty states já definidos — ícone `building-2` + âncora

### Efeito colateral esperado
- O Seletor de empresa (top bar) passa a refletir criação/edição em tempo real
- `is_single_company_mode` (mencionado no DS) deixa de fazer sentido como flag fixa —
  passa a ser calculado dinamicamente (`companies.count === 1`)

---

## ADR-015 — Expansão da área de Configurações

**Contexto:** Configurações hoje só tem "Perfil". Nunca especificamos o restante.

**Decisão:** Estrutura de Configurações com navegação lateral interna (sub-sidebar
ou tabs, à escolha do Claude Code respeitando o padrão de navegação já usado em
outras telas com sub-seções):

| Seção | Conteúdo | Visibilidade |
|---|---|---|
| Perfil | Já existe — nome, username | Todos |
| Organização | ADR-014 acima | Admin/Supremo |
| Usuários & Papéis | Lista de usuários da empresa ativa, papel (visualizador/auditor/admin/supremo), convite por e-mail, remoção de acesso | Admin/Supremo |
| Segurança | Troca de senha (senha atual + nova + confirmação) | Todos |
| Preferências | Tema (claro/escuro/sistema), densidade de tabela (quando v2 estiver pronto) | Todos |
| Retenção | Dias na lixeira antes de exclusão automática, limite de versões por documento (quando v2 estiver pronto) | Supremo |

**Nota:** "Retenção" só entra quando o v2 (versionamento + lixeira configurável)
for implementado — por enquanto criar a seção vazia ou ocultá-la é aceitável.

---

## Correção 01 — Ícone de favoritar deve ser sempre âncora, nunca estrela

**Problema encontrado:** O painel de Detalhes do documento usa ícone de estrela
genérico no botão "Favoritar". O DS especifica claramente que a ação de favoritar
usa o ícone de âncora (ver seção "Tabela de documentos" do Design System).

**Correção:** Substituir TODOS os ícones de favoritar no projeto — tabela, painel
de detalhes, preview, qualquer lugar futuro — pelo ícone de âncora consistente com
a identidade de marca (mesma âncora do logo, não o Lucide `star`).

**Nota para o Design System:** Adicionar esta regra explicitamente na seção de
Iconografia para eliminar ambiguidade futura:

> "Favoritar" usa SEMPRE o glifo de âncora da marca (nunca `star` do Lucide ou
> qualquer ícone de estrela), em qualquer componente onde a ação aparecer:
> tabela (hover), painel de detalhes, preview de documento, listagens futuras.

---

## Correção 02 — Task Center sem indicação do que é

**Problema encontrado:** Ícone na top bar (lista/atividade) não tem tooltip nem
aria-label visível — usuário não sabe pra que serve até clicar.

**Correção:**
- Adicionar `aria-label="Central de tarefas"` (já exigido pelo DS na seção de
  Acessibilidade, mas não foi implementado)
- Adicionar tooltip nativo (title ou componente de tooltip do projeto) ao passar
  o mouse: texto "Central de tarefas — acompanhe uploads e processamentos"
- Opcional, mas recomendado: na primeira sessão de um novo usuário, mostrar um
  ponto de destaque (dot indicator) sutil no ícone até o usuário abrir o Task
  Center pela primeira vez

---

## Correção 03 — Preview de documento com renderização quebrada

**Problema encontrado (com evidência visual):** Ao abrir o preview de um
documento a partir do painel de Detalhes, a interface renderiza de forma
sobreposta e duplicada — aparece uma segunda top bar dentro do modal, um badge
"Salvar" flutuando fora de contexto, e conteúdo do painel de Detalhes visível
por trás do modal de preview.

**Diagnóstico provável:** Dois componentes de preview/modal sendo montados
simultaneamente, ou estado de "modal aberto" não sendo isolado corretamente
(z-index e/ou controle de estado de exibição conflitando).

**Ação para o Claude Code:**
1. Revisar o componente responsável por abrir o preview a partir do botão
   "Visualizar" no painel de Detalhes
2. Confirmar que apenas UM modal de preview pode estar montado no DOM por vez
3. Confirmar que o modal de preview segue a especificação do DS: overlay
   `rgba(0,0,0,0.5)`, max-width 90vw, animação fade+scale (240ms), focus trap
4. Testar especificamente o fluxo: Documentos → clicar em documento → painel de
   Detalhes abre → clicar "Visualizar" → preview deve abrir LIMPO, sem
   sobreposição do painel de Detalhes por trás

> **Nota da investigação (Claude Code, 2026-07-01):** causa raiz identificada —
> `.page-enter` (tokens.css) usa `animation-fill-mode: both`, que deixa
> `transform: translateY(0)` computado persistente após os 180ms da animação.
> Um `transform` diferente de `none`, mesmo sem efeito visual, torna o elemento
> um *containing block* para descendentes `position: fixed` (spec CSS). Como
> `.page-enter` envolve o conteúdo de cada página dentro do `<main>`, todo modal
> fixed passa a ser contido pela caixa do `.page-enter` em vez do viewport real.
> Na tela de Documentos, que usa `-m-6` para cancelar o padding do `<main>`, isso
> deixa uma fresta visível à direita do modal onde o painel de Detalhes (que
> também usa esse espaço expandido) permanece visível. A imagem de teste usada
> nesse dia (mockup gerado por IA) também continha, nos próprios pixels, um
> dashboard falso — o que tornou o sintoma mais confuso de diagnosticar à primeira
> vista, mas o vazamento do painel de Detalhes pela borda é um bug real e
> independente do conteúdo da imagem. Corrigido removendo o fill-mode persistente.

---

## Ordem de execução sugerida

1. Correção 03 (bug crítico, bloqueia uso real) — prioridade máxima
2. Correção 01 (rápida, baixo risco)
3. Correção 02 (rápida, baixo risco)
4. ADR-014 (Organização) — feature nova, maior escopo
5. ADR-015 (Configurações) — depende parcialmente do ADR-014

---
*Este adendo deve ser lido junto com `06-DESIGN-SYSTEM.md` e `02-DECISOES-ARQUITETURA.md`.
Qualquer conflito, o Design System principal prevalece exceto onde este documento
explicitamente o atualiza (ver Correção 01).*
