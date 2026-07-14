-- =============================================================================
-- Metadados personalizados (ADENDO-08) — M-A
--
-- Três tabelas:
--   custom_field          catálogo de campos tipados, por empresa
--   folder_field          aplicação de um campo numa pasta (ou na empresa toda,
--                         folder_path IS NULL), com herança via ltree — mesma
--                         regra de especificidade de user_has_access() (I7):
--                         o path mais profundo que seja ancestral do alvo
--                         sempre prevalece, e uma linha `mode='exclude'` nesse
--                         path cancela a herança do campo só naquele ramo.
--   document_field_value  valor preenchido de um campo num documento.
--
-- Gestão do catálogo/aplicação é exclusiva de admin (mesmo bucket de
-- "config de empresa" que já usa is_company_admin() — ver 20260702000008).
-- Supremo é bypass de aplicação (FastAPI), igual ao resto do backend.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. custom_field — catálogo
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.custom_field (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  label         text        NOT NULL,
  field_key     text        NOT NULL,
  type          text        NOT NULL CHECK (type IN ('texto', 'cpf', 'cnpj', 'data', 'competencia', 'numero', 'selecao')),
  format_config jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,

  CONSTRAINT uq_custom_field_company_key UNIQUE (company_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_custom_field_company ON public.custom_field (company_id) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. folder_field — aplicação na árvore
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.folder_field (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  folder_path     ltree,      -- NULL = empresa toda (raiz)
  custom_field_id uuid        NOT NULL REFERENCES public.custom_field(id) ON DELETE CASCADE,
  mode            text        NOT NULL DEFAULT 'apply' CHECK (mode IN ('apply', 'exclude')),
  required        boolean     NOT NULL DEFAULT false,
  display_order   int         NOT NULL DEFAULT 0,
  column_width    int,
  created_by      uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Uma única regra por (campo, path) — reaplicar na mesma pasta substitui (UPSERT).
  CONSTRAINT uq_folder_field_path_field UNIQUE NULLS NOT DISTINCT (company_id, folder_path, custom_field_id)
);

CREATE INDEX IF NOT EXISTS idx_folder_field_path    ON public.folder_field USING GIST (folder_path);
CREATE INDEX IF NOT EXISTS idx_folder_field_company ON public.folder_field (company_id);
CREATE INDEX IF NOT EXISTS idx_folder_field_field   ON public.folder_field (custom_field_id);

-- ---------------------------------------------------------------------------
-- 3. document_field_value — valores preenchidos
-- Colunas-sombra (value_date/value_number) existem só para ordenar/filtrar com
-- índice; a exibição usa sempre value_text formatado (fonte da verdade).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_field_value (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id     uuid        NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  custom_field_id uuid        NOT NULL REFERENCES public.custom_field(id) ON DELETE CASCADE,
  value_text      text        NOT NULL,
  value_date      date,
  value_number    numeric,
  updated_by      uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_document_field UNIQUE (document_id, custom_field_id)
);

CREATE INDEX IF NOT EXISTS idx_dfv_document     ON public.document_field_value (document_id);
CREATE INDEX IF NOT EXISTS idx_dfv_field_date   ON public.document_field_value (custom_field_id, value_date);
CREATE INDEX IF NOT EXISTS idx_dfv_field_number ON public.document_field_value (custom_field_id, value_number);

DROP TRIGGER IF EXISTS trg_dfv_updated_at ON public.document_field_value;
CREATE TRIGGER trg_dfv_updated_at
  BEFORE UPDATE ON public.document_field_value
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. resolve_folder_fields() — campos efetivos para uma pasta-alvo
--
-- Mesma regra de especificidade de user_has_access() (I7): para cada
-- custom_field_id, vence a linha de folder_field cujo folder_path é
-- ancestral-ou-igual ao alvo E o mais profundo entre as candidatas. Se a
-- vencedora tiver mode='exclude', o campo é omitido do resultado (herança
-- cancelada só naquele ramo).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_folder_fields(
  p_company_id  uuid,
  p_target_path ltree
)
RETURNS TABLE (
  custom_field_id uuid,
  required        boolean,
  display_order   int,
  column_width    int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  WITH candidates AS (
    SELECT
      ff.custom_field_id,
      ff.mode,
      ff.required,
      ff.display_order,
      ff.column_width,
      CASE WHEN ff.folder_path IS NULL THEN 0 ELSE nlevel(ff.folder_path) END AS depth,
      ROW_NUMBER() OVER (
        PARTITION BY ff.custom_field_id
        ORDER BY CASE WHEN ff.folder_path IS NULL THEN 0 ELSE nlevel(ff.folder_path) END DESC
      ) AS rn
    FROM public.folder_field ff
    WHERE ff.company_id = p_company_id
      AND (
        ff.folder_path IS NULL
        OR (p_target_path IS NOT NULL AND ff.folder_path @> p_target_path)
      )
  )
  SELECT c.custom_field_id, c.required, c.display_order, c.column_width
  FROM candidates c
  WHERE c.rn = 1
    AND c.mode = 'apply';
$$;

GRANT EXECUTE ON FUNCTION public.resolve_folder_fields(uuid, ltree) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_folder_fields(uuid, ltree) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.custom_field          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folder_field          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_field_value  ENABLE ROW LEVEL SECURITY;

-- custom_field: qualquer membro da empresa lê (precisa pra montar formulário/
-- colunas); só admin da empresa gerencia (catálogo é config de empresa).
DROP POLICY IF EXISTS "custom_field_select" ON public.custom_field;
CREATE POLICY "custom_field_select"
  ON public.custom_field FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id = auth.uid() AND uca.company_id = custom_field.company_id
    )
  );

DROP POLICY IF EXISTS "custom_field_insert" ON public.custom_field;
CREATE POLICY "custom_field_insert"
  ON public.custom_field FOR INSERT
  TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "custom_field_update" ON public.custom_field;
CREATE POLICY "custom_field_update"
  ON public.custom_field FOR UPDATE
  TO authenticated
  USING     (public.is_company_admin(company_id))
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "custom_field_delete" ON public.custom_field;
CREATE POLICY "custom_field_delete"
  ON public.custom_field FOR DELETE
  TO authenticated
  USING (public.is_company_admin(company_id));

-- folder_field: mesma regra — leitura por qualquer membro, escrita só admin.
DROP POLICY IF EXISTS "folder_field_select" ON public.folder_field;
CREATE POLICY "folder_field_select"
  ON public.folder_field FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_company_access uca
      WHERE uca.user_id = auth.uid() AND uca.company_id = folder_field.company_id
    )
  );

DROP POLICY IF EXISTS "folder_field_insert" ON public.folder_field;
CREATE POLICY "folder_field_insert"
  ON public.folder_field FOR INSERT
  TO authenticated
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "folder_field_update" ON public.folder_field;
CREATE POLICY "folder_field_update"
  ON public.folder_field FOR UPDATE
  TO authenticated
  USING     (public.is_company_admin(company_id))
  WITH CHECK (public.is_company_admin(company_id));

DROP POLICY IF EXISTS "folder_field_delete" ON public.folder_field;
CREATE POLICY "folder_field_delete"
  ON public.folder_field FOR DELETE
  TO authenticated
  USING (public.is_company_admin(company_id));

-- document_field_value: segue o mesmo acesso do documento (via a pasta dele) —
-- quem pode ver/editar o documento pode ver/editar os valores de metadado.
-- Espelha exatamente documents_select/documents_update (20260627000003 /
-- 20260703000010), inclusive o branch de documento na raiz (folder_id NULL).
DROP POLICY IF EXISTS "dfv_select" ON public.document_field_value;
CREATE POLICY "dfv_select"
  ON public.document_field_value FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_field_value.document_id
        AND (
          d.folder_id IS NULL
            AND public.user_has_access(auth.uid(), NULL::ltree, d.company_id) IS NOT NULL
          OR
          d.folder_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.folders f
              WHERE f.id = d.folder_id
                AND public.user_has_access(auth.uid(), f.path, d.company_id) IS NOT NULL
            )
        )
    )
  );

DROP POLICY IF EXISTS "dfv_insert" ON public.document_field_value;
CREATE POLICY "dfv_insert"
  ON public.document_field_value FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_field_value.document_id
        AND (
          d.folder_id IS NULL
            AND public.user_has_access(auth.uid(), NULL::ltree, d.company_id) IN ('admin', 'operador')
          OR
          d.folder_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.folders f
              WHERE f.id = d.folder_id
                AND public.user_has_access(auth.uid(), f.path, d.company_id) IN ('admin', 'operador')
            )
        )
    )
  );

DROP POLICY IF EXISTS "dfv_update" ON public.document_field_value;
CREATE POLICY "dfv_update"
  ON public.document_field_value FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_field_value.document_id
        AND (
          d.folder_id IS NULL
            AND public.user_has_access(auth.uid(), NULL::ltree, d.company_id) IN ('admin', 'operador')
          OR
          d.folder_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.folders f
              WHERE f.id = d.folder_id
                AND public.user_has_access(auth.uid(), f.path, d.company_id) IN ('admin', 'operador')
            )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_field_value.document_id
        AND (
          d.folder_id IS NULL
            AND public.user_has_access(auth.uid(), NULL::ltree, d.company_id) IN ('admin', 'operador')
          OR
          d.folder_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.folders f
              WHERE f.id = d.folder_id
                AND public.user_has_access(auth.uid(), f.path, d.company_id) IN ('admin', 'operador')
            )
        )
    )
  );

DROP POLICY IF EXISTS "dfv_delete" ON public.document_field_value;
CREATE POLICY "dfv_delete"
  ON public.document_field_value FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_field_value.document_id
        AND (
          d.folder_id IS NULL
            AND public.user_has_access(auth.uid(), NULL::ltree, d.company_id) IN ('admin', 'operador')
          OR
          d.folder_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.folders f
              WHERE f.id = d.folder_id
                AND public.user_has_access(auth.uid(), f.path, d.company_id) IN ('admin', 'operador')
            )
        )
    )
  );
