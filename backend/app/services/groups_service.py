"""
GroupsService — CRUD de grupos, membros do grupo e concessões de acesso do
grupo (Fase 9.2). Mesma convenção de CompaniesService: mutações usam
admin_conn (service role) porque a escrita nunca deve depender da sessão RLS
de quem está gerenciando — só a leitura (list_groups) passa por conn comum,
já que RLS já filtra por empresa sem risco.
"""
from typing import Any
from uuid import UUID

import asyncpg


class GroupsService:
    @staticmethod
    async def list_groups(conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              g.id::text,
              g.name,
              g.created_at,
              COUNT(DISTINCT gm.user_id) AS member_count,
              COUNT(DISTINCT ga.id) AS grant_count
            FROM public."group" g
            LEFT JOIN public.group_member gm ON gm.group_id = g.id
            LEFT JOIN public.group_access ga ON ga.group_id = g.id
            WHERE g.company_id = $1
            GROUP BY g.id, g.name, g.created_at
            ORDER BY g.name
            """,
            company_id,
        )

    @staticmethod
    async def get_group_detail(conn: asyncpg.Connection, group_id: UUID, company_id: UUID) -> dict[str, Any] | None:
        group = await conn.fetchrow(
            'SELECT id::text, name, created_at FROM public."group" WHERE id = $1 AND company_id = $2',
            group_id, company_id,
        )
        if group is None:
            return None
        members = await conn.fetch(
            """
            SELECT u.id::text AS user_id, u.full_name, u.username, gm.added_at
            FROM public.group_member gm
            JOIN public.users u ON u.id = gm.user_id
            WHERE gm.group_id = $1
            ORDER BY u.full_name
            """,
            group_id,
        )
        grants = await conn.fetch(
            """
            SELECT
              ga.id::text AS access_id,
              ga.permission_level AS role,
              ga.created_at,
              f.id::text AS folder_id,
              f.name AS folder_name
            FROM public.group_access ga
            LEFT JOIN public.folders f ON f.path = ga.folder_path AND f.company_id = ga.company_id
            WHERE ga.group_id = $1
            ORDER BY ga.folder_path NULLS FIRST
            """,
            group_id,
        )
        return {**dict(group), "members": [dict(m) for m in members], "grants": [dict(g) for g in grants]}

    @staticmethod
    async def create_group(admin_conn: asyncpg.Connection, *, company_id: UUID, name: str, created_by: str) -> asyncpg.Record:
        return await admin_conn.fetchrow(
            'INSERT INTO public."group" (company_id, name, created_by) VALUES ($1, $2, $3::uuid) '
            "RETURNING id::text, name, created_at",
            company_id, name, created_by,
        )

    @staticmethod
    async def name_exists(admin_conn: asyncpg.Connection, company_id: UUID, name: str) -> bool:
        return bool(await admin_conn.fetchval(
            'SELECT EXISTS (SELECT 1 FROM public."group" WHERE company_id = $1 AND name = $2)',
            company_id, name,
        ))

    @staticmethod
    async def group_exists(admin_conn: asyncpg.Connection, group_id: UUID, company_id: UUID) -> bool:
        return bool(await admin_conn.fetchval(
            'SELECT EXISTS (SELECT 1 FROM public."group" WHERE id = $1 AND company_id = $2)',
            group_id, company_id,
        ))

    @staticmethod
    async def delete_group(admin_conn: asyncpg.Connection, group_id: UUID) -> None:
        # ON DELETE CASCADE cuida de group_member e group_access.
        await admin_conn.execute('DELETE FROM public."group" WHERE id = $1', group_id)

    @staticmethod
    async def member_of_company(admin_conn: asyncpg.Connection, user_id: UUID, company_id: UUID) -> bool:
        return bool(await admin_conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)",
            user_id, company_id,
        ))

    @staticmethod
    async def add_member(admin_conn: asyncpg.Connection, group_id: UUID, user_id: UUID) -> None:
        await admin_conn.execute(
            "INSERT INTO public.group_member (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            group_id, user_id,
        )

    @staticmethod
    async def remove_member(admin_conn: asyncpg.Connection, group_id: UUID, user_id: UUID) -> None:
        await admin_conn.execute(
            "DELETE FROM public.group_member WHERE group_id = $1 AND user_id = $2",
            group_id, user_id,
        )

    @staticmethod
    async def get_folder_path(admin_conn: asyncpg.Connection, folder_id: UUID, company_id: UUID) -> str | None:
        return await admin_conn.fetchval(
            "SELECT path FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
            folder_id, company_id,
        )

    @staticmethod
    async def insert_access_grant(
        admin_conn: asyncpg.Connection, *, group_id: UUID, company_id: UUID,
        permission_level: str, folder_path: str | None, granted_by: str,
    ) -> asyncpg.Record:
        return await admin_conn.fetchrow(
            """
            INSERT INTO public.group_access (group_id, company_id, permission_level, folder_path, granted_by)
            VALUES ($1, $2, $3, $4::ltree, $5::uuid)
            ON CONFLICT (group_id, company_id, folder_path)
            DO UPDATE SET permission_level = EXCLUDED.permission_level
            RETURNING id::text, group_id::text, company_id::text, permission_level, created_at
            """,
            group_id, company_id, permission_level, folder_path, granted_by,
        )

    @staticmethod
    async def get_access_grant(admin_conn: asyncpg.Connection, access_id: UUID, company_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT group_id FROM public.group_access WHERE id = $1 AND company_id = $2",
            access_id, company_id,
        )

    @staticmethod
    async def delete_access_grant(admin_conn: asyncpg.Connection, access_id: UUID) -> None:
        await admin_conn.execute("DELETE FROM public.group_access WHERE id = $1", access_id)
