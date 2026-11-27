from datetime import date
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.dependencies import get_db
from app.services.search_service import SearchService
from app.schemas.search import RespostaBusca, ResultadoRapido

router = APIRouter(prefix="/search", tags=["search"])

_PAGE_SIZE_MAX = 100


# ---------------------------------------------------------------------------
# GET /search — busca full-text paginada com ts_headline para snippets
# ---------------------------------------------------------------------------

@router.get("", response_model=RespostaBusca)
async def search(
    q: str = Query("", max_length=500),
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
    guarda: str | None = Query(None, pattern="^(bloqueio|sem_prazo|vencido)$", description="Retenção: sob bloqueio judicial, sem prazo de guarda ou com o prazo vencido."),
    ocr: str | None = Query(None, pattern="^(lido|fila|falhou)$", description="Situação da leitura do texto (FA-A6-01)."),
    campo: UUID | None = Query(None, description="Campo de metadado (FA-A6-01); com valor, filtra pelo conteúdo."),
    valor: str | None = Query(None, max_length=200),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    Busca full-text em documents.name, documents.ocr_text e documents.metadata.
    Retorna resultados paginados com rank (ts_rank_cd) e snippet (ts_headline).

    RLS filtra automaticamente documentos inacessíveis.
    A query é normalizada e passada para websearch_to_tsquery('portuguese', ...).
    """
    normalized = SearchService.normalize_query(q)
    # Visões prontas (B4.1.4, FA-A3-05): sem termo, a busca lista o que bate
    # nos filtros (guarda, pasta, período, tipo). Sem termo e sem filtro, nada.
    so_filtros = not q.strip() and any(x is not None for x in (guarda, folder_id, sector, file_type, date_from, date_to, ocr, campo))
    if not so_filtros and not normalized and not SearchService.digits_pattern(q):
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
        guarda=guarda, ocr=ocr, campo=campo, valor=(valor or "").strip() or None,
    )
    return result


# ---------------------------------------------------------------------------
# GET /search/quick — busca rápida para command palette (máx 10 resultados)
# ---------------------------------------------------------------------------

@router.get("/quick", response_model=list[ResultadoRapido])
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


# ---------------------------------------------------------------------------
# Buscas salvas (B2.1.5): a consulta com filtros, por pessoa e empresa.
# ---------------------------------------------------------------------------

class SavedSearchCreate(BaseModel):
    company_id: UUID
    name: str = Field(min_length=1, max_length=80)
    query: str = Field(min_length=1, max_length=2000)


@router.get("/saved")
async def list_saved_searches(
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict]:
    rows = await conn.fetch(
        "SELECT id::text, name, query, created_at FROM public.saved_searches WHERE company_id = $1 AND user_id = auth.uid() ORDER BY lower(name)",
        company_id,
    )
    return [dict(r) for r in rows]


@router.post("/saved", status_code=201)
async def create_saved_search(
    body: SavedSearchCreate,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict:
    total = await conn.fetchval("SELECT count(*) FROM public.saved_searches WHERE company_id = $1 AND user_id = auth.uid()", body.company_id)
    if total >= 50:
        raise HTTPException(status_code=409, detail="Limite de 50 buscas salvas nesta empresa. Apague alguma antes.")
    try:
        row = await conn.fetchrow(
            """
            INSERT INTO public.saved_searches (user_id, company_id, name, query)
            VALUES (auth.uid(), $1, $2, $3)
            ON CONFLICT (user_id, company_id, name) DO UPDATE SET query = EXCLUDED.query, created_at = now()
            RETURNING id::text, name, query, created_at
            """,
            body.company_id, body.name.strip(), body.query.lstrip("?"),
        )
    except asyncpg.InsufficientPrivilegeError:
        raise HTTPException(status_code=403, detail="Você não acessa esta empresa.")
    return dict(row)


@router.delete("/saved/{saved_id}", status_code=204)
async def delete_saved_search(saved_id: UUID, conn: asyncpg.Connection = Depends(get_db)) -> None:
    await conn.execute("DELETE FROM public.saved_searches WHERE id = $1 AND user_id = auth.uid()", saved_id)
