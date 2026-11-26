-- Obrigação por colaborador: exames ocupacionais (ASO) com matriz
-- colaborador × exame (FA-A7-05). Cada colaborador tem admissão, desligamento
-- e a periodicidade do exame periódico definida no PCMSO da empresa (padrão
-- 12 meses, ajustável por pessoa). Os exames registrados podem apontar para o
-- ASO digitalizado no Docke. Dado de saúde: só o admin da empresa vê.
--
-- Aditivo: duas tabelas novas.

CREATE TABLE IF NOT EXISTS public.employees (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name                text         NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 200),
  registration        text         CHECK (registration IS NULL OR length(registration) <= 40),
  role_title          text         CHECK (role_title IS NULL OR length(role_title) <= 120),
  admission_date      date         NOT NULL,
  termination_date    date         CHECK (termination_date IS NULL OR termination_date >= admission_date),
  periodic_months     int          NOT NULL DEFAULT 12 CHECK (periodic_months BETWEEN 1 AND 60),
  created_by          uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  archived_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_employees_company ON public.employees (company_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.employee_exams (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid         NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  company_id    uuid         NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind          text         NOT NULL CHECK (kind IN ('admissional', 'periodico', 'retorno', 'mudanca_risco', 'demissional')),
  exam_date     date         NOT NULL,
  result        text         NOT NULL DEFAULT 'apto' CHECK (result IN ('apto', 'apto_restricao', 'inapto')),
  document_id   uuid         REFERENCES public.documents(id) ON DELETE SET NULL,
  notes         text         CHECK (notes IS NULL OR length(notes) <= 500),
  created_by    uuid         REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_exams_employee ON public.employee_exams (employee_id, exam_date DESC);

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_exams ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employees TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.employee_exams TO service_role;
