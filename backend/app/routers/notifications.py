"""ADR-023/028 — Notificações: listar, marcar como lida(s) e escolher quais receber (A8-12)."""
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin
from app.services import notification_service

# Só os avisos de rotina podem ser silenciados (o gatilho do banco repete a
# regra): segurança, atraso, conferência e pedidos chegam sempre.
SILENCIAVEIS = (
    "folder_activity", "version_added", "share_accessed", "trash_expiring",
    "obligation_at_risk", "upload_request_received", "retention_expiring_90", "retention_expiring_30",
)

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(20, ge=1, le=100),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    rows = await notification_service.list_notifications(conn, unread_only=unread_only, limit=limit)
    unread_count = await notification_service.count_unread(conn)
    return {"results": [dict(r) for r in rows], "unread_count": unread_count}


class NotificationPrefs(BaseModel):
    muted: list[str]


@router.get("/preferences")
async def get_preferences(
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    muted = await admin_conn.fetchval("SELECT notification_mute FROM public.users WHERE id = $1", claims["sub"])
    return {"muted": list(muted or []), "mutable": list(SILENCIAVEIS)}


@router.put("/preferences")
async def set_preferences(
    body: NotificationPrefs,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    fora = sorted(set(body.muted) - set(SILENCIAVEIS))
    if fora:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Estes avisos não podem ser desligados: {', '.join(fora)}.")
    muted = sorted(set(body.muted))
    await admin_conn.execute("UPDATE public.users SET notification_mute = $2 WHERE id = $1", claims["sub"], muted)
    return {"muted": muted, "mutable": list(SILENCIAVEIS)}


@router.post("/{notification_id}/read")
async def mark_read(notification_id: str, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    await notification_service.mark_read(conn, notification_id)
    return {"status": "ok"}


@router.post("/mark-all-read")
async def mark_all_read(conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    await notification_service.mark_all_read(conn)
    return {"status": "ok"}
