# Docke — Adendo 07: Consolidação Final (Gaps Finais)

> Resultado da validação cruzada sobre `ADENDO-06-GAPS-FINAIS.md`. Corrige
> e estende os ADRs 035-038.

---

## ADR-036 (revisão) — Papel "Auditor" Restrito a Leitura

**Correção — convergência total das 5 IAs.** O papel "auditor" da matriz
original permitia upload e movimentação de documentos, o que fere o
princípio de segregação de funções: quem audita não deveria poder alterar
o que está auditando.

**Nova permissão do papel "auditor":**
```
documents:view, documents:download, folders:view,
activity:view, search:view
```
**Removido do auditor:** upload, mover, enviar para lixeira, restaurar,
upload de nova versão — tudo que envolve escrita.

Se no futuro for necessário um papel que combine leitura ampla com
alguma capacidade de escrita, ele deve ter outro nome ("supervisor",
"operador") — o nome "auditor" fica reservado para leitura pura,
permanentemente.

---

## ADR-037 (extensão) — Vetores Adicionais de Isolamento

Três vetores identificados que RLS + filtro de aplicação sozinhos não
cobrem:

1. **URLs assinadas de download (storage):** o endpoint que gera link de
   download do R2 deve validar que `company_id` do documento bate com a
   empresa do usuário autenticado ANTES de assinar a URL — nunca confiar
   apenas no ID do documento vindo da URL (risco de IDOR)
2. **Cache (se/quando implementado):** toda chave de cache relacionada a
   busca ou listagem deve incluir `company_id` explicitamente
   (`search:{company_id}:{termo}`), nunca cache genérico compartilhado
3. **Logs de erro/aplicação:** não podem gravar payload completo de
   requisição sem mascarar dados sensíveis — um erro de uma empresa não
   pode expor dado de outra pra quem tem acesso ao painel de logs

**Verificação obrigatória antes de produção:** teste manual com dois
usuários de empresas diferentes tentando acessar documentos, pastas e
resultados de busca um do outro via API diretamente (não só pela
interface) — confirma que RLS realmente barra, não só a UI esconde.

---

## ADR-038 (extensão) — Backup do Storage e Segurança do Backup

**Adições ao ADR-038 original (que cobria só o banco):**
- **Versionamento de bucket habilitado no R2** — proteção dos arquivos em
  si, independente do backup do PostgreSQL
- Backups do banco armazenados **criptografados em repouso**
- Teste de restauração roda em **ambiente isolado**, nunca sobrescrevendo
  o banco de produção durante o teste

---

## ADR-035 (refinamento técnico) — Snippet de Busca

**Ajustes técnicos incorporados:**
- `ocr_text` usado para gerar o snippet deve ser truncado (não indexar o
  documento inteiro para fins de `ts_headline` se ele for muito longo) —
  evita degradação de performance em documentos extensos
- Usar `phraseto_tsquery` em vez de `plainto_tsquery` para termos de
  busca com mais de uma palavra — preserva a ordem ("nota fiscal" busca
  a frase, não "nota" e "fiscal" separados)
- Qualidade do destaque cai quando o OCR tem erro de reconhecimento —
  **aceito como limitação conhecida do v2**, não é bloqueador

---

## Registrado como limitação conhecida — Retenção Legal de Documentos Ativos

**Gap identificado de forma independente por duas IAs na mesma rodada**
(convergência espontânea, sem repetição de pergunta): o Docke não tem
mecanismo de retenção legal para documentos **ativos** (diferente da
lixeira, que já tem retenção configurável). Documentos fiscais e
trabalhistas no Brasil têm prazo de guarda obrigatório por lei (varia por
tipo de documento).

**Decisão:** fica formalmente fora do escopo do v2, registrado como
limitação conhecida para v2.1 ou v3. Quando for endereçado, vai precisar
de: metadado de prazo legal por tipo de documento, alerta pra
administrador quando o prazo vencer, e opção de mover pra
"arquivo morto" (storage de custo menor) — nenhuma dessas decisões foi
tomada ainda, só o reconhecimento de que o gap existe.

---

## Itens de outras IAs já cobertos ou fora de escopo

- **Log de acesso a link externo (Grok):** já coberto pelo ADR-027
  (rate limiting + `activity_log` para toda tentativa de acesso, com ou
  sem senha)
- **Integração com sistemas contábeis / importação de SPED (Perplexity):**
  ideia de produto válida, mas é escopo de feature nova, não um gap do
  planejamento atual — fica como sugestão para avaliação futura, sem
  decisão tomada

---

## Referência

Este documento fecha a auditoria completa de planejamento pós-v1. O
pacote final para o Claude Code é: Adendos 01 a 07 + protótipo visual +
prompt de handoff (a ser atualizado para referenciar os Adendos 06 e 07).
