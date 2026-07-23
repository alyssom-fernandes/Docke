-- =============================================================================
-- Fase 4.2 (parte 1) — Dependências entre obrigações
--
-- "NF → SPED → ECD. Se a NF ainda está incompleta, não faz sentido cobrar o
-- SPED. Evita centenas de alertas falsos." (backlog, seção H)
--
-- A parte de REGRAS CONDICIONAIS (Simples Nacional não exige ECD, zero
-- funcionários não tem Folha) fica de fora desta fatia: exigiria um perfil
-- fiscal/jurídico da empresa (regime tributário, UF, tipo jurídico, número de
-- funcionários) que não existe em `companies` hoje — é uma decisão de produto
-- própria, não uma correção. Só dependências (o que já é possível com o
-- modelo atual: comparar duas instâncias do mesmo período) entra agora.
--
-- Modelo: obligation_template_dependencies(template_id, depends_on_template_id)
-- — "o template X só fica ativo se o template Y já tiver sido satisfeito no
-- mesmo período". Guardado no TEMPLATE (não na instância) porque a
-- dependência é uma regra estrutural da obrigação, não algo que varia
-- instância a instância.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.obligation_template_dependencies (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  template_id            uuid        NOT NULL REFERENCES public.obligation_templates(id) ON DELETE CASCADE,
  depends_on_template_id uuid        NOT NULL REFERENCES public.obligation_templates(id) ON DELETE CASCADE,
  created_by             uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_obligation_dependency UNIQUE (template_id, depends_on_template_id),
  CONSTRAINT chk_obligation_dependency_not_self CHECK (template_id <> depends_on_template_id)
);

CREATE INDEX IF NOT EXISTS idx_obligation_deps_template ON public.obligation_template_dependencies (template_id);
CREATE INDEX IF NOT EXISTS idx_obligation_deps_depends_on ON public.obligation_template_dependencies (depends_on_template_id);

ALTER TABLE public.obligation_template_dependencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "obligation_deps_select" ON public.obligation_template_dependencies;
CREATE POLICY "obligation_deps_select"
  ON public.obligation_template_dependencies FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id = auth.uid() AND uca.company_id = obligation_template_dependencies.company_id
    )
  );

DROP POLICY IF EXISTS "obligation_deps_insert" ON public.obligation_template_dependencies;
CREATE POLICY "obligation_deps_insert"
  ON public.obligation_template_dependencies FOR INSERT
  TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "obligation_deps_delete" ON public.obligation_template_dependencies;
CREATE POLICY "obligation_deps_delete"
  ON public.obligation_template_dependencies FOR DELETE
  TO authenticated
  USING (public.is_company_admin(company_id));

GRANT SELECT, INSERT, DELETE ON public.obligation_template_dependencies TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.obligation_template_dependencies TO service_role;

-- ---------------------------------------------------------------------------
-- Impedir ciclo simples (A depende de B, B depende de A) direto no INSERT —
-- ciclos maiores (A→B→C→A) não são bloqueados aqui de propósito: exigiriam
-- percorrer o grafo inteiro a cada escrita, e o volume de templates por
-- empresa (dezenas, não milhares) não justifica isso agora. Fica documentado
-- como limitação conhecida, não um bug silencioso.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.obligation_deps_prevent_direct_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.obligation_template_dependencies
    WHERE template_id = NEW.depends_on_template_id
      AND depends_on_template_id = NEW.template_id
  ) THEN
    RAISE EXCEPTION 'Dependência circular: % e % já dependem um do outro', NEW.template_id, NEW.depends_on_template_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_obligation_deps_prevent_direct_cycle ON public.obligation_template_dependencies;
CREATE TRIGGER trg_obligation_deps_prevent_direct_cycle
  BEFORE INSERT ON public.obligation_template_dependencies
  FOR EACH ROW EXECUTE FUNCTION public.obligation_deps_prevent_direct_cycle();
