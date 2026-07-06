"""ADR-023/028 — Notificações: listar, marcar como lida(s)."""
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, Query

from app.dependencies import get_db

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("")
async def list_notifications(
    unread_only: bool = Query(False),
    limit: int = Query(20, ge=1, le=100),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    rows = await conn.fetch(
        """
        SELECT id::text, type, resource_type, resource_id::text, message, read_at, created_at
        FROM public.notifications
        WHERE user_id = auth.uid()
          AND ($1::boolean IS FALSE OR read_at IS NULL)
        ORDER BY created_at DESC
        LIMIT $2
        """,
        unread_only, limit,
    )
    unread_count = await conn.fetchval(
        "SELECT count(*) FROM public.notifications WHERE user_id = auth.uid() AND read_at IS NULL"
    )
    return {"results": [dict(r) for r in rows], "unread_count": unread_count}


@router.post("/{notification_id}/read")
async def mark_read(notification_id: str, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    await conn.execute(
        "UPDATE public.notifications SET read_at = now() WHERE id = $1 AND user_id = auth.uid() AND read_at IS NULL",
        notification_id,
    )
    return {"status": "ok"}


@router.post("/mark-all-read")
async def mark_all_read(conn: asyncpg.Connection = Depends(get_db)) -> dict[str, str]:
    await conn.execute(
        "UPDATE public.notifications SET read_at = now() WHERE user_id = auth.uid() AND read_at IS NULL"
    )
    return {"status": "ok"}
