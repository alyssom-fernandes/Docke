"""
Fase 5.1-5.3 — Retenção legal: política / atribuição / hold / fila de revisão.

Nada aqui apaga um documento. Ver comentário de cabeçalho da migration
20260723000026_retention_model.sql para o raciocínio completo.
"""
from typing import Any
from uuid import UUID

import asyncpg


class RetentionService:
    # -------------------------------------------------------------------
    # Políticas
    # -------------------------------------------------------------------
    @staticmethod
    async def list_policies(conn: asyncpg.Connection, company_id: UUID, include_archived: bool = False) -> list[asyncpg.Record]:
        clause = "" if include_archived else "AND archived_at IS NULL"
        return await conn.fetch(
            f"SELECT * FROM public.retention_policies WHERE company_id = $1 {clause} ORDER BY name", company_id,
        )

    @staticmethod
    async def get_policy(conn: asyncpg.Connection, policy_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT * FROM public.retention_policies WHERE id = $1", policy_id)

    @staticmethod
    async def create_policy(
        conn: asyncpg.Connection, *, company_id: UUID, name: str, legal_basis: str | None,
        trigger_type: str, trigger_custom_field_id: UUID | None, duration_months: int | None,
        locked: bool, created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.retention_policies
              (company_id, name, legal_basis, trigger_type, trigger_custom_field_id, duration_months, locked, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *
            """,
            company_id, name, legal_basis, trigger_type, trigger_custom_field_id, duration_months, locked, created_by,
        )

    @staticmethod
    async def archive_policy(conn: asyncpg.Connection, policy_id: UUID) -> None:
        await conn.execute("UPDATE public.retention_policies SET archived_at = now() WHERE id = $1", policy_id)

    # -------------------------------------------------------------------
    # Atribuições
    # -------------------------------------------------------------------
    @staticmethod
    async def list_assignments(conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT rpa.*, rp.name AS policy_name
            FROM public.retention_policy_assignments rpa
            JOIN public.retention_policies rp ON rp.id = rpa.policy_id
            WHERE rpa.company_id = $1
            ORDER BY rpa.folder_path NULLS FIRST
            """,
            company_id,
        )

    @staticmethod
    async def create_assignment(
        conn: asyncpg.Connection, *, company_id: UUID, folder_path: str | None, policy_id: UUID, created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.retention_policy_assignments (company_id, folder_path, policy_id, created_by)
            VALUES ($1, $2, $3, $4)
            RETURNING *
            """,
            company_id, folder_path, policy_id, created_by,
        )

    @staticmethod
    async def remove_assignment(conn: asyncpg.Connection, assignment_id: UUID) -> None:
        await conn.execute("DELETE FROM public.retention_policy_assignments WHERE id = $1", assignment_id)

    # -------------------------------------------------------------------
    # Legal holds
    # -------------------------------------------------------------------
    @staticmethod
    async def list_holds(conn: asyncpg.Connection, company_id: UUID, active_only: bool = True) -> list[asyncpg.Record]:
        clause = "AND released_at IS NULL" if active_only else ""
        return await conn.fetch(
            f"SELECT * FROM public.legal_holds WHERE company_id = $1 {clause} ORDER BY created_at DESC", company_id,
        )

    @staticmethod
    async def create_hold(
        conn: asyncpg.Connection, *, company_id: UUID, resource_type: str, resource_id: UUID, reason: str, created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.legal_holds (company_id, resource_type, resource_id, reason, created_by)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
            """,
            company_id, resource_type, resource_id, reason, created_by,
        )

    @staticmethod
    async def release_hold(conn: asyncpg.Connection, hold_id: UUID, released_by: str) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "UPDATE public.legal_holds SET released_at = now(), released_by = $2 WHERE id = $1 AND released_at IS NULL RETURNING *",
            hold_id, released_by,
        )

    @staticmethod
    async def document_is_under_hold(conn: asyncpg.Connection, document_id: UUID) -> bool:
        return bool(await conn.fetchval("SELECT public.document_is_under_hold($1)", document_id))

    @staticmethod
    async def folder_is_under_hold(conn: asyncpg.Connection, folder_id: UUID) -> bool:
        return bool(await conn.fetchval("SELECT public.folder_is_under_hold($1)", folder_id))

    # -------------------------------------------------------------------
    # Prazo calculado
    # -------------------------------------------------------------------
    @staticmethod
    async def get_document_retention_info(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT * FROM public.document_retention_info($1)", document_id)

    # -------------------------------------------------------------------
    # Fila de revisão (5.5 — só registro + decisão humana, sem executar exclusão)
    # -------------------------------------------------------------------
    @staticmethod
    async def list_queue(conn: asyncpg.Connection, company_id: UUID, status_filter: str | None = None) -> list[asyncpg.Record]:
        conditions = ["q.company_id = $1"]
        params: list[Any] = [company_id]
        if status_filter is not None:
            params.append(status_filter)
            conditions.append(f"q.status = ${len(params)}")
        return await conn.fetch(
            f"""
            SELECT q.*, d.name AS document_name, d.deleted_at AS document_deleted_at
            FROM public.retention_review_queue q
            JOIN public.documents d ON d.id = q.document_id
            WHERE {' AND '.join(conditions)}
            ORDER BY q.computed_expires_at
            """,
            *params,
        )

    @staticmethod
    async def decide_queue_item(
        conn: asyncpg.Connection, queue_id: UUID, *, decision: str, notes: str | None,
        deferred_until: Any | None, reviewed_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            UPDATE public.retention_review_queue
            SET status = $2, review_notes = $3, deferred_until = $4, reviewed_by = $5, reviewed_at = now()
            WHERE id = $1
            RETURNING *
            """,
            queue_id, decision, notes, deferred_until, reviewed_by,
        )
