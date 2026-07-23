"""
Fase 4.1 — Modelo de Obrigações (Obrigação → Documento comprobatório).

`obligation_instances.status` só guarda os estados que nascem de ação humana
(reviewing/approved/dispensado/cancelado) ou o default 'pending'. Os estados
derivados do prazo (pending/at_risk/overdue) são calculados na leitura — não
persistidos — porque dependem de "hoje", não de um evento; persistir exigiria
um job de recorrência que ainda não existe (fica para a Fase 4.5, junto dos
alertas idempotentes). `effective_status` é o campo que a UI deve usar.

Fase 4.2 (parte 1) — dependências entre obrigações: uma instância cujo
template depende de outro (ex.: SPED depende de NF) fica com
`effective_status = 'blocked'` enquanto a instância do pré-requisito, no
MESMO período, não estiver `approved`/`dispensado`. Regras condicionais
(depende de perfil fiscal que a empresa não guarda hoje), matriz 2D (4.4) e
Self-Service Collect (4.6) não fazem parte desta fatia.
"""
import json
from typing import Any
from uuid import UUID

import asyncpg

# LATERAL: pra cada instância, agrega os nomes dos templates dos quais ela
# depende e que ainda não foram satisfeitos no mesmo período (dep_oi.id IS
# NULL = pré-requisito nem tem instância gerada ainda nesse período).
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

EFFECTIVE_STATUS_SQL = """
  CASE
    WHEN oi.status IN ('reviewing', 'approved', 'dispensado', 'cancelado') THEN oi.status
    WHEN bl.blocking_templates IS NOT NULL THEN 'blocked'
    WHEN oi.due_date < CURRENT_DATE THEN 'overdue'
    WHEN oi.due_date <= CURRENT_DATE + GREATEST(ot.sla_days, 0) THEN 'at_risk'
    ELSE 'pending'
  END AS effective_status,
  bl.blocking_templates
"""


class ObligationsService:
    # -------------------------------------------------------------------
    # Templates
    # -------------------------------------------------------------------
    @staticmethod
    async def list_templates(conn: asyncpg.Connection, company_id: UUID, include_archived: bool = False) -> list[asyncpg.Record]:
        clause = "" if include_archived else "AND archived_at IS NULL"
        return await conn.fetch(
            f"""
            SELECT * FROM public.obligation_templates
            WHERE company_id = $1 {clause}
            ORDER BY name
            """,
            company_id,
        )

    @staticmethod
    async def get_template(conn: asyncpg.Connection, template_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT * FROM public.obligation_templates WHERE id = $1", template_id)

    @staticmethod
    async def create_template(
        conn: asyncpg.Connection, *, company_id: UUID, name: str, description: str | None,
        frequency: str, criticality: str, department: str | None, sla_days: int, weight: int,
        rules_json: dict[str, Any], created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.obligation_templates
              (company_id, name, description, frequency, criticality, department, sla_days, weight, rules_json, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
            RETURNING *
            """,
            company_id, name, description, frequency, criticality, department, sla_days, weight,
            json.dumps(rules_json), created_by,
        )

    @staticmethod
    async def update_template(
        conn: asyncpg.Connection, template_id: UUID, *, name: str | None, description: str | None,
        criticality: str | None, department: str | None, sla_days: int | None, weight: int | None, active: bool | None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            UPDATE public.obligation_templates
            SET name = COALESCE($2, name),
                description = COALESCE($3, description),
                criticality = COALESCE($4, criticality),
                department = COALESCE($5, department),
                sla_days = COALESCE($6, sla_days),
                weight = COALESCE($7, weight),
                active = COALESCE($8, active)
            WHERE id = $1
            RETURNING *
            """,
            template_id, name, description, criticality, department, sla_days, weight, active,
        )

    @staticmethod
    async def archive_template(conn: asyncpg.Connection, template_id: UUID) -> None:
        await conn.execute("UPDATE public.obligation_templates SET archived_at = now() WHERE id = $1", template_id)

    # -------------------------------------------------------------------
    # Dependências entre templates (Fase 4.2)
    # -------------------------------------------------------------------
    @staticmethod
    async def list_dependencies(conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT otd.*, t.name AS template_name, dep.name AS depends_on_name
            FROM public.obligation_template_dependencies otd
            JOIN public.obligation_templates t ON t.id = otd.template_id
            JOIN public.obligation_templates dep ON dep.id = otd.depends_on_template_id
            WHERE otd.company_id = $1
            ORDER BY t.name
            """,
            company_id,
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
    # Instances
    # -------------------------------------------------------------------
    @staticmethod
    async def list_instances(
        conn: asyncpg.Connection, company_id: UUID, *, status: str | None = None, template_id: UUID | None = None,
    ) -> list[asyncpg.Record]:
        conditions = ["oi.company_id = $1"]
        params: list[Any] = [company_id]
        if template_id is not None:
            params.append(template_id)
            conditions.append(f"oi.template_id = ${len(params)}")

        rows = await conn.fetch(
            f"""
            SELECT oi.*, ot.name AS template_name, ot.criticality, ot.department, ot.weight,
                   {EFFECTIVE_STATUS_SQL},
                   (SELECT count(*) FROM public.obligation_documents od WHERE od.obligation_instance_id = oi.id) AS document_count
            FROM public.obligation_instances oi
            JOIN public.obligation_templates ot ON ot.id = oi.template_id
            {BLOCKING_LATERAL_SQL}
            WHERE {' AND '.join(conditions)}
            ORDER BY oi.due_date
            """,
            *params,
        )
        if status is not None:
            rows = [r for r in rows if r["effective_status"] == status]
        return rows

    @staticmethod
    async def get_instance(conn: asyncpg.Connection, instance_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            f"""
            SELECT oi.*, ot.name AS template_name, ot.criticality, ot.department, ot.weight,
                   {EFFECTIVE_STATUS_SQL}
            FROM public.obligation_instances oi
            JOIN public.obligation_templates ot ON ot.id = oi.template_id
            {BLOCKING_LATERAL_SQL}
            WHERE oi.id = $1
            """,
            instance_id,
        )

    @staticmethod
    async def create_instance(
        conn: asyncpg.Connection, *, template_id: UUID, company_id: UUID, period: str, due_date, owner_id: str | None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.obligation_instances (template_id, company_id, period, due_date, owner_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            template_id, company_id, period, due_date, owner_id,
        )

    @staticmethod
    async def set_instance_status(
        conn: asyncpg.Connection, instance_id: UUID, *, status: str, dispensa_motivo: str | None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            UPDATE public.obligation_instances
            SET status = $2, dispensa_motivo = $3
            WHERE id = $1
            RETURNING *
            """,
            instance_id, status, dispensa_motivo,
        )

    # -------------------------------------------------------------------
    # Documentos comprobatórios
    # -------------------------------------------------------------------
    @staticmethod
    async def list_instance_documents(conn: asyncpg.Connection, instance_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT od.*, d.name AS document_name
            FROM public.obligation_documents od
            JOIN public.documents d ON d.id = od.document_id
            WHERE od.obligation_instance_id = $1
            ORDER BY od.linked_at
            """,
            instance_id,
        )

    @staticmethod
    async def link_document(conn: asyncpg.Connection, instance_id: UUID, document_id: UUID, linked_by: str) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.obligation_documents (obligation_instance_id, document_id, linked_by)
            VALUES ($1, $2, $3)
            RETURNING *
            """,
            instance_id, document_id, linked_by,
        )

    @staticmethod
    async def unlink_document(conn: asyncpg.Connection, instance_id: UUID, document_id: UUID) -> None:
        await conn.execute(
            "DELETE FROM public.obligation_documents WHERE obligation_instance_id = $1 AND document_id = $2",
            instance_id, document_id,
        )
