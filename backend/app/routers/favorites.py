import json
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin

router = APIRouter(prefix="/favorites", tags=["favorites"])


class FavoriteCreate(BaseModel):
    document_id: UUID | None = None
    folder_id: UUID | None = None


# ---------------------------------------------------------------------------
# GET /favorites — lista favoritos do usuário autenticado
# ---------------------------------------------------------------------------

@router.get("")
async def list_favorites(
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """
    Lista favoritos do usuário. RLS garante que só retorna os próprios.
    Enriquece cada item com nome e tipo do alvo (document ou folder).
    """
    rows = await conn.fetch(
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
          END AS item_name
        FROM public.favorites fav
        LEFT JOIN public.documents d ON d.id = fav.document_id AND d.deleted_at IS NULL
        LEFT JOIN public.folders   f ON f.id = fav.folder_id   AND f.deleted_at IS NULL
        WHERE fav.user_id = auth.uid()
        ORDER BY fav.created_at DESC
        """
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# POST /favorites — cria favorito (documento ou pasta)
# ---------------------------------------------------------------------------

@router.post("", status_code=status.HTTP_201_CREATED)
async def create_favorite(
    body: FavoriteCreate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Favorita um documento OU uma pasta (nunca os dois — CHECK constraint no banco).
    Valida FK real: o alvo deve existir e ser visível ao usuário.
    activity_log: ação 'favorite'.
    """
    if body.document_id is None and body.folder_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Informe document_id ou folder_id.")
    if body.document_id is not None and body.folder_id is not None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Informe apenas document_id ou folder_id, não ambos.")

    user_id = claims["sub"]

    if body.document_id is not None:
        # Valida que documento existe e é visível (RLS filtra)
        doc = await conn.fetchrow(
            "SELECT id, name, company_id FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
            body.document_id,
        )
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
        item_name = doc["name"]
        company_id = str(doc["company_id"])
        item_type = "document"
    else:
        folder = await conn.fetchrow(
            "SELECT id, name, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            body.folder_id,
        )
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
        item_name = folder["name"]
        company_id = str(folder["company_id"])
        item_type = "folder"

    try:
        row = await conn.fetchrow(
            """
            INSERT INTO public.favorites (user_id, document_id, folder_id)
            VALUES ($1, $2, $3)
            RETURNING id::text, user_id::text, document_id::text, folder_id::text, created_at
            """,
            user_id,
            body.document_id,
            body.folder_id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Item já está nos favoritos.")

    item_id = str(body.document_id or body.folder_id)
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log
          (user_id, company_id, action, item_type, item_id, item_name_snapshot)
        VALUES ($1::uuid, $2::uuid, 'favorite', $3, $4::uuid, $5)
        """,
        user_id, company_id, item_type, item_id, item_name,
    )

    return dict(row) | {"item_type": item_type, "item_name": item_name}


# ---------------------------------------------------------------------------
# DELETE /favorites/:id — remove favorito
# ---------------------------------------------------------------------------

@router.delete("/{favorite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_favorite(
    favorite_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """
    Remove favorito. RLS garante que só o próprio usuário pode deletar os seus.
    activity_log: ação 'unfavorite'.
    """
    user_id = claims["sub"]

    # Busca favorito para logar antes de deletar
    fav = await conn.fetchrow(
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
    if fav is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Favorito não encontrado.")

    await conn.execute("DELETE FROM public.favorites WHERE id = $1", favorite_id)

    item_id = str(fav["document_id"] or fav["folder_id"])
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log
          (user_id, company_id, action, item_type, item_id, item_name_snapshot)
        VALUES ($1::uuid, $2::uuid, 'unfavorite', $3, $4::uuid, $5)
        """,
        user_id,
        str(fav["company_id"]),
        fav["item_type"],
        item_id,
        fav["item_name"],
    )
