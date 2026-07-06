"""
CompaniesService — CRUD de empresas, membros/concessões de acesso, retenção.
Conexões admin usadas aqui são deliberadas: criação de empresa e criação de
usuário (chamada ao Supabase Auth) precisam ocorrer antes de qualquer
contexto RLS do novo recurso existir; gestão de acesso de outros usuários
nunca pode depender da sessão RLS do próprio ator.
"""
from typing import Any
from uuid import UUID

import asyncpg


class CompaniesService:
    @staticmethod
    async def user_manages_company(conn: asyncpg.Connection, user_id: str, company_id: UUID) -> bool:
        return bool(await conn.fetchval(
            """
            SELECT EXISTS (
              SELECT 1 FROM public.user_company_access
              WHERE user_id = $1 AND company_id = $2
                AND permission_level = 'admin' AND folder_path IS NULL
            )
            """,
            user_id, company_id,
        ))

    @staticmethod
    async def list_companies(conn: asyncpg.Connection) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              c.id::text,
              c.name,
              c.created_at,
              uca.permission_level
            FROM public.companies c
            JOIN public.user_company_access uca
              ON uca.company_id = c.id
             AND uca.user_id    = auth.uid()
             AND uca.folder_path IS NULL
            ORDER BY c.name
            """
        )

    @staticmethod
    async def list_organizations_all(admin_conn: asyncpg.Connection) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              c.id::text, c.name, c.cnpj, c.logo_key, c.is_active, c.created_at,
              (SELECT COUNT(*) FROM public.documents d WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS document_count,
              (SELECT COUNT(*) FROM public.user_company_access uca WHERE uca.company_id = c.id AND uca.folder_path IS NULL) AS user_count
            FROM public.companies c
            ORDER BY c.name
            """
        )

    @staticmethod
    async def list_organizations_managed_by(admin_conn: asyncpg.Connection, user_id: str) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              c.id::text, c.name, c.cnpj, c.logo_key, c.is_active, c.created_at,
              (SELECT COUNT(*) FROM public.documents d WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS document_count,
              (SELECT COUNT(*) FROM public.user_company_access uca WHERE uca.company_id = c.id AND uca.folder_path IS NULL) AS user_count
            FROM public.companies c
            JOIN public.user_company_access mine
              ON mine.company_id = c.id AND mine.user_id = $1
             AND mine.permission_level = 'admin' AND mine.folder_path IS NULL
            ORDER BY c.name
            """,
            user_id,
        )

    @staticmethod
    async def get_company(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT c.id::text, c.name, c.created_at FROM public.companies c WHERE c.id = $1",
            company_id,
        )

    @staticmethod
    async def create_company(admin_conn: asyncpg.Connection, *, name: str, user_id: str) -> asyncpg.Record:
        async with admin_conn.transaction():
            company = await admin_conn.fetchrow(
                "INSERT INTO public.companies (name) VALUES ($1) RETURNING id::text, name, created_at",
                name,
            )
            await admin_conn.execute(
                """
                INSERT INTO public.user_company_access
                  (user_id, company_id, folder_path, permission_level, granted_by)
                VALUES ($1, $2::uuid, NULL, 'admin', $1)
                """,
                user_id, company["id"],
            )
        return company

    @staticmethod
    async def list_members(conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              uca.id::text AS access_id,
              uca.user_id::text,
              uca.permission_level AS role,
              u.full_name,
              u.username,
              uca.created_at,
              f.id::text AS folder_id,
              f.name AS folder_name
            FROM public.user_company_access uca
            JOIN public.users u ON u.id = uca.user_id
            LEFT JOIN public.folders f ON f.path = uca.folder_path AND f.company_id = uca.company_id
            WHERE uca.company_id = $1
            ORDER BY u.full_name, f.name NULLS FIRST
            """,
            company_id,
        )

    @staticmethod
    async def get_stats(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            SELECT
              (SELECT COUNT(*) FROM public.documents d
               WHERE d.company_id = $1 AND d.deleted_at IS NULL) AS total_documents,
              (SELECT COUNT(*) FROM public.folders f
               WHERE f.company_id = $1 AND f.deleted_at IS NULL) AS total_folders,
              (SELECT COUNT(*) FROM public.favorites fav
               JOIN public.documents d ON d.id = fav.document_id
               WHERE d.company_id = $1 AND fav.user_id = auth.uid()) AS total_favorites,
              (SELECT COUNT(*) FROM public.documents d
               WHERE d.company_id = $1 AND d.deleted_at IS NULL
                 AND d.created_at >= now() - interval '7 days') AS recent_uploads
            """,
            company_id,
        )

    @staticmethod
    async def update_company(
        admin_conn: asyncpg.Connection, *, company_id: UUID, name: str | None,
        cnpj_provided: bool, cnpj: str | None, is_active: bool | None, logo_key: str | None,
    ) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            """
            UPDATE public.companies
            SET name      = COALESCE($2, name),
                cnpj      = CASE WHEN $3::boolean THEN $4 ELSE cnpj END,
                is_active = COALESCE($5, is_active),
                logo_key  = COALESCE($6, logo_key)
            WHERE id = $1
            RETURNING id::text, name, cnpj, logo_key, is_active, created_at
            """,
            company_id, name, cnpj_provided, cnpj, is_active, logo_key,
        )

    @staticmethod
    async def get_logo_key(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT logo_key FROM public.companies WHERE id = $1", company_id)

    @staticmethod
    async def username_exists(admin_conn: asyncpg.Connection, username: str) -> bool:
        return bool(await admin_conn.fetchval("SELECT id FROM public.users WHERE username = $1", username))

    @staticmethod
    async def get_folder_path(admin_conn: asyncpg.Connection, folder_id: UUID, company_id: UUID) -> str | None:
        return await admin_conn.fetchval(
            "SELECT path FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
            folder_id, company_id,
        )

    @staticmethod
    async def insert_user(admin_conn: asyncpg.Connection, *, user_id: str, username: str, full_name: str) -> None:
        await admin_conn.execute(
            "INSERT INTO public.users (id, username, full_name, role) VALUES ($1::uuid, $2, $3, 'usuario')",
            user_id, username, full_name,
        )

    @staticmethod
    async def insert_access_grant(
        admin_conn: asyncpg.Connection, *, user_id: UUID | str, company_id: UUID,
        permission_level: str, folder_path: str | None, granted_by: str,
    ) -> asyncpg.Record:
        return await admin_conn.fetchrow(
            """
            INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path, granted_by)
            VALUES ($1::uuid, $2, $3, $4::ltree, $5::uuid)
            RETURNING id::text, user_id::text, company_id::text, permission_level, created_at
            """,
            user_id, company_id, permission_level, folder_path, granted_by,
        )

    @staticmethod
    async def member_exists(admin_conn: asyncpg.Connection, member_id: UUID, company_id: UUID) -> bool:
        return bool(await admin_conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)",
            member_id, company_id,
        ))

    @staticmethod
    async def get_access_grant(admin_conn: asyncpg.Connection, access_id: UUID, company_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT user_id FROM public.user_company_access WHERE id = $1 AND company_id = $2",
            access_id, company_id,
        )

    @staticmethod
    async def count_grants_for_user(admin_conn: asyncpg.Connection, user_id, company_id: UUID) -> int:
        return await admin_conn.fetchval(
            "SELECT count(*) FROM public.user_company_access WHERE user_id = $1 AND company_id = $2",
            user_id, company_id,
        )

    @staticmethod
    async def delete_access_grant(admin_conn: asyncpg.Connection, access_id: UUID) -> None:
        await admin_conn.execute("DELETE FROM public.user_company_access WHERE id = $1", access_id)

    @staticmethod
    async def delete_member(admin_conn: asyncpg.Connection, member_id: UUID, company_id: UUID) -> None:
        await admin_conn.execute(
            "DELETE FROM public.user_company_access WHERE user_id = $1 AND company_id = $2",
            member_id, company_id,
        )

    @staticmethod
    async def get_retention(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT retention_days FROM public.companies WHERE id = $1", company_id)

    @staticmethod
    async def update_retention(
        admin_conn: asyncpg.Connection, *, company_id: UUID, retention_days: int, carencia_dias: int,
    ) -> None:
        async with admin_conn.transaction():
            await admin_conn.execute(
                "UPDATE public.companies SET retention_days = $2 WHERE id = $1",
                company_id, retention_days,
            )
            await admin_conn.execute(
                """
                UPDATE public.documents
                SET trash_expires_at = deleted_at + ($2 * interval '1 day')
                WHERE company_id = $1 AND deleted_at IS NOT NULL
                  AND deleted_at > now() - ($3 * interval '1 day')
                """,
                company_id, retention_days, carencia_dias,
            )
            await admin_conn.execute(
                """
                UPDATE public.folders
                SET trash_expires_at = deleted_at + ($2 * interval '1 day')
                WHERE company_id = $1 AND deleted_at IS NOT NULL
                  AND deleted_at > now() - ($3 * interval '1 day')
                """,
                company_id, retention_days, carencia_dias,
            )
