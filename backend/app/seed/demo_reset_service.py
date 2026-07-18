"""
Reset de dados demo — chamado pelo worker periódico (maintenance_worker.py,
a cada DEMO_RESET_INTERVAL_HOURS) e pelo endpoint manual
(POST /admin/demo/reset, só a própria conta demo pode chamar).

Reaproveita o núcleo do seed (app.seed.demo_data._build_demo_data) mas
recebe uma conexão do pool do app em vez de abrir uma conexão própria —
único jeito seguro de rodar isso dentro do processo do backend em vez de
só via CLI.
"""
from __future__ import annotations

import logging
import secrets

import asyncpg

from app.config import settings
from app.seed.demo_data import DEMO_USER_EMAIL, DEMO_USER_PASSWORD, EXTRA_USERS, _build_demo_data, _ensure_auth_account

logger = logging.getLogger("docke.demo_reset")


async def reset_demo_data(conn: asyncpg.Connection) -> None:
    """
    Restaura as 3 empresas demo ao estado padrão (mesma lógica do
    `python -m app.seed.demo_data`, mas usando uma conexão já aberta do
    pool admin do app). `conn` deve vir de get_db_admin ou de
    `_admin_pool.acquire()` — bypassa RLS, igual ao worker de manutenção.
    """
    if not DEMO_USER_PASSWORD:
        logger.warning("DEMO_PASSWORD não configurada — reset de demo abortado.")
        return

    demo_user_id = await _ensure_auth_account(DEMO_USER_EMAIL, DEMO_USER_PASSWORD, reset_password=False)

    extra_user_ids: dict[str, str] = {}
    for email, _username, _full_name, _permission in EXTRA_USERS:
        extra_user_ids[email] = await _ensure_auth_account(email, secrets.token_urlsafe(24))

    async with conn.transaction():
        await _build_demo_data(conn, demo_user_id, extra_user_ids)

    logger.info("Reset de dados demo concluído (3 empresas restauradas).")
