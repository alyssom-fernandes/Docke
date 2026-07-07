"""
FavoritesService — CRUD de favoritos (documento ou pasta) + log de atividade.
activity_log usa a policy própria de INSERT (RLS permite auth.uid() = user_id),
nunca precisa da conexão admin.
"""
import asyncpg


class FavoritesService:
    @staticmethod
    async def list_favorites(conn: asyncpg.Connection) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              fav.id::text,
              fav.user_id::text,
              fav.document_id::text,
              fav.folder_id::text,
              fav.created_at,
              CASE
                WHEN fav.document_id IS NOT NULL THEN 'document'
                ELSE 'folder'
              END AS item_type,
              CASE
                WHEN fav.document_id IS NOT NULL THEN d.name
                ELSE f.name
              END AS item_name,
              -- pasta que contém o documento favoritado (NULL se o próprio
              -- favorito já é uma pasta) — necessário pro frontend montar o
              -- deep-link /documents?folder_id=...&doc=... ao clicar no item.
              d.folder_id::text AS document_folder_id
            FROM public.favorites fav
            LEFT JOIN public.documents d ON d.id = fav.document_id AND d.deleted_at IS NULL
            LEFT JOIN public.folders   f ON f.id = fav.folder_id   AND f.deleted_at IS NULL
            WHERE fav.user_id = auth.uid()
              AND (fav.document_id IS NULL OR d.id IS NOT NULL)
              AND (fav.folder_id   IS NULL OR f.id IS NOT NULL)
            ORDER BY fav.created_at DESC
            """
        )

    @staticmethod
    async def get_document_for_favorite(conn: asyncpg.Connection, document_id) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id, name, company_id FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
            document_id,
        )

    @staticmethod
    async def get_folder_for_favorite(conn: asyncpg.Connection, folder_id) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id, name, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            folder_id,
        )

    @staticmethod
    async def insert_favorite(conn: asyncpg.Connection, *, user_id: str, document_id, folder_id) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.favorites (user_id, document_id, folder_id)
            VALUES ($1, $2, $3)
            RETURNING id::text, user_id::text, document_id::text, folder_id::text, created_at
            """,
            user_id, document_id, folder_id,
        )

    @staticmethod
    async def get_favorite_for_delete(conn: asyncpg.Connection, favorite_id) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT fav.id, fav.document_id, fav.folder_id,
              CASE WHEN fav.document_id IS NOT NULL THEN d.name ELSE f.name END AS item_name,
              CASE WHEN fav.document_id IS NOT NULL THEN d.company_id ELSE f.company_id END AS company_id,
              CASE WHEN fav.document_id IS NOT NULL THEN 'document' ELSE 'folder' END AS item_type
            FROM public.favorites fav
            LEFT JOIN public.documents d ON d.id = fav.document_id
            LEFT JOIN public.folders   f ON f.id = fav.folder_id
            WHERE fav.id = $1 AND fav.user_id = auth.uid()
            """,
            favorite_id,
        )

    @staticmethod
    async def delete_favorite(conn: asyncpg.Connection, favorite_id) -> None:
        await conn.execute("DELETE FROM public.favorites WHERE id = $1", favorite_id)

    @staticmethod
    async def log_activity(
        conn: asyncpg.Connection, *, user_id: str, company_id: str, action: str, item_type: str, item_id: str, item_name: str,
    ) -> None:
        await conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6)
            """,
            user_id, company_id, action, item_type, item_id, item_name,
        )
