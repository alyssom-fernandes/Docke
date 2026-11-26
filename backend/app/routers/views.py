"""
Vistas salvas por pasta (benchmark B1.2.7): ordenação, colunas, agrupamento
e filtro por metadado com nome. A compartilhada aparece para todos da
empresa; a pessoal só para quem criou. Apaga quem criou ou o admin da empresa.
"""
import json
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService

router = APIRouter(tags=["views"])


async def _membro(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID) -> None:
    if await get_app_role(conn, claims) == "supremo":
        return
    ok = await conn.fetchval(
        """
        SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)
            OR EXISTS (SELECT 1 FROM public.group_member gm JOIN public.group_access ga ON ga.group_id = gm.group_id
                       WHERE gm.user_id = $1 AND ga.company_id = $2)
        """,
        UUID(claims["sub"]), company_id,
    )
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")


class ViewBody(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    folder_id: UUID | None = None
    shared: bool = True
    config: dict[str, Any]


@router.get("/companies/{company_id}/views")
async def list_views(
    company_id: UUID,
    folder_id: UUID | None = Query(None),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    await _membro(conn, claims, company_id)
    rows = await admin_conn.fetch(
        """
        SELECT v.id::text, v.name, v.folder_id::text, v.shared, v.config, (v.created_by = $3) AS mine, u.full_name AS created_by_name
        FROM public.folder_views v LEFT JOIN public.users u ON u.id = v.created_by
        WHERE v.company_id = $1 AND (v.folder_id IS NULL OR v.folder_id IS NOT DISTINCT FROM $2)
          AND (v.shared OR v.created_by = $3)
        ORDER BY (v.folder_id IS NULL), lower(v.name)
        """,
        company_id, folder_id, UUID(claims["sub"]),
    )
    return [{**dict(r), "config": json.loads(r["config"]) if isinstance(r["config"], str) else r["config"]} for r in rows]


@router.post("/companies/{company_id}/views", status_code=status.HTTP_201_CREATED)
async def create_view(
    company_id: UUID,
    body: ViewBody,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _membro(conn, claims, company_id)
    if body.folder_id is not None and not await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL)", body.folder_id, company_id,
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    texto = json.dumps(body.config, ensure_ascii=False)
    if len(texto) > 4000:
        raise HTTPException(status_code=422, detail="Vista grande demais.")
    vid = await admin_conn.fetchval(
        """
        INSERT INTO public.folder_views (company_id, folder_id, name, config, shared, created_by)
        VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING id::text
        """,
        company_id, body.folder_id, body.name.strip(), texto, body.shared, UUID(claims["sub"]),
    )
    return {"id": vid, "name": body.name.strip(), "folder_id": str(body.folder_id) if body.folder_id else None,
            "shared": body.shared, "config": body.config, "mine": True}


@router.delete("/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_view(
    view_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    v = await admin_conn.fetchrow("SELECT company_id, created_by::text FROM public.folder_views WHERE id = $1", view_id)
    if v is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Vista não encontrada.")
    if v["created_by"] != claims["sub"] and await get_app_role(conn, claims) != "supremo" \
            and not await CompaniesService.user_manages_company(conn, claims["sub"], v["company_id"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só quem criou a vista ou o administrador da empresa apaga.")
    await admin_conn.execute("DELETE FROM public.folder_views WHERE id = $1", view_id)
