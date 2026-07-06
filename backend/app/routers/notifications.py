"""ADR-023/028 — Notificações: listar, marcar como lida(s)."""
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, Query

from app.dependencies import get_db
from app.services import notification_service

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


@router.post("/{notification_id}/read")
async def mark_read(notification_id: str, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    await notification_service.mark_read(conn, notification_id)
    return {"status": "ok"}


@router.post("/mark-all-read")
async def mark_all_read(conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    await notification_service.mark_all_read(conn)
    return {"status": "ok"}
