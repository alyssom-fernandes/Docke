# Docke — Adendo 03: Validação Técnica do Refinamento Visual

> Este documento é o resultado da rodada de validação cruzada (5 IAs) sobre
> `ADENDO-02-REFINAMENTO-VISUAL.md`. Onde houver conflito, este documento
> prevalece — ele corrige e refina o adendo anterior com base em revisão
> técnica real (performance, acessibilidade, compatibilidade).

---

## ADR-017 — Regras de Performance para Superfícies de Vidro

**Decisão:** o vidro (backdrop-filter) só é aplicado onde é estrutural e
não re-renderiza constantemente. Três regras obrigatórias:

1. **Moldura da tabela de documentos:** raio de blur reduzido de 20px para
   **8-10px**. A moldura é fina (borda), não precisa de blur profundo —
   o efeito de profundidade vem mais da borda translúcida que do blur em si.

2. **Blur desabilitado durante scroll ativo na tabela:** ao detectar scroll
   em progresso (`onScroll` + debounce), remover temporariamente
   `backdrop-filter` da moldura da tabela (trocar para `blur(0px)` ou
   remover a classe de vidro). Restaurar o efeito 150ms após o scroll parar
   (`requestAnimationFrame` + debounce). A transição deve ser imperceptível
   ao usuário.

3. **Proibido empilhar vidro sobre vidro:** nenhum popover, dropdown ou
   painel translúcido pode abrir sobre outro elemento já translúcido (ex:
   Task Center nunca deve renderizar sobre a sidebar com blur ativo ao
   mesmo tempo — nesse caso, a sidebar recua para fundo sólido enquanto o
   popover estiver aberto, ou o popover é posicionado fora da área da
   sidebar).

4. `will-change: backdrop-filter` aplicado apenas em sidebar e topbar
   (elementos fixos que realmente se beneficiam). **Nunca** em elementos
   dentro de containers com scroll — é contraproducente ali.

---

## ADR-018 — Correção de Contraste em Badges, Chips e Texto Terciário

**Contexto:** validação cruzada identificou que badges de status e texto
terciário ficam abaixo de WCAG AA (4.5:1) nos tokens originais do Adendo 02.

**Correções obrigatórias:**

### Badges de status (ex: "OCR concluído")
```css
/* Antes (reprovado, ~3.2:1) */
background: rgba(29,184,153,0.15);
color: var(--teal-bright);

/* Depois */
background: rgba(29,184,153,0.20);
color: #086B61; /* modo claro — teal mais profundo */
/* modo escuro: manter --teal-bright (#29C9A8), contraste já suficiente
   contra fundo escuro */
```

### Texto terciário / secundário (labels, metadados, timestamps)
```css
/* Modo claro */
--text-secondary: #5A6268; /* era #6C757D */

/* Modo escuro */
--text-secondary: #A8A8A8; /* era #999999 */
```

### Chips de tipo de arquivo (PDF/XLS/DOC)
O texto do tipo de arquivo ao lado do ícone (quando existir, ex: "PDF" em
12-13px) deve usar peso 600 e cor mais escura que o ícone, não a mesma cor
em opacidade baixa:
```css
/* Exemplo PDF */
.fic-pdf .label{ color: #B91C1C; font-weight: 600; }
```
Ícones isolados (sem texto ao lado) só precisam de 3:1 contra o fundo
adjacente — esses já passam sem alteração.

---

## ADR-019 — Fallback Explícito via `@supports` (substitui a regra do Adendo 02)

**Correção:** a regra original ("degrada silenciosamente para fundo sólido
translúcido") foi contestada por 4 das 5 IAs — opacidade calibrada para
funcionar *com* blur fica ilegível *sem* blur. Nova regra:

```css
/* Fallback — fora da query, assume-se SEM suporte a backdrop-filter */
.glass-panel {
  background: rgba(255,255,255,0.92); /* modo claro */
  border: 1px solid rgba(0,0,0,0.06);
}
[data-theme="dark"] .glass-panel {
  background: rgba(20,20,24,0.94);
  border: 1px solid rgba(255,255,255,0.08);
}

/* Com suporte — vidro real entra aqui */
@supports (backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px)) {
  .glass-panel {
    background: var(--glass-panel-bg);
    backdrop-filter: var(--glass-backdrop-blur);
    -webkit-backdrop-filter: var(--glass-backdrop-blur);
  }
}
```

Aplicar esse padrão em TODOS os elementos que hoje usam `--glass-panel-bg`
diretamente (sidebar, topbar, table-wrap, stat-card, task-panel,
crumb-dropdown, batch-bar). O suporte global a `backdrop-filter` já passa
de 96% (2026), então o fallback cobre principalmente proxies corporativos
que removem CSS moderno — cenário real no ambiente de rede do Grupo Zen,
vale testar.

---

## ADR-020 — Redução de Blur para Longevidade Visual

**Decisão:** raio de blur de sidebar e topbar reduzido de 20px para **14px**.
Objetivo: o efeito deixa de comunicar "efeito vidro" (mais suscetível a
parecer datado conforme a tendência passa) e passa a comunicar "superfície
elevada com profundidade" (linguagem mais próxima de elevation do Material
Design, que já provou durabilidade). Opacidade da superfície permanece alta
(0.75-0.85) para o vidro nunca ficar transparente a ponto de distrair.

A borda sutil com reflexo (`--glass-highlight`, já definida no Adendo 02)
continua sendo o elemento que dá "delimitação tátil" ao painel — é ela,
mais que o blur, que faz o vidro parecer intencional e não um erro de
renderização.

---

## ADR-021 — Modo Escuro como Padrão no Primeiro Acesso

**Decisão:** novos usuários (primeiro login, sem preferência salva) veem o
Docke em modo escuro por padrão, independente de `prefers-color-scheme` do
sistema. Justificativa validada na rodada cruzada: usuários de contexto
fiscal/contábil/RH associam interfaces escuras e densas a "sério e
profissional" — a primeira impressão importa para adoção.

**Implementação:**
- Se o usuário nunca definiu preferência de tema (`user_preferences.theme`
  é `null`), aplicar `dark` por padrão
- Se o usuário já alternou manualmente (via botão de tema), respeitar a
  escolha salva — o padrão só vale para a primeira sessão
- `prefers-color-scheme` do sistema NÃO sobrepõe essa regra — é só usada
  como fallback caso `user_preferences` não exista por algum motivo técnico

---

## Itens sem consenso — decisão unilateral registrada

Nenhum item ficou sem decisão nesta rodada. Todos os 5 pontos do brief
original receberam correção clara e acionável.

---

## Nota para rodadas futuras de validação cruzada

O ChatGPT, ao revisar a qualidade do próprio brief (não o tema em si),
sugeriu melhorias válidas para a PRÓXIMA vez que abrirmos uma rodada:
exigir que contraste seja justificado numericamente (não só "parece bom"),
separar custo de GPU vs. custo de layout/DOM ao discutir performance,
pedir fallback via `@supports not(...)` explicitamente na pergunta, e
adicionar uma classificação de confiança (alto/médio/baixo) por resposta.
Vale usar esse formato aprimorado na próxima rodada — não foi necessário
reabrir esta, porque o DeepSeek já entregou análise quantitativa de
contraste por conta própria, cobrindo a lacuna.

---

## Referência para o Claude Code

Este documento, junto com `ADENDO-02-REFINAMENTO-VISUAL.md`, substitui os
tokens de vidro originais. Onde os dois conflitarem, este (Adendo 03)
prevalece — ele é a versão corrigida após revisão técnica real.
