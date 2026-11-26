from datetime import date
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies import get_db
from app.services.search_service import SearchService

router = APIRouter(prefix="/search", tags=["search"])

_PAGE_SIZE_MAX = 100


# ---------------------------------------------------------------------------
# GET /search — busca full-text paginada com ts_headline para snippets
# ---------------------------------------------------------------------------

@router.get("")
async def search(
    q: str = Query(..., min_length=1, max_length=500),
    company_id: UUID = Query(...),
    folder_id: UUID | None = Query(None),
    sector: str | None = Query(None),
    file_type: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=_PAGE_SIZE_MAX),
    date_from: date | None = Query(None, description="Enviados a partir de (inclusive)."),
    date_to: date | None = Query(None, description="Enviados até (inclusive)."),
    sort: str = Query("relevancia", pattern="^(relevancia|recentes|antigos|nome)$"),
    subfolders: bool = Query(True, description="Com folder_id, inclui as subpastas."),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    Busca full-text em documents.name, documents.ocr_text e documents.metadata.
    Retorna resultados paginados com rank (ts_rank_cd) e snippet (ts_headline).

    RLS filtra automaticamente documentos inacessíveis.
    A query é normalizada e passada para websearch_to_tsquery('portuguese', ...).
    """
    normalized = SearchService.normalize_query(q)
    if not normalized and not SearchService.digits_pattern(q):
        return {"results": [], "total": 0, "page": page, "page_size": page_size, "query": q, "facets": {"sector": [], "file_type": []}}
    if date_from and date_to and date_from > date_to:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O início do período é depois do fim.")

    folder_path = None
    if folder_id is not None:
        folder_path = await conn.fetchval(
            "SELECT path::text FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL", folder_id, company_id,
        )
        if folder_path is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")

    result = await SearchService.search(
        conn,
        q=q, normalized=normalized or q.strip(), company_id=company_id, folder_id=folder_id,
        sector=sector, file_type=file_type, page=page, page_size=page_size,
        date_from=date_from, date_to=date_to, sort=sort,
        folder_path=folder_path if subfolders else None, exact_folder_id=None if subfolders else folder_id,
    )
    return result


# ---------------------------------------------------------------------------
# GET /search/quick — busca rápida para command palette (máx 10 resultados)
# ---------------------------------------------------------------------------

@router.get("/quick")
async def quick_search(
    q: str = Query(..., min_length=1, max_length=200),
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Busca rápida com prefixo (para command palette / autocomplete).
    Usa tsquery com :* para prefix matching na última palavra.
    Retorna id, name, file_type, folder_name, rank — sem snippet para ser mais rápido.
    """
    normalized = SearchService.normalize_query(q)
    if not normalized:
        return []
    return await SearchService.quick_search(conn, q=q, normalized=normalized, company_id=company_id)
