"""
Obrigações (Obrigação → Documento comprobatório).

`obligation_instances.status` guarda só o que nasce de ação humana
(reviewing/approved/dispensado/cancelado) ou o padrão 'pending'. Os estados
que dependem de "hoje" (vencendo, atrasada, expirada, bloqueada, não se
aplica) são calculados na leitura; `effective_status` é o que a tela usa.

- Dependências: uma competência fica 'blocked' enquanto o pré-requisito do
  MESMO período não estiver aprovado ou dispensado.
- Validade: a data impressa no documento (`valid_until`, informada ao
  vincular) vale primeiro; sem ela, vínculo + `validity_months` do modelo.
- Regras condicionais: `rules_json.not_applicable_when` contra o perfil
  fiscal da empresa. Sem perfil, nada é escondido.
- Recorrência (achados A7-07 e A7-46): modelos mensais e anuais com dia de
  vencimento geram as competências sozinhos, sem "Gerar instância" manual.
- Revisão (A7-53): vincular documento deixa "em revisão" quando o modelo pede
  conferência; alguém aprova ou devolve, e isso fica registrado.
"""
import json
import re
from typing import Any
from uuid import UUID

import asyncpg

_MESES = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")


def period_label(period: str) -> str:
    """'2026-11' → 'nov/2026'; o resto fica como está."""
    m = re.fullmatch(r"(\d{4})-(\d{2})", period or "")
    if m and 1 <= int(m.group(2)) <= 12:
        return f"{_MESES[int(m.group(2)) - 1]}/{m.group(1)}"
    return period


BLOCKING_LATERAL_SQL = """
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT dep_t.name ORDER BY dep_t.name) AS blocking_templates
    FROM public.obligation_template_dependencies otd
    JOIN public.obligation_templates dep_t ON dep_t.id = otd.depends_on_template_id
    LEFT JOIN public.obligation_instances dep_oi
      ON dep_oi.template_id = otd.depends_on_template_id
     AND dep_oi.company_id = oi.company_id
     AND dep_oi.period = oi.period
    WHERE otd.template_id = oi.template_id
      AND (dep_oi.id IS NULL OR dep_oi.status NOT IN ('approved', 'dispensado'))
  ) bl ON true
"""

# Validade do documento mais recente: a data impressa nele, se informada;
# senão, a data do vínculo + validity_months do modelo (A7-37).
VALIDITY_LATERAL_SQL = """
  LEFT JOIN LATERAL (
    SELECT COALESCE(
             last_doc.valid_until,
             CASE WHEN ot.validity_months IS NOT NULL
                  THEN (last_doc.linked_at::date + (ot.validity_months || ' months')::interval)::date END
           ) AS expires_at
    FROM (
      SELECT od.valid_until, od.linked_at FROM public.obligation_documents od
      WHERE od.obligation_instance_id = oi.id
      ORDER BY od.linked_at DESC LIMIT 1
    ) last_doc
  ) exp ON true
"""

# Regra condicional (A7-38): "não vale quando o campo está na lista" ou, com
# "only": true, "vale só quando está na lista". O campo "atividade" compara o
# começo do CNAE principal (ex.: "4731" para posto, "5611" para restaurante).
# Perfil sem o campo preenchido: a obrigação vale (o lado conservador).
NOT_APPLICABLE_LATERAL_SQL = """
  LEFT JOIN public.company_fiscal_profile fp ON fp.company_id = oi.company_id
  LEFT JOIN LATERAL (
    SELECT
      ot.rules_json->'not_applicable_when' AS r,
      CASE ot.rules_json->'not_applicable_when'->>'field'
        WHEN 'regime_tributario' THEN fp.regime_tributario
        WHEN 'faixa_funcionarios' THEN fp.faixa_funcionarios
        WHEN 'uf' THEN fp.uf
        WHEN 'tipo_juridico' THEN fp.tipo_juridico
        WHEN 'atividade' THEN fp.cnae_principal
        ELSE NULL
      END AS v
  ) naw ON true
  LEFT JOIN LATERAL (
    SELECT (
      naw.r IS NOT NULL
      AND fp.company_id IS NOT NULL
      AND naw.v IS NOT NULL
      AND (
        EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(naw.r->'in') AS p(x)
          WHERE CASE WHEN naw.r->>'field' = 'atividade' THEN naw.v LIKE p.x || '%' ELSE naw.v = p.x END
        ) IS DISTINCT FROM coalesce((naw.r->>'only')::boolean, false)
      )
    ) AS is_not_applicable
  ) na ON true
"""

EFFECTIVE_STATUS_SQL = """
  CASE
    WHEN oi.status IN ('reviewing', 'dispensado', 'cancelado') THEN oi.status
    WHEN na.is_not_applicable THEN 'not_applicable'
    WHEN oi.status = 'approved' AND exp.expires_at IS NOT NULL AND exp.expires_at < CURRENT_DATE THEN 'expired'
    WHEN oi.status = 'approved' THEN 'approved'
    WHEN bl.blocking_templates IS NOT NULL THEN 'blocked'
    WHEN oi.due_date < CURRENT_DATE THEN 'overdue'
    WHEN oi.due_date <= CURRENT_DATE + GREATEST(ot.sla_days, 0) THEN 'at_risk'
    ELSE 'pending'
  END AS effective_status,
  bl.blocking_templates,
  exp.expires_at AS document_expires_at
"""

_INSTANCE_SELECT = f"""
  SELECT oi.*, ot.name AS template_name, ot.criticality, ot.department, ot.weight, ot.frequency,
         ot.legal_basis, ot.requires_review, ot.description AS template_description,
         c.name AS company_name,
         owner.full_name AS owner_name, reviewer.full_name AS reviewer_name,
         {EFFECTIVE_STATUS_SQL},
         (SELECT count(*) FROM public.obligation_documents od WHERE od.obligation_instance_id = oi.id) AS document_count,
         (CURRENT_DATE - oi.due_date) AS days_late
  FROM public.obligation_instances oi
  JOIN public.obligation_templates ot ON ot.id = oi.template_id
  JOIN public.companies c ON c.id = oi.company_id
  LEFT JOIN public.users owner ON owner.id = oi.owner_id
  LEFT JOIN public.users reviewer ON reviewer.id = oi.reviewed_by
  {BLOCKING_LATERAL_SQL}
  {VALIDITY_LATERAL_SQL}
  {NOT_APPLICABLE_LATERAL_SQL}
"""

# Campos do modelo que podem ser alterados depois de criado.
TEMPLATE_EDITABLE = (
    "name", "description", "frequency", "criticality", "department", "sla_days", "weight", "validity_months",
    "rules_json", "active", "due_day", "due_month_offset", "due_month", "default_owner_id", "requires_review",
    "legal_basis",
)

# Competências que vencem até esta distância de hoje já aparecem na lista.
GENERATION_HORIZON_DAYS = 45

_GENERATE_SQL = """
WITH t AS (
  SELECT ot.* FROM public.obligation_templates ot
  WHERE ot.archived_at IS NULL AND ot.active AND ot.due_day IS NOT NULL
    AND ot.frequency IN ('mensal', 'anual')
    AND ($1::uuid IS NULL OR ot.company_id = $1)
    AND ($2::uuid IS NULL OR ot.id = $2)
), mensal AS (
  SELECT t.id AS template_id, t.company_id, t.default_owner_id, t.created_at,
         to_char(m, 'YYYY-MM') AS period,
         (date_trunc('month', m) + make_interval(months => t.due_month_offset))::date AS first_day
  FROM t, generate_series(date_trunc('month', t.created_at) - interval '2 months',
                          date_trunc('month', now()) + interval '2 months', interval '1 month') AS m
  WHERE t.frequency = 'mensal'
), anual AS (
  SELECT t.id AS template_id, t.company_id, t.default_owner_id, t.created_at,
         to_char(y, 'YYYY') AS period,
         make_date(extract(year FROM y)::int, t.due_month, 1) AS first_day
  FROM t, generate_series(date_trunc('year', t.created_at), date_trunc('year', now()) + interval '1 year', interval '1 year') AS y
  WHERE t.frequency = 'anual' AND t.due_month IS NOT NULL
), cand AS (
  SELECT c.template_id, c.company_id, c.default_owner_id, c.created_at, c.period,
         (c.first_day + (LEAST(tt.due_day, extract(day FROM (c.first_day + interval '1 month' - interval '1 day'))::int) - 1))::date AS due_date
  FROM (SELECT * FROM mensal UNION ALL SELECT * FROM anual) c
  JOIN t tt ON tt.id = c.template_id
)
INSERT INTO public.obligation_instances (template_id, company_id, period, due_date, owner_id)
SELECT template_id, company_id, period, due_date, default_owner_id
FROM cand
WHERE due_date >= created_at::date
  AND due_date <= CURRENT_DATE + $3::int
ON CONFLICT (template_id, period) DO NOTHING
RETURNING id
"""


class ObligationsService:
    # -------------------------------------------------------------------
    # Trilha (A7-03)
    # -------------------------------------------------------------------
    @staticmethod
    async def log(
        conn: asyncpg.Connection, *, user_id: str, company_id: UUID | str, action: str, item_id: UUID | str,
        name: str, metadata: dict[str, Any] | None = None,
    ) -> None:
        await conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
            VALUES ($1::uuid, $2::uuid, $3, 'obligation', $4::uuid, $5, 'obligation', $6::jsonb)
            """,
            user_id, str(company_id), action, str(item_id), name, json.dumps(metadata or {}, default=str),
        )

    # -------------------------------------------------------------------
    # Modelos
    # -------------------------------------------------------------------
    @staticmethod
    async def list_templates(conn: asyncpg.Connection, company_id: UUID, include_archived: bool = False) -> list[asyncpg.Record]:
        clause = "" if include_archived else "AND ot.archived_at IS NULL"
        return await conn.fetch(
            f"""
            SELECT ot.*, u.full_name AS default_owner_name,
                   (SELECT count(*) FROM public.obligation_instances oi WHERE oi.template_id = ot.id) AS instance_count
            FROM public.obligation_templates ot
            LEFT JOIN public.users u ON u.id = ot.default_owner_id
            WHERE ot.company_id = $1 {clause}
            ORDER BY ot.archived_at NULLS FIRST, ot.name
            """,
            company_id,
        )

    @staticmethod
    async def get_template(conn: asyncpg.Connection, template_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT * FROM public.obligation_templates WHERE id = $1", template_id)

    @staticmethod
    async def create_template(conn: asyncpg.Connection, *, company_id: UUID, created_by: str, **fields: Any) -> asyncpg.Record:
        cols = [k for k in TEMPLATE_EDITABLE if k in fields] + (["catalog_key"] if "catalog_key" in fields else [])
        values = [json.dumps(fields[k]) if k == "rules_json" else fields[k] for k in cols]
        placeholders = [f"${i + 3}::jsonb" if c == "rules_json" else f"${i + 3}" for i, c in enumerate(cols)]
        return await conn.fetchrow(
            f"""
            INSERT INTO public.obligation_templates (company_id, created_by, {", ".join(cols)})
            VALUES ($1, $2, {", ".join(placeholders)})
            RETURNING *
            """,
            company_id, created_by, *values,
        )

    @staticmethod
    async def update_template(conn: asyncpg.Connection, template_id: UUID, changes: dict[str, Any]) -> asyncpg.Record:
        cols = [k for k in TEMPLATE_EDITABLE if k in changes]
        if not cols:
            return await ObligationsService.get_template(conn, template_id)
        sets = [f"{c} = ${i + 2}::jsonb" if c == "rules_json" else f"{c} = ${i + 2}" for i, c in enumerate(cols)]
        values = [json.dumps(changes[c]) if c == "rules_json" else changes[c] for c in cols]
        return await conn.fetchrow(
            f"UPDATE public.obligation_templates SET {', '.join(sets)} WHERE id = $1 RETURNING *",
            template_id, *values,
        )

    @staticmethod
    async def archive_template(conn: asyncpg.Connection, template_id: UUID, restore: bool = False) -> None:
        await conn.execute(
            "UPDATE public.obligation_templates SET archived_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1",
            template_id, restore,
        )

    @staticmethod
    async def existing_catalog_keys(conn: asyncpg.Connection, company_id: UUID) -> set[str]:
        rows = await conn.fetch(
            "SELECT catalog_key FROM public.obligation_templates WHERE company_id = $1 AND catalog_key IS NOT NULL AND archived_at IS NULL",
            company_id,
        )
        return {r["catalog_key"] for r in rows}

    # -------------------------------------------------------------------
    # Recorrência
    # -------------------------------------------------------------------
    @staticmethod
    async def generate_due_instances(
        conn: asyncpg.Connection, *, company_id: UUID | None = None, template_id: UUID | None = None,
        horizon_days: int = GENERATION_HORIZON_DAYS,
    ) -> int:
        rows = await conn.fetch(_GENERATE_SQL, company_id, template_id, horizon_days)
        return len(rows)

    # -------------------------------------------------------------------
    # Dependências
    # -------------------------------------------------------------------
    @staticmethod
    async def list_dependencies(conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT otd.*, t.name AS template_name, dep.name AS depends_on_name
            FROM public.obligation_template_dependencies otd
            JOIN public.obligation_templates t ON t.id = otd.template_id
            JOIN public.obligation_templates dep ON dep.id = otd.depends_on_template_id
            WHERE otd.company_id = $1 AND t.archived_at IS NULL AND dep.archived_at IS NULL
            ORDER BY t.name
            """,
            company_id,
        )

    @staticmethod
    async def get_dependency(conn: asyncpg.Connection, dependency_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT otd.*, t.name AS template_name, dep.name AS depends_on_name
            FROM public.obligation_template_dependencies otd
            JOIN public.obligation_templates t ON t.id = otd.template_id
            JOIN public.obligation_templates dep ON dep.id = otd.depends_on_template_id
            WHERE otd.id = $1
            """,
            dependency_id,
        )

    @staticmethod
    async def add_dependency(
        conn: asyncpg.Connection, *, company_id: UUID, template_id: UUID, depends_on_template_id: UUID, created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.obligation_template_dependencies (company_id, template_id, depends_on_template_id, created_by)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            company_id, template_id, depends_on_template_id, created_by,
        )

    @staticmethod
    async def remove_dependency(conn: asyncpg.Connection, dependency_id: UUID) -> None:
        await conn.execute("DELETE FROM public.obligation_template_dependencies WHERE id = $1", dependency_id)

    # -------------------------------------------------------------------
    # Competências
    # -------------------------------------------------------------------
    @staticmethod
    async def list_instances(
        conn: asyncpg.Connection, company_id: UUID, *, status: str | None = None, template_id: UUID | None = None,
        owner_id: str | None = None, history: bool = False, include_archived: bool = False,
    ) -> list[asyncpg.Record]:
        """
        Sem `history`: as abertas de qualquer data e as fechadas dos últimos
        13 meses (A7-26/A7-35: anos de competências mensais não descem todos).
        Modelos arquivados ficam de fora (A7-27).
        """
        conditions = ["oi.company_id = $1"]
        params: list[Any] = [company_id]
        if template_id is not None:
            params.append(template_id)
            conditions.append(f"oi.template_id = ${len(params)}")
        if owner_id is not None:
            params.append(owner_id)
            conditions.append(f"oi.owner_id = ${len(params)}::uuid")
        if not include_archived:
            conditions.append("ot.archived_at IS NULL")
        if not history:
            conditions.append("(oi.status IN ('pending', 'reviewing') OR oi.due_date >= CURRENT_DATE - interval '13 months')")
        rows = await conn.fetch(
            f"{_INSTANCE_SELECT} WHERE {' AND '.join(conditions)} ORDER BY oi.due_date, ot.name",
            *params,
        )
        if status is not None:
            rows = [r for r in rows if r["effective_status"] == status]
        return rows

    @staticmethod
    async def list_group_open(conn: asyncpg.Connection, user_id: str, owner_only: bool = False) -> list[asyncpg.Record]:
        """
        Visão do grupo (A7-09): as competências abertas de todas as empresas
        que a pessoa acessa, numa lista só. A RLS limita às empresas dela.
        """
        return await conn.fetch(
            f"""
            {_INSTANCE_SELECT}
            WHERE ot.archived_at IS NULL AND c.is_active
              AND oi.company_id IN (SELECT company_id FROM public.user_company_access WHERE user_id = $1::uuid)
              AND (oi.status IN ('pending', 'reviewing') OR oi.due_date >= CURRENT_DATE - interval '13 months')
              AND (NOT $2::boolean OR oi.owner_id = $1::uuid)
            ORDER BY oi.due_date, c.name, ot.name
            LIMIT 1000
            """,
            user_id, owner_only,
        )

    @staticmethod
    async def get_instance(conn: asyncpg.Connection, instance_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(f"{_INSTANCE_SELECT} WHERE oi.id = $1", instance_id)

    @staticmethod
    async def create_instance(
        conn: asyncpg.Connection, *, template_id: UUID, company_id: UUID, period: str, due_date, owner_id: str | None,
        notes: str | None = None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.obligation_instances (template_id, company_id, period, due_date, owner_id, notes)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            """,
            template_id, company_id, period, due_date, owner_id, notes,
        )

    @staticmethod
    async def update_instance(conn: asyncpg.Connection, instance_id: UUID, changes: dict[str, Any]) -> asyncpg.Record:
        cols = [c for c in ("owner_id", "notes", "due_date") if c in changes]
        sets = [f"{c} = ${i + 2}" for i, c in enumerate(cols)]
        return await conn.fetchrow(
            f"UPDATE public.obligation_instances SET {', '.join(sets)} WHERE id = $1 RETURNING *",
            instance_id, *[changes[c] for c in cols],
        )

    @staticmethod
    async def set_instance_status(
        conn: asyncpg.Connection, instance_id: UUID, *, status: str, dispensa_motivo: str | None,
        reviewed_by: str | None = None, review_note: str | None = None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            UPDATE public.obligation_instances
            SET status = $2,
                dispensa_motivo = $3,
                reviewed_by = COALESCE($4::uuid, reviewed_by),
                reviewed_at = CASE WHEN $4::uuid IS NOT NULL THEN now() ELSE reviewed_at END,
                review_note = CASE WHEN $4::uuid IS NOT NULL THEN $5 ELSE review_note END,
                satisfied_at = CASE WHEN $2 = 'approved' THEN COALESCE(satisfied_at, now()) ELSE satisfied_at END
            WHERE id = $1
            RETURNING *
            """,
            instance_id, status, dispensa_motivo, reviewed_by, review_note,
        )

    # -------------------------------------------------------------------
    # Documentos comprobatórios
    # -------------------------------------------------------------------
    @staticmethod
    async def list_instance_documents(conn: asyncpg.Connection, instance_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT od.*, d.name AS document_name, d.folder_id::text AS folder_id, f.name AS folder_name,
                   d.created_at AS document_created_at, u.full_name AS linked_by_name
            FROM public.obligation_documents od
            JOIN public.documents d ON d.id = od.document_id AND d.deleted_at IS NULL
            LEFT JOIN public.folders f ON f.id = d.folder_id
            LEFT JOIN public.users u ON u.id = od.linked_by
            WHERE od.obligation_instance_id = $1
            ORDER BY od.linked_at DESC
            """,
            instance_id,
        )

    @staticmethod
    async def list_document_obligations(conn: asyncpg.Connection, document_id: UUID) -> list[asyncpg.Record]:
        """Obrigações que este documento comprova (para o painel do documento, A7-54)."""
        return await conn.fetch(
            f"""
            {_INSTANCE_SELECT}
            JOIN public.obligation_documents od2 ON od2.obligation_instance_id = oi.id
            WHERE od2.document_id = $1
            ORDER BY oi.due_date DESC
            """,
            document_id,
        )

    @staticmethod
    async def link_document(
        conn: asyncpg.Connection, instance_id: UUID, document_id: UUID, linked_by: str, valid_until=None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.obligation_documents (obligation_instance_id, document_id, linked_by, valid_until)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            instance_id, document_id, linked_by, valid_until,
        )

    @staticmethod
    async def unlink_document(conn: asyncpg.Connection, instance_id: UUID, document_id: UUID) -> int:
        result = await conn.execute(
            "DELETE FROM public.obligation_documents WHERE obligation_instance_id = $1 AND document_id = $2",
            instance_id, document_id,
        )
        return int(result.split()[-1])

    @staticmethod
    async def history(conn: asyncpg.Connection, instance_id: UUID, template_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT al.id::text, al.action, al.metadata, al.created_at, u.full_name AS user_name
            FROM public.activity_log al
            LEFT JOIN public.users u ON u.id = al.user_id
            WHERE al.item_type = 'obligation' AND al.item_id IN ($1, $2)
            ORDER BY al.created_at DESC
            LIMIT 50
            """,
            instance_id, template_id,
        )
