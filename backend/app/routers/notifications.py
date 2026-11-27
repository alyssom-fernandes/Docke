"""ADR-023/028 — Notificações: listar, marcar como lida(s) e escolher quais receber (A8-12)."""
from datetime import datetime, timezone
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
    archived: bool = Query(False, description="B4.4.1: só os arquivados."),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    rows = await notification_service.list_notifications(conn, unread_only=unread_only, limit=limit, archived=archived)
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


class Snooze(BaseModel):
    until: datetime


@router.post("/{notification_id}/snooze")
async def snooze(notification_id: str, body: Snooze, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    """B4.4.1: some da caixa até a data e volta como não lido."""
    alvo = body.until if body.until.tzinfo else body.until.replace(tzinfo=timezone.utc)
    if alvo <= datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Escolha um momento no futuro.")
    feito = await conn.fetchval(
        "UPDATE public.notifications SET snoozed_until = $2, read_at = NULL, archived_at = NULL WHERE id = $1::uuid AND user_id = auth.uid() RETURNING id",
        notification_id, alvo,
    )
    if feito is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Aviso não encontrado.")
    return {"status": "ok"}


@router.post("/{notification_id}/archive")
async def archive(notification_id: str, restore: bool = Query(False), conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    """B4.4.1: arquivar tira da caixa sem apagar; restore=true devolve."""
    feito = await conn.fetchval(
        """
        UPDATE public.notifications
        SET archived_at = CASE WHEN $2 THEN NULL ELSE now() END,
            read_at = coalesce(read_at, now()), snoozed_until = NULL
        WHERE id = $1::uuid AND user_id = auth.uid() RETURNING id
        """,
        notification_id, restore,
    )
    if feito is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Aviso não encontrado.")
    return {"status": "ok"}


@router.post("/{notification_id}/read")
async def mark_read(notification_id: str, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    await notification_service.mark_read(conn, notification_id)
    return {"status": "ok"}


@router.post("/mark-all-read")
async def mark_all_read(conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    await notification_service.mark_all_read(conn)
    return {"status": "ok"}
