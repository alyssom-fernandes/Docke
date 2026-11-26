-- Obrigações que andam sozinhas (achados A7-07, A7-08, A7-37, A7-38, A7-46,
-- A7-51, A7-53, A7-62 e A7-03 da avaliação de 25/11/2026).
--
-- Tudo aditivo: colunas novas com padrão, gatilho reescrito, CHECKs
-- ampliados. Nenhum dado existente é apagado ou alterado, exceto o gatilho
-- de vínculo, que passa a mandar para revisão em vez de aprovar sozinho
-- (vale só para vínculos feitos daqui em diante).

-- 1) Modelo: quando vence, quem cuida e se precisa de conferência ------------
ALTER TABLE public.obligation_templates
  ADD COLUMN IF NOT EXISTS due_day int CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  ADD COLUMN IF NOT EXISTS due_month_offset int NOT NULL DEFAULT 1 CHECK (due_month_offset BETWEEN 0 AND 12),
  ADD COLUMN IF NOT EXISTS due_month int CHECK (due_month IS NULL OR due_month BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS default_owner_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requires_review boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS legal_basis text,
  ADD COLUMN IF NOT EXISTS catalog_key text;

COMMENT ON COLUMN public.obligation_templates.due_day IS
  'Dia do vencimento. Mensal: dia do mês da competência + due_month_offset. Anual: dia de due_month.';
COMMENT ON COLUMN public.obligation_templates.due_month_offset IS
  'Mensal: quantos meses depois da competência vence (1 = mês seguinte, o caso comum).';
COMMENT ON COLUMN public.obligation_templates.requires_review IS
  'true: vincular documento deixa a obrigação "em revisão" até alguém aprovar (A7-53).';
COMMENT ON COLUMN public.obligation_templates.catalog_key IS
  'Chave do modelo pronto de onde veio (evita criar o mesmo modelo duas vezes).';

CREATE UNIQUE INDEX IF NOT EXISTS uq_obligation_templates_catalog
  ON public.obligation_templates (company_id, catalog_key)
  WHERE catalog_key IS NOT NULL AND archived_at IS NULL;

-- 2) Competência: observação e quem conferiu ---------------------------------
ALTER TABLE public.obligation_instances
  ADD COLUMN IF NOT EXISTS notes text,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;

-- 3) Validade real impressa no documento (CND de 180 dias, alvará com data) --
ALTER TABLE public.obligation_documents
  ADD COLUMN IF NOT EXISTS valid_until date;

-- 4) Vincular manda para revisão quando o modelo pede conferência ------------
CREATE OR REPLACE FUNCTION public.obligation_documents_sync_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_instance_id uuid;
  v_remaining   int;
  v_status      text;
  v_review      boolean;
BEGIN
  v_instance_id := COALESCE(NEW.obligation_instance_id, OLD.obligation_instance_id);

  SELECT oi.status, ot.requires_review INTO v_status, v_review
  FROM public.obligation_instances oi
  JOIN public.obligation_templates ot ON ot.id = oi.template_id
  WHERE oi.id = v_instance_id;
  IF v_status IN ('dispensado', 'cancelado') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF v_review THEN
      UPDATE public.obligation_instances
      SET status = 'reviewing', reviewed_by = NULL, reviewed_at = NULL
      WHERE id = v_instance_id AND status <> 'reviewing';
    ELSE
      UPDATE public.obligation_instances
      SET status = 'approved', satisfied_at = COALESCE(satisfied_at, now())
      WHERE id = v_instance_id AND status <> 'approved';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_remaining
  FROM public.obligation_documents
  WHERE obligation_instance_id = v_instance_id;
  IF v_remaining = 0 THEN
    UPDATE public.obligation_instances
    SET status = 'pending', satisfied_at = NULL, reviewed_by = NULL, reviewed_at = NULL
    WHERE id = v_instance_id AND status <> 'pending';
  END IF;
  RETURN OLD;
END;
$$;

-- 5) Ciclos indiretos (A→B→C→A) também são recusados (A7-62) ---------------
CREATE OR REPLACE FUNCTION public.obligation_deps_prevent_direct_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE cadeia(tid) AS (
      SELECT NEW.depends_on_template_id
      UNION
      SELECT d.depends_on_template_id
      FROM public.obligation_template_dependencies d
      JOIN cadeia c ON d.template_id = c.tid
    )
    SELECT 1 FROM cadeia WHERE tid = NEW.template_id
  ) THEN
    RAISE EXCEPTION 'DOCKE_DEPENDENCIA_CIRCULAR';
  END IF;
  RETURN NEW;
END;
$$;

-- 6) Ações de obrigações e retenção entram na trilha (A7-03) ----------------
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.activity_log'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%item_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.activity_log DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE public.activity_log
  ADD CONSTRAINT activity_log_item_type_check
  CHECK (item_type IN ('document', 'folder', 'obligation', 'retention'));

-- 7) Aviso de "documento esperando conferência" -----------------------------
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check
  CHECK (type = ANY (ARRAY[
    'folder_activity', 'share_accessed', 'share_blocked', 'version_added', 'trash_expiring',
    'obligation_overdue', 'obligation_at_risk', 'obligation_blocked', 'obligation_expired',
    'obligation_review',
    'retention_expiring_90', 'retention_expiring_30', 'retention_expiring_7'
  ]::text[]));
