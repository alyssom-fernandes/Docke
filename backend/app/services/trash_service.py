"""
TrashService — listagem, restauração e exclusão permanente de itens na
lixeira. Usa admin_conn: itens com deleted_at preenchido são invisíveis ao
authenticated via RLS (documents_select/folders_select exigem deleted_at IS
NULL), então listar/restaurar/excluir da lixeira sempre precisa bypassar.
"""
from typing import Any
from uuid import UUID

import asyncpg


class TrashService:
    @staticmethod
    async def list_deleted_documents(admin_conn: asyncpg.Connection, company_id: UUID, user_id: str) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              d.id::text,
              d.name,
              d.folder_id::text,
              d.company_id::text,
              d.file_type,
              d.size_bytes,
              d.deleted_at,
              d.deleted_original_folder_id::text,
              f.name AS original_folder_name,
              f.deleted_at IS NOT NULL AS original_folder_deleted,
              'document' AS item_type
            FROM public.documents d
            LEFT JOIN public.folders f ON f.id = d.deleted_original_folder_id
            WHERE d.company_id = $1
              AND d.deleted_at IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.user_company_access uca
                WHERE uca.user_id = $2 AND uca.company_id = $1
              )
            ORDER BY d.deleted_at DESC
            """,
            company_id, user_id,
        )

    @staticmethod
    async def list_deleted_folders(admin_conn: asyncpg.Connection, company_id: UUID, user_id: str) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              f.id::text,
              f.name,
              f.company_id::text,
              f.deleted_at,
              f.parent_id::text,
              'folder' AS item_type
            FROM public.folders f
            WHERE f.company_id = $1
              AND f.deleted_at IS NOT NULL
              AND (
                f.parent_id IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM public.folders parent
                  WHERE parent.id = f.parent_id AND parent.deleted_at IS NOT NULL
                )
              )
              AND EXISTS (
                SELECT 1 FROM public.user_company_access uca
                WHERE uca.user_id = $2 AND uca.company_id = $1
              )
            ORDER BY f.deleted_at DESC
            """,
            company_id, user_id,
        )

    @staticmethod
    async def get_deleted_document(admin_conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, folder_id, company_id, deleted_original_folder_id FROM public.documents WHERE id = $1 AND deleted_at IS NOT NULL",
            document_id,
        )

    @staticmethod
    async def get_active_folder(admin_conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, path, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            folder_id,
        )

    @staticmethod
    async def get_root_folder(admin_conn: asyncpg.Connection, company_id) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, path, company_id FROM public.folders WHERE company_id = $1 AND parent_id IS NULL AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
            company_id,
        )

    @staticmethod
    async def check_permission(admin_conn: asyncpg.Connection, user_id: str, path: str, company_id: str) -> str | None:
        return await admin_conn.fetchval(
            "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
            user_id, path, company_id,
        )

    @staticmethod
    async def restore_document(admin_conn: asyncpg.Connection, document_id: UUID, target_folder_id) -> asyncpg.Record:
        return await admin_conn.fetchrow(
            """
            UPDATE public.documents
            SET deleted_at = NULL, folder_id = $2, deleted_original_folder_id = NULL, updated_at = now()
            WHERE id = $1
            RETURNING id::text, name, folder_id::text, company_id::text, ocr_status
            """,
            document_id, target_folder_id,
        )

    @staticmethod
    async def get_deleted_folder(admin_conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, name, path, company_id, parent_id FROM public.folders WHERE id = $1 AND deleted_at IS NOT NULL",
            folder_id,
        )

    @staticmethod
    async def is_parent_deleted(admin_conn: asyncpg.Connection, parent_id) -> bool:
        return bool(await admin_conn.fetchval(
            "SELECT deleted_at IS NOT NULL FROM public.folders WHERE id = $1", parent_id,
        ))

    @staticmethod
    async def restore_folder_cascade(admin_conn: asyncpg.Connection, *, folder_id: UUID, new_parent_id, path: str) -> None:
        await admin_conn.execute(
            """
            UPDATE public.folders
            SET deleted_at = NULL,
                parent_id = CASE WHEN id = $1 THEN $2 ELSE parent_id END
            WHERE (id = $1 OR path <@ $3::ltree)
              AND deleted_at IS NOT NULL
            """,
            folder_id, new_parent_id, path,
        )

    @staticmethod
    async def log_activity(
        admin_conn: asyncpg.Connection, *, user_id: str, company_id: str, action: str, item_type: str, item_id: str, item_name: str,
    ) -> None:
        await admin_conn.execute(
            "INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)",
            user_id, company_id, action, item_type, item_id, item_name,
        )

    @staticmethod
    async def get_document_for_permanent_delete(admin_conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, name, company_id, storage_path FROM public.documents WHERE id = $1 AND deleted_at IS NOT NULL",
            document_id,
        )

    @staticmethod
    async def get_folder_for_permanent_delete(admin_conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, name, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NOT NULL",
            folder_id,
        )

    @staticmethod
    async def get_company_admin_permission(admin_conn: asyncpg.Connection, user_id: str, company_id) -> str | None:
        return await admin_conn.fetchval(
            "SELECT permission_level FROM public.user_company_access WHERE user_id = $1 AND company_id = $2 AND folder_path IS NULL",
            user_id, company_id,
        )

    @staticmethod
    async def count_documents_in_folder(admin_conn: asyncpg.Connection, folder_id: UUID) -> int:
        return await admin_conn.fetchval("SELECT count(*) FROM public.documents WHERE folder_id = $1", folder_id)

    @staticmethod
    async def permanently_delete_document(admin_conn: asyncpg.Connection, document_id: UUID) -> None:
        await admin_conn.execute("DELETE FROM public.documents WHERE id = $1", document_id)

    @staticmethod
    async def permanently_delete_folder(admin_conn: asyncpg.Connection, folder_id: UUID) -> None:
        await admin_conn.execute("DELETE FROM public.folders WHERE id = $1", folder_id)
