# Docke — Design System
> Fonte de verdade para toda decisão visual. O Claude Code consulta este documento
> sempre que criar ou modificar componentes de interface.

---

## PRINCÍPIOS VISUAIS (derivam todas as decisões abaixo)

1. **Movimento nunca compete com conteúdo.** Animações existem para feedback e orientação, não para impressionar.
2. **Hierarquia sempre vence decoração.** Se algo precisa de destaque, use contraste e posição, não efeitos empilhados.
3. **Um elemento só chama atenção se exigir ação.** Elementos informativos são neutros; CTAs são vivos.
4. **Estados diferentes mudam primeiro por contraste, depois por cor.** Nunca usar duas técnicas de destaque simultaneamente (cor + glow + animação).
5. **Espaço em branco é informação, não desperdício.** Não preencher cada pixel.
6. **O usuário nunca precisa interpretar se algo é clicável.** Affordance deve ser óbvia.
7. **Tolerância zero a layout shift.** Containers de ícones e botões devem ter tamanho fixo (ex: `w-5 h-5`), para que a troca de estado (ícone → spinner) não afete o fluxo do DOM.

---

## COR

### Primária (Teal Docke)
| Token | Hex | Uso |
|---|---|---|
| teal-50 | #E6F5F2 | Backgrounds sutis, hover de linhas, seleção na árvore |
| teal-100 | #B3E5D8 | Itens selecionados |
| teal-200 | #7DD4C0 | Bordas de foco |
| teal-400 | #3FBFA8 | Cor primária no dark mode, links, badges |
| teal-500 | #15A18E | Hover de botões primários |
| teal-600 | #0B8578 | Cor primária light mode — botões, links, ícones ativos |
| teal-700 | #086B61 | Active/pressed |
| teal-800 | #054F48 | Texto sobre fundo teal claro |
| teal-900 | #033530 | Texto sobre fundo teal médio |

**Regra:** Teal é reservado para ações positivas (favoritar, upload, links, CTAs). Nunca para elementos neutros ou decorativos.

### Light mode
| Token | Hex | Uso |
|---|---|---|
| bg-page | #F8F9FA | Background da página (body) |
| bg-card | #FFFFFF | Cards, modais, inputs |
| bg-hover | #F1F3F5 | Hover sutil |
| border-default | #E9ECEF | Bordas padrão, divisores |
| text-primary | #212529 | Títulos, corpo |
| text-secondary | #595F66 | Labels, descrições |
| text-tertiary | #6C757D | Timestamps, hints |
| text-placeholder | #ADB5BD | Placeholders, ícones inativos |

### Dark mode (preto neutro, nunca azulado)
| Token | Hex | Uso |
|---|---|---|
| bg-page | #111111 | Background da página |
| bg-card | #1A1A1A | Cards, modais |
| bg-elevated | #222222 | Dropdowns, popovers |
| border-default | #2A2A2A | Bordas padrão |
| text-primary | #F0F0F0 | Texto principal |
| text-secondary | #A0A0A0 | Labels, descrições (contraste ≥4.5:1 garantido) |
| text-tertiary | #707070 | Hints (contraste ≥4.5:1 garantido) |

### Estados semânticos (variantes light / dark)
| Estado | Background | Texto/ícone | Uso |
|---|---|---|---|
| Sucesso | #ECFDF5 / #052E1C | #065F46 / #6EE7B7 | Upload ok, OCR concluído |
| Erro | #FEF2F2 / #3B0A0A | #991B1B / #FCA5A5 | Falha, OCR falhou |
| Aviso | #FFFBEB / #3B2504 | #92400E / #FCD34D | Espaço acabando, expiração |
| Info | #EFF6FF / #0C2340 | #1E40AF / #93C5FD | Dicas, informações gerais |

### Cores por tipo de arquivo (ícones)
| Tipo | Cor | Background do ícone |
|---|---|---|
| PDF | #DC2626 | #FEE2E2 |
| Planilha | #059669 | #ECFDF5 |
| Documento | #2563EB | #EFF6FF |
| XML | #7C3AED | #F3E8FF |
| Imagem | #D97706 | #FEF3C7 |
| Outros | #6B7280 | #F3F4F6 |

---

## TIPOGRAFIA

| Função | Font | Fallback |
|---|---|---|
| Interface (headings + body) | Inter | -apple-system, sans-serif |
| Dados técnicos (hash, paths) | JetBrains Mono | 'Consolas', monospace |

| Token | Tamanho | Peso | Uso |
|---|---|---|---|
| text-xs | 12px | 400 | Badges, micro-labels |
| text-sm | 13px | 400 | Labels, timestamps |
| text-base | 14px | 400 | Corpo, células de tabela |
| text-lg | 16px | 500 | Subtítulos de seção |
| text-xl | 18px | 600 | Títulos de página |
| text-2xl | 24px | 600 | Números em stat cards |
| text-3xl | 30px | 600 | Título da landing page |

---

## ESPAÇAMENTO E RADIUS

**Espaçamento:** escala de 4px → 4/8/12/16/20/24/32/40/48/64

**Border-radius:** 4px (badges) / 8px (botões, inputs) / 12px (cards, modais) / 16px (stat cards, containers) / 9999px (avatares, pills)

**Sombras:** sem sombra por padrão (usar bordas). Sombras apenas em: hover de cards (`0 4px 12px rgba(0,0,0,0.06)`), dropdowns (`0 4px 16px rgba(0,0,0,0.1)`), modais (`0 8px 24px rgba(0,0,0,0.12)`), drag float (`0 12px 36px rgba(0,0,0,0.16)`). No dark mode, multiplicar opacidade por 2.5.

---

## ANIMAÇÕES

### Escala de duração (3 valores fixos, sem exceção)
| Token | Valor | Uso |
|---|---|---|
| duration-fast | 120ms | Hover, focus, feedback de clique |
| duration-normal | 180ms | Dropdowns, crossfade de página, transição de tema |
| duration-slow | 240ms | Modais, drawers, toast entrando/saindo |

**Easing padrão:** `cubic-bezier(0.4, 0, 0.2, 1)` para tudo.

### Transição entre páginas (rotas SPA)
- Elemento que sai: fade-out (opacidade 1→0) em 120ms, sem movimento.
- Elemento que entra: fade-in (0→1) + slide-up (`translateY(4px)→0`) em 180ms.
- Apenas o container `<main>` anima. Sidebar e top bar permanecem estáticas.
- Paginação, filtros, ordenação e troca de empresa NÃO disparam esta animação.

### Transição de tema (light ↔ dark)
- `transition: background-color 180ms, color 180ms, border-color 180ms, box-shadow 180ms` no root.
- Nunca animar layout, largura, altura, posição ou tipografia na troca de tema.

### Animação de marca: "Anchor Drop" (APENAS ao favoritar)
1. Âncora sobe 2px (`translateY(-2px)`) em 80ms.
2. Desce com overshoot (`translateY(4px)→0`) em 200ms, easing `cubic-bezier(0.34, 1.56, 0.64, 1)`.
3. Cor muda de outline (cinza) para preenchida (teal) simultaneamente ao passo 2.
4. Usar SOMENTE ao favoritar documento/pasta. Nunca em desfavoritar (só reverter cor), upload, login, ou navegação.

### prefers-reduced-motion
Quando ativo no sistema do usuário, TODAS as animações são substituídas por transições de opacidade ≤50ms ou removidas completamente. O Anchor Drop vira uma mudança de cor instantânea.

---

## COMPONENTES

### Botões
| Variante | Fundo | Texto | Uso |
|---|---|---|---|
| Primário | teal-600 | white | Ação principal (Upload, Salvar) |
| Secundário | transparent | text-primary | Cancelar, Filtrar (borda border-default) |
| Ghost | transparent | text-secondary | Ações terciárias (Ver mais, Limpar) |
| Danger | #DC2626 | white | Excluir permanentemente |
| Icon-only | transparent | text-placeholder | Menu 3 pontos, download |

Estados: hover (fundo 10% mais escuro, 120ms) → active (scale 0.97) → disabled (opacity 0.5) → loading (spinner substituindo texto, botão desabilitado).

### Tabela de documentos
- Colunas: checkbox, ícone+nome, tamanho, data, empresa (se multi), responsável, ações (hover)
- Densidade padrão: linha ~48px, sem toggle na v1
- Hover: background bg-hover (120ms)
- Seleção: checkbox checked + linha com background teal-50
- Ações em hover: download, favoritar (âncora), menu (3 pontos)
- Barra de ações em lote: aparece com slide-down no topo da tabela ao selecionar 1+ itens
- Linha em processamento (durante move/delete assíncrono): opacidade 60%, ações desabilitadas, spinner no lugar do ícone de tipo

### Árvore de pastas (FolderTree)
- Componente ÚNICO reutilizável em: sidebar, modal "Mover para...", seletor de upload, tela de Permissões
- Props: `mode` (navigation | selection), `disabledNodeIds` (para mover — desabilitar pasta atual e descendentes), `showSearch` (busca interna)
- Indentação: 16px por nível. Profundidade recomendada: até 4 níveis
- Hover: background bg-hover (120ms). Selecionado: background teal-50, borda-left 2px teal-600
- Drag-over: anel teal 2px + fundo teal-50/20% na pasta-alvo. Se hover >800ms em pasta colapsada, expande automaticamente. Se usuário não tem permissão na pasta-alvo: borda vermelha sutil em vez de teal
- Contador de documentos ao lado do nome: "Fiscal (234)"

### Modais
- Overlay: rgba(0,0,0,0.5) light / rgba(0,0,0,0.7) dark
- Card: bg-card, radius-lg (12px), sombra de modal, padding 24px
- Animação: fade in overlay + scale 0.95→1.0 no card (240ms)
- Max-width: 400px (confirmação), 560px (formulários), 90vw (preview)
- Focus trap ativo. ESC fecha. Enter confirma (quando aplicável)

### Modal de confirmação destrutiva (3 níveis)
| Nível | Quando | UI |
|---|---|---|
| Baixo | Soft-delete, desfavoritar | Toast com "Desfazer" por 5s, sem modal |
| Médio | Exclusão permanente individual, revogar acesso | Modal com botão Danger ("Excluir permanentemente"), foco inicial em Cancelar |
| Alto | Exclusão permanente em lote, deletar empresa | Mesmo modal, mas exige digitar "CONFIRMAR" para habilitar o botão Danger |

Padrão de botões em TODOS os modais de confirmação: Cancelar à esquerda (secundário), ação à direita (primário ou danger). Foco inicial sempre em Cancelar.

### Toasts
- Posição: canto inferior direito. Respeitam drawers abertos (toast se posiciona à esquerda do drawer).
- Tipos: success (borda-left verde), error (borda-left vermelha), warning (borda-left âmbar), info (borda-left teal).
- Duração: 4s (info/success), 6s (error), persistente (ações pendentes — Task Center cuida disso).
- Animação: slide-in da direita (240ms), slide-out (180ms).
- Se houver múltiplos toasts simultâneos: fila FIFO, máximo 3 visíveis, contador "+N" para os restantes.
- Ações reversíveis (soft-delete, move, rename): toast com botão "Desfazer" por 5s.

### Task Center
- Ícone na top bar (estilo lista/atividade, Lucide `list-todo`), à direita da busca, antes do avatar.
- Badge numérico com contagem de tarefas ativas.
- Ao clicar: popover (não drawer) com lista de tarefas recentes e ativas.
- Cada item: ícone de tipo (upload, OCR, ZIP, export), nome, barra de progresso (determinada quando o progresso real é conhecido; indeterminada/shimmer quando não), status.
- Itens concluídos: check verde, persistem 10s, depois somem.
- Itens falhos: X vermelho, persistem até ação do usuário (retry ou dispensar).
- Este componente SUBSTITUI: widget de upload persistente e toasts de operação longa. Tudo que demora vive aqui.

### Empty states
- **Quantidade:** 4 ilustrações, cobrindo todos os contextos.
- **Composição:** até 3 ícones Lucide + traços simples em SVG, viewBox 120x120, padding 16px.
- **Cores:** elementos em `currentColor` (herdam cor de texto terciário), um detalhe único em teal-600.
- **Formato:** SVG inline, funcionam em ambos os temas sem duplicação.

| Contexto | Ícone(s) principal(is) | Título | CTA |
|---|---|---|---|
| Pasta vazia / nenhum documento | folder-open + âncora | "Nenhum documento aqui ainda." | "Arraste arquivos ou use o botão Upload." |
| Busca sem resultado | search-x + âncora | "Nenhum documento encontrado." | "Tente outros termos ou verifique os filtros." |
| Lixeira vazia | trash-2 + âncora | "Nada na lixeira." | "Itens excluídos aparecem aqui por 30 dias." |
| Sem permissão / erro | lock + âncora | "Você não tem acesso a esta pasta." | "Solicite acesso ao administrador." |

**Empty state no Command Palette:** versão REDUZIDA — sem ilustração, apenas ícone de 16-20px + texto "Nenhum resultado". Espaço do Command Palette é restrito.

### Loading states
- **Listagens (tabela, feed, cards):** Skeleton screens com silhueta do conteúdo final, cor bg-hover, animação pulse (opacidade 0.5→1 em 1.5s loop).
- **Ações bloqueantes (botão de upload, salvar):** Spinner interno no próprio botão, botão desabilitado.
- **Preview de documento:** Placeholder com ícone de arquivo centralizado enquanto carrega.
- **Preview de arquivo corrompido/não suportado:** "Nenhuma visualização disponível para este tipo de arquivo. Faça o download para abrir."

### Seletor de empresa (top bar)
- Dropdown à esquerda da busca global, mostrando nome da empresa ativa + chevron.
- Lista: todas as empresas do usuário, cada uma com nome + contagem de documentos.
- Trocar de empresa recarrega: sidebar (árvore de pastas), dashboard (recentes/favoritos/stats), listagens.
- Não aparece se `is_single_company_mode=true`.
- Cards de "recentes" no dashboard incluem badge de empresa quando multi-empresa.

### Sessão expirada
- Overlay de tela inteira (não redirect brusco para /login) com mini-card pedindo APENAS a senha para reautenticar.
- Preserva o estado da tela atual — usuário não perde contexto.

---

## RESPONSIVIDADE

| Breakpoint | Largura | Mudanças |
|---|---|---|
| Desktop XL | ≥1280px | Layout completo, sidebar expandida em Documentos |
| Desktop | 1024-1279px | Sidebar colapsada por padrão |
| Tablet | 768-1023px | Sidebar vira drawer. Tabela esconde colunas secundárias |
| Mobile | <768px | Top bar simplifica. Bottom tab bar. Tabelas viram cards empilhados. Command Palette em tela cheia |

**Regra geral:** tabelas densas colapsam para cards empilhados abaixo de 768px.

---

## ACESSIBILIDADE

| Requisito | Implementação |
|---|---|
| Contraste | WCAG AA (4.5:1) em TODOS os textos, incluindo text-tertiary |
| Focus visible | Ring 2px teal-400, offset 2px. Aparece em :focus-visible (teclado), não em :focus (mouse). Na tabela, o ring envolve a linha inteira (<tr>), não cada célula |
| Navegação por teclado | Tab percorre todos os elementos interativos. Árvore: ↑↓ navegar, → expandir, ← colapsar, Enter selecionar |
| Aria labels | Todos os botões icon-only têm aria-label descritivo em português |
| Skip navigation | Link invisível "Pular para conteúdo" no topo |
| Tamanhos de toque | Mínimo 44x44px em todos os botões/links no mobile |
| prefers-reduced-motion | Ver seção de Animações acima |

---

## ICONOGRAFIA

**Biblioteca:** Lucide Icons (`lucide-react`). Stroke 1.5px (nunca alterar).

| Tamanho | Uso |
|---|---|
| 16px | Inline com texto (tabelas, breadcrumbs) |
| 20px | Top bar, sidebar, botões com ícone |
| 24px | Ações destacadas, drawers |
| 32px | Ícones de tipo de arquivo nos cards |
| 48-64px | Empty states (composição de ícones) |

**Truncamento de nomes longos:** `text-overflow: ellipsis` preservando a extensão do arquivo. Ex: `NFe_Posto_Central...Final_V2.pdf` (ellipsis no meio, extensão visível).

---

## LOGO E MARCA

- **Logo completa:** "DOCKE" com âncora integrada ao "O". Usada na top bar.
- **Logo reduzida:** Âncora em círculo. Usada como favicon e ícone de app.
- **Versão light mode:** teal/verde vibrante.
- **Versão dark mode:** teal mais escuro.
- **Marca AFN Systems:** bloco "AFN SYSTEMS | Docke" no footer do card de Login, conforme `afn_brand_guide.html`. JetBrains Mono 700, vermelho #c44a5a (dark) / #6b1f2a (light).

---

## PERSISTÊNCIA DE ESTADO DE NAVEGAÇÃO

- Persiste **durante a sessão** (React Context), não em localStorage.
- **Por pasta/rota:** cada pasta lembra seu próprio scroll, seleção, ordenação, filtros.
- Ao navegar para preview e voltar: estado restaurado.
- Ao recarregar a página (F5): estado zerado (comportamento esperado em apps web).
- **O que persiste:** scrollTop, selectedIds, sortColumn, sortDirection, activeFilters.
- **O que NÃO persiste:** dados carregados (sempre refetch para garantir frescor), estado de upload (vive no Task Center), estado de modais/drawers.

---

## GLASSMORPHISM

Uso permitido APENAS em: overlay de modais (blur sutil no background), popover do Task Center. Nunca em cards, tabelas, listagens ou sidebar.

---
*Fim do design system. Consultar sempre que criar ou modificar componentes.*
