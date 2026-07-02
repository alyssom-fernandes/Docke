# Docke — Adendo 02: Refinamento Visual (Liquid Glass)

> Este documento complementa `06-DESIGN-SYSTEM.md`. Onde houver conflito,
> este adendo prevalece — ele é uma revisão intencional dos tokens visuais
> originais, validada com protótipo funcional (`docke-liquid-glass-prototype.html`,
> anexo de referência).

---

## ADR-016 — Adoção de linguagem "vidro flutuante" nos painéis principais

**Contexto:** A v1 do Design System adotou uma postura muito conservadora
("hierarquia sempre vence decoração", sombra quase ausente, sem transparência)
que resultou em interface percebida como "básica demais" pelo usuário após
teste real em produção. Um protótipo foi construído aplicando uma linguagem
inspirada no Liquid Glass da Apple (iOS 26), com curadoria para evitar as
armadilhas de legibilidade que a própria Apple cometeu na primeira versão.

**Decisão:** Os painéis estruturais principais (sidebar, topbar, tabela de
documentos, cards de estatística) adotam tratamento visual de "vidro" —
fundo translúcido com blur, brilho sutil no topo, sombra em duas camadas.
Elementos de leitura densa dentro desses painéis (texto de linhas de tabela,
labels) permanecem em alto contraste sólido — o vidro é a moldura, não o texto.

### Regra geral de aplicação

| Superfície | Recebe tratamento de vidro? |
|---|---|
| Sidebar (expandida e recolhida) | Sim |
| Topbar | Sim |
| Painel de tabela (moldura externa) | Sim |
| Cards de estatística (dashboard) | Sim |
| Task Center (popover) | Sim |
| Dropdown de breadcrumb | Sim |
| Barra de ações em lote (flutuante) | Sim — é o caso mais puro de "vidro sobre conteúdo" |
| Texto e valores dentro de qualquer painel acima | **Não** — sempre cor sólida de alto contraste |
| Modais de formulário (criar pasta, editar empresa etc.) | Avaliar caso a caso — se o formulário tiver poucos campos, pode usar vidro; se for denso, preferir sólido |

---

## Tokens — Design Tokens v1.1 (substituem os equivalentes do documento original)

### Superfícies de vidro

```css
--glass-bg: linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.025));
--glass-border: rgba(255,255,255,0.09);
--glass-backdrop-blur: blur(20px) saturate(150%);
--glass-backdrop-blur-strong: blur(24px) saturate(150%); /* topbar, task panel, batch bar */
--glass-shadow: 0 1px 0 rgba(255,255,255,0.08) inset, 0 12px 30px rgba(0,0,0,0.35);
--glass-shadow-hover: 0 1px 0 rgba(255,255,255,0.10) inset, 0 18px 40px rgba(0,0,0,0.45);
--glass-highlight-line: linear-gradient(90deg, transparent, rgba(255,255,255,0.35), transparent);
```

### Raios

```css
--radius-glass-panel: 22px;   /* sidebar, tabela, cards, topbar */
--radius-glass-popover: 14px; /* dropdowns, task panel */
--radius-glass-pill: 50px;    /* barra de ações em lote */
```

### Regra de construção de qualquer painel de vidro (checklist para Claude Code)

Todo elemento com tratamento de vidro deve ter, nesta ordem:
1. `background: var(--glass-bg)` (gradiente, nunca cor sólida chapada)
2. `backdrop-filter` + `-webkit-backdrop-filter` (blur + saturate — nunca só blur, satura ligeiramente as cores por trás)
3. `border: 1px solid var(--glass-border)`
4. `border-radius` conforme tabela acima
5. `box-shadow: var(--glass-shadow)` — a sombra tem DUAS camadas: um inset claro no topo (simula reflexo de luz) e uma sombra externa escura (simula profundidade)
6. Uma linha de brilho no topo via `::before` — `position: absolute; top: 0; left: [14-18]px; right: [14-18]px; height: 1px; background: var(--glass-highlight-line)`
7. Em elementos interativos (cards, sidebar): `transition: transform 160ms ease, box-shadow 160ms ease` + hover levanta 2px (`translateY(-2px)`) e troca para `--glass-shadow-hover`

### Ícones em contexto de vidro

Ícones de destaque (dentro de stat cards, headers de seção) ganham fundo
circular/arredondado com tom teal translúcido:
```css
background: rgba(29,184,153,0.16);
color: var(--teal-bright); /* #29C9A8 */
border-radius: 10px;
```

### Layout — painéis "soltos"

Sidebar e topbar não tocam mais as bordas da viewport nem ficam coladas
uma na outra:
```css
.dashboard-shell { padding: 20px 20px 0; gap: 16px; }
```
Isso vale tanto no desktop quanto — com ajuste de padding reduzido — no
breakpoint mobile (ver seção de Responsividade do Design System original;
em telas pequenas o padding pode cair para `12px` para não desperdiçar
espaço horizontal).

### Sidebar recolhida (novo estado, não existia no DS original)

- Largura recolhida: `76px`
- Padding recolhido: `20px 10px`
- Labels de texto (`<span>`) somem, ícones centralizados
- Botão "Recolher" no rodapé da sidebar, sempre visível, com ícone de chevron
  duplo que espelha (`rotate(180deg)`) quando recolhido
- Transição: `width 200ms ease, padding 200ms ease` — reaproveita a mesma
  curva de easing já padronizada no restante do DS
- Estado persiste por sessão (localStorage no app real — no protótipo é só
  classe CSS)

---

## O que NÃO muda em relação ao Design System original

Para deixar claro ao Claude Code onde a v1 do DS continua valendo:

- Paleta de cores base (teal, tipografia Inter, cores semânticas) — inalterada
- Regra "texto nunca fica sobre vidro sem camada sólida atrás" — mantida e reforçada
- Contraste mínimo WCAG AA — mantido, é inclusive o motivo de vidro não ser
  usado em texto denso
- Ícone de favoritar = âncora (Adendo 01) — continua valendo
- Modais de confirmação destrutiva (excluir, desativar) — continuam com o
  tratamento sólido original, sem vidro, para reforçar seriedade da ação

---

## Referência de implementação

O arquivo `docke-liquid-glass-prototype.html` (anexo) é a referência viva
destes tokens — HTML/CSS puro, sem dependências além da fonte Inter via
Google Fonts. O Claude Code deve usar esse arquivo como fonte de verdade
para valores exatos de opacidade, blur e timing, não reconstruir de memória
a partir da descrição em prosa deste documento.

**Pontos de atenção técnica para produção:**
- `backdrop-filter` tem custo de performance em listas muito longas —
  testar scroll da tabela de documentos com 500+ linhas renderizadas; se
  houver jank perceptível, considerar aplicar o vidro só na moldura externa
  fixa da tabela (já é o caso) e não em elementos que re-renderizam a cada
  scroll
- Safari e navegadores mais antigos exigem o prefixo `-webkit-backdrop-filter`
  (já incluído em todos os tokens acima) — sem isso o efeito degrada
  silenciosamente para fundo sólido, o que é um fallback aceitável, não um bug
- Modo claro ainda precisa de tokens equivalentes — este adendo cobre modo
  escuro (validado no protótipo); modo claro fica como próximo passo antes
  da rodada de validação cruzada final

---

## Tokens — Modo Claro (validados no protótipo, alternância ao vivo via botão)

O protótipo final (`docke-liquid-glass-prototype.html`) inclui um alternador
de tema funcional (`data-theme="light"` / `data-theme="dark"` na tag `<html>`)
comprovando que os dois modos compartilham a mesma estrutura de tokens —
só os valores mudam.

```css
[data-theme="light"]{
  --bg: #F2F2EF;
  --bg-soft: #FAFAF8;
  --surface: #FFFFFF;
  --surface-2: #F4F4F1;
  --glass-bg: rgba(255,255,255,0.68);
  --glass-bg-strong: rgba(255,255,255,0.72);
  --glass-border: rgba(20,20,18,0.08);
  --glass-panel-bg: linear-gradient(180deg, rgba(255,255,255,0.85), rgba(255,255,255,0.45));
  --glass-shadow: 0 1px 0 rgba(255,255,255,0.8) inset, 0 10px 26px rgba(20,20,18,0.08);
  --glass-shadow-hover: 0 1px 0 rgba(255,255,255,0.9) inset, 0 16px 34px rgba(20,20,18,0.12);
  --glass-highlight: linear-gradient(90deg, transparent, rgba(255,255,255,0.95), transparent);
  --text-primary: #16160F;
  --text-secondary: #67675E;
  --text-muted: #9C9C90;
  --teal-bright: #0E9B86; /* mais escuro que no modo escuro (#29C9A8), para manter contraste sobre branco */
  --border: rgba(20,20,18,0.08);
  --border-strong: rgba(20,20,18,0.14);
}
```

**Regras específicas do modo claro:**
- A sombra externa dos painéis de vidro é muito mais sutil no claro
  (`rgba(20,20,18,0.08-0.12)` vs `rgba(0,0,0,0.35-0.45)` no escuro) —
  sombra escura pesada sobre fundo branco lê como "sujeira", não profundidade
- O brilho no topo dos painéis (`--glass-highlight`) fica quase branco puro
  (`rgba(255,255,255,0.95)`) em vez de semitransparente, porque no claro o
  contraste do reflexo vem da opacidade alta, não da luminosidade
- Os orbes de fundo (`--orb`) reduzem opacidade para `0.3` e o orb neutro
  (orb-2) troca de branco translúcido para um cinza muito sutil
  (`rgba(20,20,18,0.05)`) — no fundo escuro o branco cria o glow, no fundo
  claro seria invisível, então o papel se inverte
- `--teal-bright` fica mais escuro no claro (`#0E9B86` vs `#29C9A8`) para
  manter contraste de texto/ícone sobre fundo branco

---

## Correções pós-teste (protótipo v1 do refinamento)

Encontradas ao testar o protótipo real — corrigem bugs específicos, não
mudam a direção visual.

### Correção A — Cor do nome do projeto no rodapé de página

**Bug:** o "Docke" no rodapé (`.pf-project`) usa `color: var(--text-muted)`,
um cinza mais claro que o usado em "SYSTEMS" (`.pf-sys`). Os dois deveriam
ter exatamente a mesma cor — é a mesma "voz" tipográfica, só nomes diferentes.

**Correção:** `.pf-project` deve usar a MESMA cor de `.pf-sys` e `.pf-pipe`
em ambos os modos, não um token de cor separado:
```css
.pf-project{ color: rgba(255,255,255,0.28); } /* escuro — igual .pf-sys */
[data-theme="light"] .pf-project{ color: #505050; } /* claro — igual .pf-sys */
```
Regra geral: qualquer texto no bloco de crédito AFN Systems (AFN, SYSTEMS,
pipe, nome do projeto) compartilha a mesma cor em cada modo — nunca usar
`--text-muted` genérico ali.

### Correção B — Logo estendida e reduzida aparecendo juntas na sidebar (modo claro)

**Bug:** na sidebar expandida, o ícone reduzido aparece junto com a
logo estendida, mas **só no modo claro**. Causa raiz: a regra de troca de
tema usa `!important` (`[data-theme="light"] .for-light{ display: block
!important; }`) para forçar a versão clara do asset a aparecer. Isso tem
prioridade maior que a regra que esconde o ícone quando a sidebar não está
recolhida (`.sidebar .logo-icon{ display: none; }`), porque `!important`
sempre vence uma regra sem `!important`, independente de qual foi escrita
depois.

**Correção:** as duas condições (tema E estado de collapse) precisam ser
combinadas na mesma regra, não competir via `!important`:
```css
/* Errado (causa o bug) */
.sidebar .logo-icon{ display: none; }
[data-theme="light"] .for-light{ display: block !important; }

/* Correto — combina as duas condições explicitamente */
.sidebar .logo-icon.for-light{ display: none; }
.sidebar.collapsed .logo-icon.for-light{ display: block; }
[data-theme="light"] .sidebar .logo-icon.for-dark{ display: none; }
[data-theme="light"] .sidebar.collapsed .logo-icon.for-light{ display: block; }
```
Regra geral pro Claude Code: nunca usar `!important` para resolver troca de
tema quando o mesmo elemento também tem estado condicional (recolhido/
expandido, aberto/fechado etc.) — sempre combinar os seletores.

### Correção C — Tamanho e alinhamento dos logos

- Logo do login: reduzir de 48px para **36px** de altura — 48px (o valor
  literal do brand guide genérico da AFN) ficou grande demais especificamente
  para o wordmark do Docke, que é proporcionalmente mais largo
- Logo da sidebar (expandida e recolhida): reduzir levemente e
  **centralizar** dentro do espaço da sidebar — hoje está alinhada à
  esquerda com padding fixo; trocar para `justify-content: center` no
  container `.brand` dentro da sidebar
## Sidebar recolhida — confirmação final

O comportamento de recolher a sidebar (Adendo 02, seção anterior) foi
testado e aprovado no protótipo com alternância de tema — o estado
recolhido mantém o mesmo tratamento de vidro em ambos os modos, sem tokens
adicionais além dos já listados.
