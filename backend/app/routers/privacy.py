"""
Privacidade (LGPD) — X2-17, B3.7.1, B3.7.3, B3.7.5.

- Classificar uma pasta como "dado pessoal" ou "dado sensível" (vale para as
  subpastas). Pasta com dado sensível não aceita link público.
- Atender pedido do titular: achar os documentos que citam um CPF ou nome,
  com a pasta e a classificação, e registrar a consulta na trilha (o CPF não
  é gravado em claro, só um resumo SHA-256).
"""
import hashlib
import json
import re
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.dependencies import get_app_role, get_current_user, get_db
from app.services.companies_service import CompaniesService
from app.services.folders_service import FoldersService
from app.services.search_service import SearchService

router = APIRouter(tags=["privacy"])

_LABELS = {"normal": "sem classificação", "pessoal": "dado pessoal", "sensivel": "dado sensível"}


class SensitivityBody(BaseModel):
    sensitivity: str


@router.get("/folders/{folder_id}/privacy")
async def folder_privacy(folder_id: UUID, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, Any]:
    row = await conn.fetchrow(
        "SELECT sensitivity, public.folder_effective_sensitivity(id) AS effective FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
        folder_id,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    return {"sensitivity": row["sensitivity"], "effective": row["effective"], "inherited": row["effective"] != row["sensitivity"]}


@router.put("/folders/{folder_id}/privacy")
async def set_folder_privacy(
    folder_id: UUID,
    body: SensitivityBody,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if body.sensitivity not in _LABELS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Use normal, pessoal ou sensivel.")
    folder = await FoldersService.get_folder_for_move(conn, folder_id)
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    permission = await FoldersService.check_permission(conn, claims["sub"], folder["path"], folder["company_id"])
    if permission != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores classificam pastas.")
    old = await conn.fetchval("SELECT sensitivity FROM public.folders WHERE id = $1", folder_id)
    await conn.execute("UPDATE public.folders SET sensitivity = $2 WHERE id = $1", folder_id, body.sensitivity)
    if old != body.sensitivity:
        await FoldersService.log_activity(
            conn, folder_id=folder_id, company_id=folder["company_id"], action="privacy_set", name=folder["name"],
            metadata=json.dumps({"de": _LABELS[old], "para": _LABELS[body.sensitivity]}, ensure_ascii=False),
        )
    effective = await conn.fetchval("SELECT public.folder_effective_sensitivity($1)", folder_id)
    return {"sensitivity": body.sensitivity, "effective": effective, "inherited": effective != body.sensitivity}


@router.get("/companies/{company_id}/privacy/folders")
async def sensitive_folders(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Pastas classificadas da empresa (o inventário começa por elas)."""
    rows = await conn.fetch(
        """
        SELECT f.id::text, f.name, f.sensitivity, f.path::text AS path,
               (SELECT count(*) FROM public.documents d JOIN public.folders s ON s.id = d.folder_id
                 WHERE s.company_id = f.company_id AND s.path <@ f.path AND d.deleted_at IS NULL) AS documentos
        FROM public.folders f
        WHERE f.company_id = $1 AND f.deleted_at IS NULL AND f.sensitivity <> 'normal'
        ORDER BY f.sensitivity DESC, f.name
        """,
        company_id,
    )
    return [dict(r) for r in rows]


@router.get("/companies/{company_id}/privacy/titular")
async def titular_search(
    company_id: UUID,
    q: str = Query(..., min_length=3, max_length=120, description="CPF (com ou sem pontuação) ou nome do titular."),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Pedido do titular (LGPD art. 18): documentos que citam o CPF ou o nome,
    com pasta e classificação. Só administradores da empresa. A consulta fica
    na trilha com o resumo SHA-256 do termo, nunca o CPF em claro.
    """
    role = await get_app_role(conn, claims)
    if role != "supremo" and not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores da empresa atendem pedidos do titular.")
    termo = q.strip()
    normalized = SearchService.normalize_query(termo)
    if not normalized and not SearchService.digits_pattern(termo):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Informe um CPF ou um nome.")
    result = await SearchService.search(
        conn, q=termo, normalized=normalized or termo, company_id=company_id, folder_id=None,
        sector=None, file_type=None, page=1, page_size=100,
    )
    docs = result.get("results", [])
    ids = [UUID(d["id"]) for d in docs if d.get("id")]
    sens = {}
    if ids:
        for r in await conn.fetch(
            "SELECT d.id::text, public.folder_effective_sensitivity(d.folder_id) AS s FROM public.documents d WHERE d.id = ANY($1::uuid[])", ids,
        ):
            sens[r["id"]] = r["s"]
    for d in docs:
        d["sensitivity"] = sens.get(d.get("id"), "normal")

    digits = re.sub(r"\D", "", termo)
    resumo = hashlib.sha256((digits if len(digits) >= 11 else termo.lower()).encode()).hexdigest()[:16]
    await conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata, severity)
        VALUES ($1, $2, 'lgpd_titular_search', 'config', $2, 'Pedido do titular', $3::jsonb, 'warning')
        """,
        claims["sub"], company_id, json.dumps({"termo_sha256": resumo, "encontrados": result.get("total", len(docs))}),
    )
    return {"total": result.get("total", len(docs)), "results": docs}
