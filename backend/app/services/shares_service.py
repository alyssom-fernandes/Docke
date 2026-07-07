"""
SharesService — compartilhamento externo (ADR-022/027/031).
Rotas autenticadas usam conn (RLS). Rotas públicas usam admin_conn — não há
usuário logado nem JWT nessas chamadas, então não há contexto de RLS a aplicar.
"""
from datetime import datetime
from typing import Any
from uuid import UUID

import asyncpg


class SharesService:
    @staticmethod
    async def get_document_for_share(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id, company_id, current_version_id FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
            document_id,
        )

    @staticmethod
    async def get_folder_for_share(conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            folder_id,
        )

    @staticmethod
    async def insert_share(
        conn: asyncpg.Connection, *, resource_type: str, resource_id: UUID, company_id, token_hash: str,
        password_hash: str | None, expires_at: datetime | None, pin_to_version_id, created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.shares
              (resource_type, resource_id, company_id, token_hash, password_hash, expires_at, pin_to_version_id, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id::text, created_at
            """,
            resource_type, resource_id, company_id, token_hash, password_hash, expires_at, pin_to_version_id, created_by,
        )

    @staticmethod
    async def list_shares(
        conn: asyncpg.Connection, *, resource_type: str | None, resource_id: UUID | None, company_id: UUID | None = None,
    ) -> list[asyncpg.Record]:
        # RLS (shares_select) já garante que só retorna links próprios ou de
        # empresas onde o usuário é admin — o filtro de company_id aqui é só
        # pra tela "Compartilhados" mostrar uma empresa por vez (mesmo padrão
        # de todo o resto do app), não uma checagem de segurança adicional.
        return await conn.fetch(
            """
            SELECT s.id::text, s.resource_type, s.resource_id::text, s.company_id::text,
                   s.expires_at, s.revoked_at, s.view_count, s.last_accessed_at, s.created_at,
                   (s.password_hash IS NOT NULL) AS has_password,
                   CASE WHEN s.resource_type = 'document' THEN d.name ELSE f.name END AS resource_name,
                   -- pasta que contém o documento compartilhado — necessário pro
                   -- frontend montar o deep-link /documents?folder_id=...&doc=...
                   d.folder_id::text AS document_folder_id
            FROM public.shares s
            LEFT JOIN public.documents d ON d.id = s.resource_id AND s.resource_type = 'document'
            LEFT JOIN public.folders   f ON f.id = s.resource_id AND s.resource_type = 'folder'
            WHERE ($1::text IS NULL OR s.resource_type = $1)
              AND ($2::uuid IS NULL OR s.resource_id = $2)
              AND ($3::uuid IS NULL OR s.company_id = $3)
            ORDER BY s.created_at DESC
            """,
            resource_type, resource_id, company_id,
        )

    @staticmethod
    async def revoke_share(conn: asyncpg.Connection, share_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("UPDATE public.shares SET revoked_at = now() WHERE id = $1 RETURNING id", share_id)

    @staticmethod
    async def expire_shares_for_resource(admin_conn: asyncpg.Connection, resource_type: str, resource_id: UUID) -> None:
        await admin_conn.execute(
            "UPDATE public.shares SET expired_at = now() WHERE resource_type = $1 AND resource_id = $2 AND expired_at IS NULL",
            resource_type, resource_id,
        )

    @staticmethod
    async def resolve_share_by_token_hash(admin_conn: asyncpg.Connection, token_hash: str) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            """
            SELECT s.id, s.resource_type, s.resource_id, s.company_id, s.password_hash,
                   s.expires_at, s.revoked_at, s.expired_at, s.pin_to_version_id
            FROM public.shares s
            WHERE s.token_hash = $1
            """,
            token_hash,
        )

    @staticmethod
    async def get_document_name(admin_conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow("SELECT name, deleted_at FROM public.documents WHERE id = $1", document_id)

    @staticmethod
    async def get_folder_name(admin_conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow("SELECT name, deleted_at FROM public.folders WHERE id = $1", folder_id)

    @staticmethod
    async def insert_access_log(admin_conn: asyncpg.Connection, *, share_id: str, ip_hash: str, user_agent: str, success: bool) -> None:
        await admin_conn.execute(
            "INSERT INTO public.share_accesses (share_id, ip_hash, user_agent, success) VALUES ($1, $2, $3, $4)",
            share_id, ip_hash, user_agent, success,
        )

    @staticmethod
    async def register_successful_access(admin_conn: asyncpg.Connection, share_id: str) -> None:
        await admin_conn.execute(
            "UPDATE public.shares SET view_count = view_count + 1, last_accessed_at = now() WHERE id = $1",
            share_id,
        )

    @staticmethod
    async def get_document_for_content(admin_conn: asyncpg.Connection, document_id) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, name, current_version_id, deleted_at FROM public.documents WHERE id = $1",
            document_id,
        )

    @staticmethod
    async def get_version_for_content(admin_conn: asyncpg.Connection, version_id) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT storage_key, mime_type FROM public.document_versions WHERE id = $1", version_id,
        )

    @staticmethod
    async def get_folder_for_content(admin_conn: asyncpg.Connection, folder_id) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, name, path, deleted_at FROM public.folders WHERE id = $1", folder_id,
        )

    @staticmethod
    async def get_active_folder(admin_conn: asyncpg.Connection, folder_id) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, name, path FROM public.folders WHERE id = $1 AND deleted_at IS NULL", folder_id,
        )

    @staticmethod
    async def list_subfolders(admin_conn: asyncpg.Connection, parent_id) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            "SELECT id::text, name FROM public.folders WHERE parent_id = $1 AND deleted_at IS NULL ORDER BY name",
            parent_id,
        )

    @staticmethod
    async def list_documents_in_folder(admin_conn: asyncpg.Connection, folder_id) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            "SELECT id::text, name, size_bytes, mime_type FROM public.documents WHERE folder_id = $1 AND deleted_at IS NULL ORDER BY name",
            folder_id,
        )

    @staticmethod
    async def get_folder_path(admin_conn: asyncpg.Connection, folder_id) -> asyncpg.Record | None:
        return await admin_conn.fetchrow("SELECT path FROM public.folders WHERE id = $1", folder_id)

    @staticmethod
    async def get_document_in_folder_scope(admin_conn: asyncpg.Connection, document_id: UUID, root_path) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            """
            SELECT d.id FROM public.documents d
            JOIN public.folders f ON f.id = d.folder_id
            WHERE d.id = $1 AND d.deleted_at IS NULL AND f.path <@ $2::ltree
            """,
            document_id, root_path,
        )

    @staticmethod
    async def get_document_for_download(admin_conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT name, storage_path, mime_type FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
            document_id,
        )
