from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db
from app.services.favorites_service import FavoritesService

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
    """Lista favoritos do usuário. RLS garante que só retorna os próprios."""
    rows = await FavoritesService.list_favorites(conn)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# POST /favorites — cria favorito (documento ou pasta)
# ---------------------------------------------------------------------------

@router.post("", status_code=status.HTTP_201_CREATED)
async def create_favorite(
    body: FavoriteCreate,
    conn: asyncpg.Connection = Depends(get_db),
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
        doc = await FavoritesService.get_document_for_favorite(conn, body.document_id)
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
        item_name = doc["name"]
        company_id = str(doc["company_id"])
        item_type = "document"
    else:
        folder = await FavoritesService.get_folder_for_favorite(conn, body.folder_id)
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
        item_name = folder["name"]
        company_id = str(folder["company_id"])
        item_type = "folder"

    try:
        row = await FavoritesService.insert_favorite(
            conn, user_id=user_id, document_id=body.document_id, folder_id=body.folder_id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Item já está ancorado.")

    item_id = str(body.document_id or body.folder_id)
    await FavoritesService.log_activity(
        conn, user_id=user_id, company_id=company_id, action="favorite",
        item_type=item_type, item_id=item_id, item_name=item_name,
    )

    return dict(row) | {"item_type": item_type, "item_name": item_name}


# ---------------------------------------------------------------------------
# DELETE /favorites/:id — remove favorito
# ---------------------------------------------------------------------------

@router.delete("/{favorite_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_favorite(
    favorite_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """
    Remove favorito. RLS garante que só o próprio usuário pode deletar os seus.
    activity_log: ação 'unfavorite'.
    """
    user_id = claims["sub"]

    fav = await FavoritesService.get_favorite_for_delete(conn, favorite_id)
    if fav is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item ancorado não encontrado.")

    await FavoritesService.delete_favorite(conn, favorite_id)

    item_id = str(fav["document_id"] or fav["folder_id"])
    await FavoritesService.log_activity(
        conn, user_id=user_id, company_id=str(fav["company_id"]), action="unfavorite",
        item_type=fav["item_type"], item_id=item_id, item_name=fav["item_name"],
    )
