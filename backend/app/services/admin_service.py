"""
AdminService — listagens e mutações globais (todas as empresas), restritas a
admin/supremo. Usa a conexão admin (service role) deliberadamente: são
consultas cross-empresa que a RLS por company_id nunca permitiria para um
usuário comum, mesmo administrador de uma única empresa.
"""
from typing import Any
from uuid import UUID

import asyncpg


class AdminService:
    @staticmethod
    async def list_users_by_company(admin_conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              u.id::text,
              u.username,
              u.full_name,
              uca.permission_level AS role,
              uca.company_id::text,
              u.created_at
            FROM public.users u
            JOIN public.user_company_access uca ON uca.user_id = u.id
            WHERE uca.company_id = $1
            ORDER BY u.full_name
            """,
            company_id,
        )

    @staticmethod
    async def list_all_users(admin_conn: asyncpg.Connection) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            "SELECT id::text, username, full_name, role, created_at FROM public.users ORDER BY full_name"
        )

    @staticmethod
    async def list_permissions(admin_conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              uca.id::text,
              uca.user_id::text,
              u.username,
              u.full_name,
              uca.company_id::text,
              uca.permission_level,
              uca.folder_path::text,
              uca.created_at
            FROM public.user_company_access uca
            JOIN public.users u ON u.id = uca.user_id
            WHERE uca.company_id = $1
            ORDER BY u.full_name, uca.folder_path
            """,
            company_id,
        )

    @staticmethod
    async def upsert_permission(
        admin_conn: asyncpg.Connection, *, user_id: UUID, company_id: UUID, permission_level: str, folder_path: str | None,
    ) -> asyncpg.Record:
        return await admin_conn.fetchrow(
            """
            INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path)
            VALUES ($1, $2, $3, $4::ltree)
            ON CONFLICT (user_id, company_id, folder_path)
            DO UPDATE SET permission_level = EXCLUDED.permission_level
            RETURNING id::text, user_id::text, company_id::text, permission_level, folder_path::text, created_at
            """,
            user_id, company_id, permission_level, folder_path,
        )

    @staticmethod
    async def storage_usage_by_company(admin_conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              c.id::text AS company_id,
              c.name AS company_name,
              COUNT(d.id) AS document_count,
              COALESCE(SUM(d.size_bytes), 0) AS total_bytes
            FROM public.companies c
            LEFT JOIN public.documents d ON d.company_id = c.id AND d.deleted_at IS NULL
            WHERE c.id = $1
            GROUP BY c.id, c.name
            """,
            company_id,
        )

    @staticmethod
    async def storage_usage_all(admin_conn: asyncpg.Connection) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              c.id::text AS company_id,
              c.name AS company_name,
              COUNT(d.id) AS document_count,
              COALESCE(SUM(d.size_bytes), 0) AS total_bytes
            FROM public.companies c
            LEFT JOIN public.documents d ON d.company_id = c.id AND d.deleted_at IS NULL
            GROUP BY c.id, c.name
            ORDER BY total_bytes DESC
            """
        )
