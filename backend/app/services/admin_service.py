"""
AdminService — listagens e mutações administrativas. Usa a conexão admin
(service role) deliberadamente: algumas consultas são cross-empresa e a RLS
por company_id nunca as permitiria. Por isso quem chama (routers/admin.py)
confere antes o alcance: sistema inteiro só para o Supremo, uma empresa só
para o admin dela (achado A9-40).
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
    async def folder_path_in_company(admin_conn: asyncpg.Connection, company_id: UUID, folder_path: str) -> bool:
        """O caminho de pasta existe nesta empresa? (concessão só vale para pasta da própria empresa)."""
        try:
            return bool(await admin_conn.fetchval(
                "SELECT EXISTS (SELECT 1 FROM public.folders WHERE company_id = $1 AND path = $2::ltree)",
                company_id, folder_path,
            ))
        except asyncpg.PostgresError:
            return False  # caminho malformado para ltree

    @staticmethod
    async def upsert_permission(
        admin_conn: asyncpg.Connection, *, user_id: UUID, company_id: UUID, permission_level: str,
        folder_path: str | None, granted_by: str,
    ) -> asyncpg.Record:
        # Os índices únicos são parciais (migration 20260722000014): um para a
        # concessão da empresa toda (folder_path IS NULL) e outro por pasta. O
        # ON CONFLICT só encontra um índice parcial com o mesmo WHERE dele.
        conflict = (
            "(user_id, company_id) WHERE folder_path IS NULL"
            if folder_path is None
            else "(user_id, company_id, folder_path) WHERE folder_path IS NOT NULL"
        )
        return await admin_conn.fetchrow(
            f"""
            INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path, granted_by)
            VALUES ($1, $2, $3, $4::ltree, $5::uuid)
            ON CONFLICT {conflict}
            DO UPDATE SET permission_level = EXCLUDED.permission_level, granted_by = EXCLUDED.granted_by
            RETURNING id::text, user_id::text, company_id::text, permission_level, folder_path::text, created_at
            """,
            user_id, company_id, permission_level, folder_path, granted_by,
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
