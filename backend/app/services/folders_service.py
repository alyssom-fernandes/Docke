"""
FoldersService — CRUD de pastas, move com ltree, templates de pasta.
NUNCA lida com permissões reais (isso é RLS) nem com documentos (isso é
documents_service) — só orquestra as queries que folders.py precisa.
"""
from typing import Any
from uuid import UUID

import asyncpg


class FoldersService:
    @staticmethod
    async def list_folders(
        conn: asyncpg.Connection, *, company_id: UUID, parent_id: UUID | None, flat: bool,
    ) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              f.id::text,
              f.name,
              f.path::text,
              f.parent_id::text,
              f.company_id::text,
              f.created_by::text,
              f.created_at,
              public.user_has_access(auth.uid(), f.path, f.company_id) AS my_permission,
              (SELECT count(*) FROM public.folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL) AS child_count,
              (SELECT count(*) FROM public.documents d WHERE d.folder_id = f.id AND d.deleted_at IS NULL) AS document_count
            FROM public.folders f
            WHERE f.company_id = $1
              AND f.deleted_at IS NULL
              AND (
                $3::boolean
                OR ($2::uuid IS NULL AND f.parent_id IS NULL OR f.parent_id = $2)
              )
            ORDER BY f.path
            """,
            company_id, parent_id, flat,
        )

    @staticmethod
    async def frequent_folders(
        conn: asyncpg.Connection, *, user_id: str, company_id: UUID, limit: int,
    ) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              f.id::text,
              f.name,
              f.path::text,
              f.parent_id::text,
              f.company_id::text,
              COUNT(al.id) AS activity_count,
              MAX(al.created_at) AS last_activity
            FROM public.folders f
            JOIN public.documents d ON d.folder_id = f.id AND d.deleted_at IS NULL
            JOIN public.activity_log al
              ON al.item_id = d.id
              AND al.item_type = 'document'
              AND al.user_id = $1::uuid
              AND al.created_at >= now() - interval '30 days'
              AND al.action IN ('upload', 'view', 'download')
            WHERE f.company_id = $2
              AND f.deleted_at IS NULL
            GROUP BY f.id, f.name, f.path, f.parent_id, f.company_id
            ORDER BY activity_count DESC, last_activity DESC
            LIMIT $3
            """,
            user_id, company_id, limit,
        )

    @staticmethod
    async def get_parent_folder(conn: asyncpg.Connection, parent_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT path::text, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            parent_id,
        )

    @staticmethod
    async def generate_path_label(conn: asyncpg.Connection) -> str:
        """Gera label ltree único: sequência numérica curta (evita caracteres inválidos)."""
        return await conn.fetchval(
            "SELECT 'f' || floor(extract(epoch FROM now()) * 1000)::text || lpad((random()*9999)::int::text, 4, '0')"
        )

    @staticmethod
    async def check_permission(conn: asyncpg.Connection, user_id: str, path: str | None, company_id: UUID) -> str | None:
        return await conn.fetchval(
            "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
            user_id, path, company_id,
        )

    @staticmethod
    async def insert_folder(
        conn: asyncpg.Connection, *, company_id: UUID, parent_id: UUID | None, path: str, name: str, created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.folders (company_id, parent_id, path, name, created_by)
            VALUES ($1, $2, $3::ltree, $4, $5)
            RETURNING id::text, name, path::text, parent_id::text, company_id::text, created_at
            """,
            company_id, parent_id, path, name, created_by,
        )

    @staticmethod
    async def rename_folder(conn: asyncpg.Connection, folder_id: UUID, name: str) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            UPDATE public.folders
            SET name = $2
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id::text, name, path::text, parent_id::text, company_id::text, created_at
            """,
            folder_id, name,
        )

    @staticmethod
    async def get_folder_for_move(conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        """R8: SELECT ... FOR UPDATE trava a linha até o fim da transação da
        request (get_db já abre uma transaction explícita por request), evitando
        corrida entre dois moves concorrentes da mesma pasta."""
        return await conn.fetchrow(
            "SELECT path::text, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
            folder_id,
        )

    @staticmethod
    async def get_target_parent(conn: asyncpg.Connection, parent_id: UUID, company_id) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT path::text FROM public.folders WHERE id = $1 AND deleted_at IS NULL AND company_id = $2",
            parent_id, company_id,
        )

    @staticmethod
    async def move_folder_atomic(
        conn: asyncpg.Connection, *, folder_id: UUID, new_parent_path: str | None,
        old_nlevel: int, new_parent_id: UUID | None, old_path: str,
    ) -> None:
        """
        Atualiza a pasta + todos os descendentes atomicamente (R4/R8).
        subpath(path, old_nlevel - 1) = sufixo a partir do label da própria pasta movida.
        """
        await conn.execute(
            """
            UPDATE public.folders
            SET path = CASE
                    WHEN $2::text IS NULL THEN subpath(path, $3)
                    ELSE ($2::ltree || subpath(path, $3))
                END,
                parent_id = CASE WHEN id = $1 THEN $4 ELSE parent_id END
            WHERE (id = $1 OR path <@ $5::ltree)
              AND deleted_at IS NULL
            """,
            folder_id, new_parent_path, old_nlevel - 1, new_parent_id, old_path,
        )

    @staticmethod
    async def get_folder_after_move(conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id::text, name, path::text, parent_id::text, company_id::text FROM public.folders WHERE id = $1",
            folder_id,
        )

    @staticmethod
    async def get_folder_for_delete(conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT f.name, f.path::text, f.company_id::text,
                   public.user_has_access(auth.uid(), f.path, f.company_id) AS permission
            FROM public.folders f
            WHERE f.id = $1 AND f.deleted_at IS NULL
            """,
            folder_id,
        )

    @staticmethod
    async def log_delete_activity(conn: asyncpg.Connection, *, folder_id: UUID, company_id: str, name: str) -> None:
        """
        activity_log_insert (RLS) permite qualquer authenticated inserir sua
        própria linha — sem isso, exclusão de pasta nunca aparecia no log de
        atividade nem no aviso de pré-purga da lixeira (que depende de saber
        quem excluiu).
        """
        await conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)
            VALUES (auth.uid(), $1::uuid, 'delete', 'folder', $2::uuid, $3)
            """,
            company_id, folder_id, name,
        )

    @staticmethod
    async def soft_delete_folder_cascade(admin_conn: asyncpg.Connection, path: str) -> None:
        """
        Soft delete via service role (bypassa RLS para evitar o bloqueio implícito
        de UPDATE que torna a linha invisível ao próprio SELECT do usuário).
        trash_expires_at (ADR-025/030): retention_days da empresa no momento da exclusão.
        """
        await admin_conn.execute(
            """
            UPDATE public.folders f
            SET deleted_at = now(),
                trash_expires_at = now() + (c.retention_days || ' days')::interval
            FROM public.companies c
            WHERE f.path <@ $1::ltree AND f.deleted_at IS NULL AND c.id = f.company_id
            """,
            path,
        )
        await admin_conn.execute(
            """
            UPDATE public.documents d
            SET deleted_at = now(),
                deleted_original_folder_id = d.folder_id,
                trash_expires_at = now() + (c.retention_days || ' days')::interval
            FROM public.folders f
            JOIN public.companies c ON c.id = f.company_id
            WHERE d.folder_id = f.id
              AND f.path <@ $1::ltree
              AND d.deleted_at IS NULL
            """,
            path,
        )
