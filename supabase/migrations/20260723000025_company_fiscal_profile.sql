-- =============================================================================
-- Fase 4.2/4.3 (parte 2) — Perfil fiscal da empresa + regras condicionais
--
-- Sem isso, todo modelo de obrigação vale pra empresa inteira sempre — uma
-- empresa do Simples Nacional acumularia pendência de ECD, que a lei não
-- exige dela. "Regras CONDICIONAIS, nunca fixas: Simples Nacional não exige
-- ECD; Lucro Real exige. Funcionários = 0 → não existe Folha." (backlog,
-- seção H).
--
-- Tabela separada de `companies` (não colunas soltas) — mesmo padrão já
-- usado pra config de empresa neste projeto (custom_field/folder_field são
-- tabelas próprias). Todos os campos são OPCIONAIS de propósito: sem dado
-- preenchido, nenhuma regra condicional filtra nada — a obrigação continua
-- aparecendo normalmente. É a direção seguramente conservadora pra software
-- de conformidade: melhor um falso positivo (pendência a mais) do que
-- esconder uma obrigação real por falta de cadastro.
--
-- `faixa_funcionarios` é uma FAIXA, não um número exato — empresas grandes
-- mudam de quadro o tempo todo; manter um contador exato vivo é fricção sem
-- ganho real, já que a única regra hoje é "tem ou não tem" (mas a faixa já
-- deixa espaço pra regras futuras que dependem de porte, ex.: grau de risco
-- de NR, periodicidade de PCMSO).
--
-- "Vínculo empregatício / etapa de contrato" (citado na pesquisa original)
-- FICOU DE FORA de propósito: não é um atributo da EMPRESA, é um atributo de
-- cada COLABORADOR — o Docke hoje não tem cadastro de colaboradores. Usar
-- essa regra de verdade exigiria essa feature primeiro (fora de escopo).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_fiscal_profile (
  company_id         uuid        PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  regime_tributario  text        CHECK (regime_tributario IS NULL OR regime_tributario IN ('simples_nacional', 'lucro_presumido', 'lucro_real')),
  faixa_funcionarios text        CHECK (faixa_funcionarios IS NULL OR faixa_funcionarios IN ('nenhum', '1_a_10', '11_a_50', '51_a_200', '201_mais')),
  uf                 text        CHECK (uf IS NULL OR uf ~ '^[A-Z]{2}$'),
  tipo_juridico      text        CHECK (tipo_juridico IS NULL OR tipo_juridico IN ('mei', 'ltda', 'sa', 'eireli', 'outro')),
  updated_by         uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_company_fiscal_profile_updated_at ON public.company_fiscal_profile;
CREATE TRIGGER trg_company_fiscal_profile_updated_at
  BEFORE UPDATE ON public.company_fiscal_profile
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.company_fiscal_profile ENABLE ROW LEVEL SECURITY;

-- Mesmo padrão de custom_field: leitura por qualquer membro (o motor de
-- regras condicionais precisa ler isso ao computar effective_status via
-- RLS normal), escrita só admin (config de empresa).
DROP POLICY IF EXISTS "company_fiscal_profile_select" ON public.company_fiscal_profile;
CREATE POLICY "company_fiscal_profile_select"
  ON public.company_fiscal_profile FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id = auth.uid() AND uca.company_id = company_fiscal_profile.company_id
    )
  );

DROP POLICY IF EXISTS "company_fiscal_profile_insert" ON public.company_fiscal_profile;
CREATE POLICY "company_fiscal_profile_insert"
  ON public.company_fiscal_profile FOR INSERT
  TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "company_fiscal_profile_update" ON public.company_fiscal_profile;
CREATE POLICY "company_fiscal_profile_update"
  ON public.company_fiscal_profile FOR UPDATE
  TO authenticated
  USING     (public.is_company_admin(company_id))
  WITH CHECK (public.is_company_admin(company_id));

GRANT SELECT, INSERT, UPDATE ON public.company_fiscal_profile TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.company_fiscal_profile TO service_role;
