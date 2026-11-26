"""
Avisos no celular por Web Push (B4.4.5). A pessoa liga em Ajustes →
Preferências; cada aparelho grava a sua inscrição. A conta demo não liga
(é compartilhada: um visitante receberia os avisos de outro).
"""
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.config import settings
from app.dependencies import get_current_user, get_db_admin
from app.services import mfa_service

router = APIRouter(prefix="/push", tags=["push"])


class Chaves(BaseModel):
    p256dh: str = Field(..., max_length=200)
    auth: str = Field(..., max_length=100)


class Inscricao(BaseModel):
    endpoint: str = Field(..., max_length=1000, pattern=r"^https://")
    keys: Chaves


class Saida(BaseModel):
    endpoint: str = Field(..., max_length=1000)


@router.get("/public-key")
async def chave_publica() -> dict[str, Any]:
    return {"public_key": settings.VAPID_PUBLIC_KEY or None}


@router.post("/subscribe", status_code=status.HTTP_201_CREATED)
async def inscrever(
    body: Inscricao,
    request: Request,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Os avisos no celular ainda não estão ligados no servidor.")
    if mfa_service.is_demo(claims):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Na demonstração os avisos no celular ficam desligados: a conta é compartilhada.")
    await admin_conn.execute(
        """
        INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
        VALUES ($1::uuid, $2, $3, $4, $5)
        ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                                             user_agent = EXCLUDED.user_agent, failures = 0
        """,
        claims["sub"], body.endpoint, body.keys.p256dh, body.keys.auth, (request.headers.get("user-agent") or "")[:300],
    )
    return {"ok": True}


@router.post("/unsubscribe")
async def sair(
    body: Saida,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    r = await admin_conn.execute("DELETE FROM public.push_subscriptions WHERE endpoint = $1 AND user_id = $2::uuid", body.endpoint, claims["sub"])
    return {"removidas": int(r.split()[-1])}


@router.get("/subscriptions")
async def minhas(
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    rows = await admin_conn.fetch(
        "SELECT endpoint, user_agent, created_at, last_ok_at FROM public.push_subscriptions WHERE user_id = $1::uuid ORDER BY created_at",
        claims["sub"],
    )
    return [dict(r) for r in rows]


async def enviar_pendentes(conn: asyncpg.Connection, client) -> int:
    """Envia os avisos ainda não enviados (últimas 2 h) a quem tem inscrição. Usado pelo worker."""
    from app.services import webpush

    if not (settings.VAPID_PUBLIC_KEY and settings.VAPID_PRIVATE_KEY):
        return 0
    avisos = await conn.fetch(
        """
        SELECT n.id, n.user_id, n.message, n.resource_type, n.resource_id, c.name AS empresa
        FROM public.notifications n JOIN public.companies c ON c.id = n.company_id
        WHERE n.pushed_at IS NULL AND n.created_at > now() - interval '2 hours'
          AND EXISTS (SELECT 1 FROM public.push_subscriptions s WHERE s.user_id = n.user_id)
        ORDER BY n.created_at LIMIT 200
        """,
    )
    enviados = 0
    for a in avisos:
        inscricoes = await conn.fetch("SELECT id, endpoint, p256dh, auth FROM public.push_subscriptions WHERE user_id = $1", a["user_id"])
        destino = "/settings/privacy" if a["resource_type"] == "lgpd_request" else "/dashboard"
        mensagem = {"title": f"Docke · {a['empresa']}", "body": a["message"][:240], "url": destino, "tag": str(a["id"])}
        for s in inscricoes:
            try:
                st = await webpush.enviar(client, dict(s), mensagem, settings.VAPID_PRIVATE_KEY, settings.VAPID_PUBLIC_KEY)
            except Exception:
                st = 0
            if st in (404, 410):
                await conn.execute("DELETE FROM public.push_subscriptions WHERE id = $1", s["id"])
            elif 200 <= st < 300:
                enviados += 1
                await conn.execute("UPDATE public.push_subscriptions SET last_ok_at = now(), failures = 0 WHERE id = $1", s["id"])
            else:
                await conn.execute("UPDATE public.push_subscriptions SET failures = failures + 1 WHERE id = $1", s["id"])
                await conn.execute("DELETE FROM public.push_subscriptions WHERE id = $1 AND failures >= 20", s["id"])
        await conn.execute("UPDATE public.notifications SET pushed_at = now() WHERE id = $1", a["id"])
    # Avisos antigos sem envio não ficam pendentes para sempre.
    await conn.execute("UPDATE public.notifications SET pushed_at = now() WHERE pushed_at IS NULL AND created_at <= now() - interval '2 hours'")
    return enviados
