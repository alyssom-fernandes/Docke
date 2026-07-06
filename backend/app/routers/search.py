from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, Query

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
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    Busca full-text em documents.name, documents.ocr_text e documents.metadata.
    Retorna resultados paginados com rank (ts_rank_cd) e snippet (ts_headline).

    RLS filtra automaticamente documentos inacessíveis.
    A query é normalizada e passada para websearch_to_tsquery('portuguese', ...).
    """
    normalized = SearchService.normalize_query(q)
    if not normalized:
        return {"results": [], "total": 0, "page": page, "page_size": page_size, "query": q}

    return await SearchService.search(
        conn,
        q=q, normalized=normalized, company_id=company_id, folder_id=folder_id,
        sector=sector, file_type=file_type, page=page, page_size=page_size,
    )


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
    return await SearchService.quick_search(conn, normalized=normalized, company_id=company_id)
