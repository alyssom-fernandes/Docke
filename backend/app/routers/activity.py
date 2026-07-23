from datetime import date
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.activity_service import ActivityService, REVERSIBLE_ACTIONS

router = APIRouter(prefix="/activity", tags=["activity"])

_PAGE_SIZE_MAX = 200


# ---------------------------------------------------------------------------
# GET /activity — lista eventos com filtros
# ---------------------------------------------------------------------------

@router.get("")
async def list_activity(
    company_id: UUID = Query(...),
    user_id: UUID | None = Query(None),
    action: str | None = Query(None),
    item_type: str | None = Query(None),
    item_id: UUID | None = Query(None, description="Filtra pela timeline de um documento/pasta específico (Fase 2.6)"),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=_PAGE_SIZE_MAX),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    Lista eventos do activity_log filtrados por empresa.
    Filtros opcionais: user_id, action, item_type, item_id, date_from, date_to.
    RLS garante que só company members veem os logs da empresa.
    """
    return await ActivityService.list_events(
        conn,
        company_id=company_id, user_id=user_id, action=action, item_type=item_type, item_id=item_id,
        date_from=date_from, date_to=date_to, page=page, page_size=page_size,
    )


# ---------------------------------------------------------------------------
# GET /activity/export — exporta CSV (deve vir antes de /{event_id})
# ---------------------------------------------------------------------------

@router.get("/export")
async def export_activity_csv(
    company_id: UUID = Query(...),
    user_id: UUID | None = Query(None),
    action: str | None = Query(None),
    item_type: str | None = Query(None),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    format: str = Query("csv", pattern="^(csv|xlsx)$"),
    conn: asyncpg.Connection = Depends(get_db),
) -> Response:
    """
    Exporta eventos do activity_log como CSV (padrão) ou XLSX (?format=xlsx).
    Retorna Content-Disposition: attachment.
    """
    rows = await ActivityService.fetch_export_rows(
        conn,
        company_id=company_id, user_id=user_id, action=action, item_type=item_type,
        date_from=date_from, date_to=date_to,
    )

    if format == "xlsx":
        xlsx_bytes = ActivityService.build_xlsx(rows)
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": 'attachment; filename="activity_log.xlsx"',
                "Content-Length": str(len(xlsx_bytes)),
            },
        )

    csv_bytes = ActivityService.build_csv(rows)
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="activity_log.csv"',
            "Content-Length": str(len(csv_bytes)),
        },
    )


# ---------------------------------------------------------------------------
# GET /activity/verify-integrity — recalcula a cadeia de hash e aponta onde
# quebrou, se quebrou (Fase 2.9). Só admin/supremo — é uma ferramenta de
# auditoria, não algo que qualquer membro da empresa precisa ver.
# ---------------------------------------------------------------------------

@router.get("/verify-integrity")
async def verify_activity_integrity(
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = await get_app_role(conn, claims)
    if role not in ("admin", "supremo"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores podem verificar a integridade da trilha de auditoria.")

    rows = await ActivityService.verify_chain(conn, company_id=company_id)
    broken = [dict(r) for r in rows if not r["ok"]]
    return {
        "total_events": len(rows),
        "intact": len(broken) == 0,
        "broken_count": len(broken),
        "first_broken": broken[0] if broken else None,
    }


# ---------------------------------------------------------------------------
# POST /activity/undo/:id — cria evento de undo (I1: append-only)
# ---------------------------------------------------------------------------

@router.post("/undo/{event_id}", status_code=status.HTTP_201_CREATED)
async def undo_activity(
    event_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Cria um evento de undo para um evento existente.
    I1 (append-only): NUNCA edita eventos existentes — cria um novo.

    Ações reversíveis: move, rename, delete, favorite.
    Ações não reversíveis (retorna 422): upload, view, download, restore, unfavorite, undo.
    """
    user_id = claims["sub"]

    event = await ActivityService.get_event(conn, event_id)
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evento não encontrado.")

    if event["action"] not in REVERSIBLE_ACTIONS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Ação '{event['action']}' não é reversível via undo.",
        )

    row = await ActivityService.create_undo_event(admin_conn, user_id=user_id, event=event, event_id=event_id)

    return dict(row) | {
        "undo_of_event_id": str(event_id),
        "original_action": event["action"],
        "instructions": ActivityService.undo_instructions(dict(event)),
    }
