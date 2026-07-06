"""
ADR-023/028/031 — Geração de notificações.
Funções chamadas pelos routers nos pontos de mutação relevantes (upload,
versão nova, acesso a link, bloqueio de senha). Todas usam a admin_conn
(service_role) — notificações são um efeito colateral do sistema, não uma
ação do usuário sujeita a RLS.
"""
from typing import Any
from uuid import UUID

import asyncpg


async def notify_folder_favoriters(
    conn: asyncpg.Connection,
    folder_id: UUID,
    company_id: UUID,
    actor_user_id: str,
    message: str,
) -> None:
    """ADR-023, evento 1: atividade em pasta favoritada (upload/mover/excluir)."""
    users = await conn.fetch(
        "SELECT DISTINCT user_id FROM public.favorites WHERE folder_id = $1 AND user_id != $2",
        folder_id, actor_user_id,
    )
    for u in users:
        await conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, actor_user_id, message)
            VALUES ($1, $2, 'folder_activity', 'folder', $3, $4, $5)
            """,
            u["user_id"], company_id, folder_id, actor_user_id, message,
        )


async def notify_document_watchers(
    conn: asyncpg.Connection,
    document_id: UUID,
    company_id: UUID,
    actor_user_id: str,
    message: str,
) -> None:
    """
    ADR-031 (Notificações × Versionamento): quando um documento recebe nova
    versão, notifica quem favoritou o documento e quem o visualizou
    recentemente (últimos 30 dias) — nunca quem só fez o upload original.
    """
    users = await conn.fetch(
        """
        SELECT DISTINCT user_id FROM (
          SELECT user_id FROM public.favorites WHERE document_id = $1
          UNION
          SELECT user_id FROM public.activity_log
          WHERE item_id = $1 AND item_type = 'document' AND action = 'view'
            AND created_at > now() - interval '30 days'
        ) watchers
        WHERE user_id != $2
        """,
        document_id, actor_user_id,
    )
    for u in users:
        await conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, actor_user_id, message)
            VALUES ($1, $2, 'version_added', 'document', $3, $4, $5)
            """,
            u["user_id"], company_id, document_id, actor_user_id, message,
        )


async def notify_share_accessed(conn: asyncpg.Connection, share_id: UUID) -> None:
    """
    ADR-023, evento 2: link acessado — agregado (uma notificação por link a
    cada 24h, não uma por acesso, pra não gerar spam).
    """
    share = await conn.fetchrow(
        "SELECT resource_type, resource_id, company_id, created_by FROM public.shares WHERE id = $1",
        share_id,
    )
    if share is None:
        return

    name = None
    if share["resource_type"] == "document":
        name = await conn.fetchval("SELECT name FROM public.documents WHERE id = $1", share["resource_id"])
    else:
        name = await conn.fetchval("SELECT name FROM public.folders WHERE id = $1", share["resource_id"])
    name = name or "recurso compartilhado"

    existing = await conn.fetchrow(
        """
        SELECT id, message FROM public.notifications
        WHERE type = 'share_accessed' AND resource_id = $1 AND read_at IS NULL
          AND created_at > now() - interval '24 hours'
        ORDER BY created_at DESC LIMIT 1
        """,
        share["resource_id"],
    )
    if existing:
        # Reaproveita a notificação e incrementa a contagem no texto.
        import re
        match = re.search(r"acessado (\d+) vez", existing["message"])
        count = int(match.group(1)) + 1 if match else 2
        await conn.execute(
            "UPDATE public.notifications SET message = $2, created_at = now() WHERE id = $1",
            existing["id"], f'Seu link para "{name}" foi acessado {count} vezes hoje.',
        )
    else:
        await conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
            VALUES ($1, $2, 'share_accessed', $3, $4, $5)
            """,
            share["created_by"], share["company_id"], share["resource_type"], share["resource_id"],
            f'Seu link para "{name}" foi acessado 1 vez hoje.',
        )


async def notify_share_blocked(conn: asyncpg.Connection, share_id: UUID) -> None:
    """ADR-031 (Notificações × Segurança de Compartilhamento): token bloqueado por tentativas de senha."""
    share = await conn.fetchrow(
        "SELECT resource_type, resource_id, company_id, created_by FROM public.shares WHERE id = $1",
        share_id,
    )
    if share is None:
        return
    if share["resource_type"] == "document":
        name = await conn.fetchval("SELECT name FROM public.documents WHERE id = $1", share["resource_id"])
    else:
        name = await conn.fetchval("SELECT name FROM public.folders WHERE id = $1", share["resource_id"])
    name = name or "recurso compartilhado"

    await conn.execute(
        """
        INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
        VALUES ($1, $2, 'share_blocked', $3, $4, $5)
        """,
        share["created_by"], share["company_id"], share["resource_type"], share["resource_id"],
        f'Seu link para "{name}" foi bloqueado por excesso de tentativas de senha. Gere um novo link se necessário.',
    )
