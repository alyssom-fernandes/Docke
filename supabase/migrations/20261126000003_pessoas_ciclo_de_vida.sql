-- Ciclo de vida das pessoas e trilha das mudanças de acesso (achados A9-16,
-- A9-17, A8-T2 e X2-13 da avaliação de 25/11/2026).
--
-- Aditivo: uma coluna com padrão e o CHECK de item_type ampliado. Nenhum
-- dado é alterado ou apagado.

-- Senha provisória definida por um admin: a pessoa troca no primeiro acesso.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- Concessões, papéis, desativação e configurações da empresa na trilha.
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
  CHECK (item_type IN ('document', 'folder', 'obligation', 'retention', 'access', 'config'));
