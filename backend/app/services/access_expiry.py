"""
Acesso temporário (benchmark B3.1.8): concessão direta com prazo vencido sai
sozinha. O worker de miniaturas chama `expirar` a cada volta (30 s).
"""
import json
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import asyncpg

_FUSO = ZoneInfo("America/Sao_Paulo")


def fim_do_dia(d: date) -> datetime:
    """O acesso vale até o fim do dia escolhido, no horário de Brasília."""
    return datetime.combine(d + timedelta(days=1), time(0), _FUSO)


async def expirar(conn: asyncpg.Connection) -> int:
    rows = await conn.fetch(
        """
        DELETE FROM public.user_company_access
        WHERE expires_at IS NOT NULL AND expires_at <= now()
        RETURNING id, user_id, company_id, granted_by, permission_level, folder_path::text AS folder_path
        """
    )
    for r in rows:
        nome = await conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", r["user_id"])
        await conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, actor_type, metadata)
            VALUES ($1, $2, 'access_revoke', 'access', $3, $4, 'access', 'system', $5::jsonb)
            """,
            r["granted_by"] or r["user_id"], r["company_id"], r["user_id"], nome or "pessoa",
            json.dumps({"motivo": "prazo do acesso vencido", "papel": r["permission_level"], "pasta": r["folder_path"]}),
        )
    return len(rows)
