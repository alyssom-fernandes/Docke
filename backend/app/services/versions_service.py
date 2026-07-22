"""
VersionsService — histórico, upload, confirmação, restauração e exclusão de
versões de documento (ADR-024/029/034).
"""
from typing import Any
from uuid import UUID

import asyncpg


class VersionsService:
    @staticmethod
    async def get_document_for_write_check(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT d.id, d.name, d.folder_id, d.company_id, d.storage_path, d.current_version_id,
                   CASE
                     WHEN d.folder_id IS NULL THEN public.user_has_access(auth.uid(), NULL::ltree, d.company_id)
                     ELSE (SELECT public.user_has_access(auth.uid(), f.path, d.company_id) FROM public.folders f WHERE f.id = d.folder_id)
                   END AS permission
            FROM public.documents d
            WHERE d.id = $1 AND d.deleted_at IS NULL
            """,
            document_id,
        )

    @staticmethod
    async def get_document_basic(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id, current_version_id FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
            document_id,
        )

    @staticmethod
    async def list_versions(conn: asyncpg.Connection, document_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              v.id::text, v.version_number, v.size_bytes, v.mime_type, v.created_at,
              u.full_name AS uploaded_by_name
            FROM public.document_versions v
            LEFT JOIN public.users u ON u.id = v.uploaded_by
            WHERE v.document_id = $1
            ORDER BY v.version_number DESC
            """,
            document_id,
        )

    @staticmethod
    async def count_versions(admin_conn: asyncpg.Connection, document_id: UUID) -> int:
        return await admin_conn.fetchval(
            "SELECT count(*) FROM public.document_versions WHERE document_id = $1", document_id,
        )

    @staticmethod
    async def next_version_number(admin_conn: asyncpg.Connection, document_id: UUID) -> int:
        return await admin_conn.fetchval(
            "SELECT COALESCE(MAX(version_number), 0) + 1 FROM public.document_versions WHERE document_id = $1",
            document_id,
        )

    @staticmethod
    async def insert_version(
        admin_conn: asyncpg.Connection, *, version_id: UUID, document_id: UUID, version_number: int,
        storage_key: str, size_bytes: int, mime_type: str, uploaded_by: str,
    ) -> None:
        await admin_conn.execute(
            """
            INSERT INTO public.document_versions
              (id, document_id, version_number, storage_key, size_bytes, mime_type, uploaded_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            """,
            version_id, document_id, version_number, storage_key, size_bytes, mime_type, uploaded_by,
        )

    @staticmethod
    async def get_version(admin_conn: asyncpg.Connection, version_id: UUID, document_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, storage_key, size_bytes, mime_type FROM public.document_versions WHERE id = $1 AND document_id = $2",
            version_id, document_id,
        )

    @staticmethod
    async def activate_version(
        admin_conn: asyncpg.Connection, *, document_id: UUID, version_id: UUID,
        storage_key: str, mime_type: str, size_bytes: int,
    ) -> None:
        await admin_conn.execute(
            """
            UPDATE public.documents
            SET current_version_id = $2,
                storage_path = $3,
                mime_type    = $4,
                size_bytes   = $5,
                ocr_status   = 'pending',
                ocr_text     = NULL,
                updated_at   = now()
            WHERE id = $1
            """,
            document_id, version_id, storage_key, mime_type, size_bytes,
        )
        # document_versions.size_bytes foi gravado com o valor declarado pelo
        # cliente em /upload-url (fase 1) — sincroniza com o ContentLength real
        # confirmado no HEAD do storage (fase 2), mesma fonte usada acima.
        await admin_conn.execute(
            "UPDATE public.document_versions SET size_bytes = $2 WHERE id = $1",
            version_id, size_bytes,
        )

    @staticmethod
    async def delete_pending_version(admin_conn: asyncpg.Connection, version_id: UUID) -> None:
        """Remove uma linha de document_versions ainda não ativada (confirm falhou —
        ex: tamanho real excede o limite). Documents.current_version_id nunca chega
        a apontar pra ela, então é seguro remover sem deixar órfão."""
        await admin_conn.execute(
            "DELETE FROM public.document_versions WHERE id = $1",
            version_id,
        )

    @staticmethod
    async def log_version_upload(admin_conn: asyncpg.Connection, *, document_id: UUID, user_id: str) -> None:
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
            SELECT $2::uuid, d.company_id, 'upload', 'document', $1::uuid, d.name, jsonb_build_object('version_upload', true)
            FROM public.documents d WHERE d.id = $1
            """,
            document_id, user_id,
        )

    @staticmethod
    async def log_version_restore(admin_conn: asyncpg.Connection, *, document_id: UUID, user_id: str, restored_version: int, new_version: int) -> None:
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
            SELECT $2::uuid, d.company_id, 'restore', 'document', $1::uuid, d.name,
                   jsonb_build_object('restored_version', $3::int, 'new_version', $4::int)
            FROM public.documents d WHERE d.id = $1
            """,
            document_id, user_id, restored_version, new_version,
        )

    @staticmethod
    async def get_document_name_and_company(admin_conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record:
        return await admin_conn.fetchrow("SELECT name, company_id FROM public.documents WHERE id = $1", document_id)

    @staticmethod
    async def get_document_for_download(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT name FROM public.documents WHERE id = $1 AND deleted_at IS NULL", document_id,
        )

    @staticmethod
    async def get_version_for_download(conn: asyncpg.Connection, version_id: UUID, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT storage_key, mime_type, version_number FROM public.document_versions WHERE id = $1 AND document_id = $2",
            version_id, document_id,
        )

    @staticmethod
    async def is_current_version(admin_conn: asyncpg.Connection, document_id: UUID, version_id: UUID) -> bool:
        return bool(await admin_conn.fetchval(
            "SELECT current_version_id = $2 FROM public.documents WHERE id = $1",
            document_id, version_id,
        ))

    @staticmethod
    async def delete_version_row(admin_conn: asyncpg.Connection, version_id: UUID) -> None:
        await admin_conn.execute("DELETE FROM public.document_versions WHERE id = $1", version_id)

    @staticmethod
    async def storage_key_still_referenced(admin_conn: asyncpg.Connection, storage_key: str) -> bool:
        return bool(await admin_conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.document_versions WHERE storage_key = $1)", storage_key,
        ))
