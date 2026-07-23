-- =============================================================================
-- Fase 4.3 (parte 1) — Validade/caducidade do documento comprobatório
--
-- "Validade/caducidade do documento (validity_months): status EXPIRED é
-- diferente de MISSING." (backlog, seção H)
--
-- Alguns documentos comprobatórios têm prazo de validade próprio (ex.: uma
-- certidão negativa vale 90 dias mesmo que a obrigação em si seja mensal) —
-- vincular o documento não é o fim da história, ele pode ENVELHECER dentro da
-- mesma instância. `validity_months IS NULL` = documento não expira uma vez
-- vinculado (comportamento de hoje, preservado).
--
-- NOT_APPLICABLE (a outra parte do estado descrito na pesquisa) continua fora
-- desta fatia — depende do motor de regras condicionais (4.2 parte 2), ainda
-- não implementado por falta do perfil fiscal da empresa.
-- =============================================================================

ALTER TABLE public.obligation_templates
  ADD COLUMN IF NOT EXISTS validity_months int CHECK (validity_months IS NULL OR validity_months > 0);

COMMENT ON COLUMN public.obligation_templates.validity_months IS
  'Meses que um documento vinculado permanece válido a partir de linked_at. NULL = nunca expira sozinho.';
