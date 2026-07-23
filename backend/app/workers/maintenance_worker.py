"""
ADR-025/030 — Job periódico de retenção de lixeira.
ADR-031 (Notificações × Retenção) — aviso 2 dias antes da exclusão definitiva.
Fase 4.5 — alertas idempotentes de obrigações vencidas/vencendo/bloqueadas/expiradas.
Reset periódico de dados demo (evita acúmulo indefinido de uso orgânico dos
visitantes na mesma empresa/conta compartilhada — ver app/seed/demo_reset_service.py).

Roda no mesmo processo do backend (asyncio.create_task no lifespan), não é
um cron externo — verifica a cada _CHECK_INTERVAL_SECS. Suficiente para o
volume de uso do Docke (mesma lógica do worker de OCR).
"""
import asyncio
import logging
import time

from app.config import settings
from app.services.obligations_service import BLOCKING_LATERAL_SQL, EFFECTIVE_STATUS_SQL, VALIDITY_LATERAL_SQL

logger = logging.getLogger("docke.maintenance_worker")

_CHECK_INTERVAL_SECS = 3600  # roda a cada hora
_STATS_REFRESH_INTERVAL_SECS = 15 * 60  # Fase 3.1/3.3 — "atualizado há X" promete no máximo 15min de atraso

# None (não 0.0!) força um reset já na primeira iteração do loop — a origem
# de time.monotonic() é arbitrária por plataforma (não é "segundos desde o
# boot" garantido), então comparar contra 0.0 podia atrasar o primeiro reset
# em até DEMO_RESET_INTERVAL_HOURS depois de todo deploy, sem nenhum aviso.
_last_demo_reset_at: float | None = None


async def maintenance_worker_loop() -> None:
    while True:
        try:
            await _run_once()
        except asyncio.CancelledError:
            logger.info("Maintenance worker cancelado.")
            break
        except Exception as exc:
            logger.exception("Erro inesperado no maintenance worker: %s", exc)
        await asyncio.sleep(_CHECK_INTERVAL_SECS)


async def stats_refresh_loop() -> None:
    """
    Loop separado do maintenance_worker_loop principal (que roda de hora em
    hora) — os agregados do dashboard (Fase 3.1) prometem no máximo 15min de
    atraso pro usuário, então precisam do próprio ritmo.
    """
    while True:
        try:
            from app.dependencies import _admin_pool
            if _admin_pool is not None:
                async with _admin_pool.acquire() as conn:
                    await conn.execute("SELECT public.refresh_company_stats()")
        except asyncio.CancelledError:
            logger.info("Stats refresh worker cancelado.")
            break
        except Exception as exc:
            logger.exception("Erro ao atualizar mv_company_stats: %s", exc)
        await asyncio.sleep(_STATS_REFRESH_INTERVAL_SECS)


async def _run_once() -> None:
    from app.dependencies import _admin_pool
    if _admin_pool is None:
        return

    async with _admin_pool.acquire() as conn:
        await _notify_trash_expiring_soon(conn)
        await _purge_expired_trash(conn)
        await _notify_obligation_alerts(conn)
        await _reset_demo_data_if_due(conn)


_OBLIGATION_ALERT_STATUSES = ("overdue", "at_risk", "blocked", "expired")


def _obligation_alert_message(status: str, template_name: str, period: str) -> str:
    if status == "overdue":
        return f'"{template_name}" ({period}) está atrasada — nenhum documento comprobatório vinculado ainda.'
    if status == "at_risk":
        return f'"{template_name}" ({period}) vence em breve — vincule o documento comprobatório.'
    if status == "blocked":
        return f'"{template_name}" ({period}) está bloqueada aguardando um pré-requisito ser satisfeito.'
    if status == "expired":
        return f'"{template_name}" ({period}) tem documento comprobatório vencido — vincule um documento atualizado.'
    return f'"{template_name}" ({period}) precisa de atenção.'


async def _notify_obligation_alerts(conn) -> None:
    """
    Fase 4.5: varre todas as instâncias de obrigação de templates ativos e
    notifica admin/operador com acesso não-escopado à empresa quando uma
    instância está em status que exige atenção. Idempotente por
    (instância, status): o `type` da notificação carrega o status
    (obligation_overdue/at_risk/blocked/expired), então uma instância que
    passa de "vencendo" pra "atrasada" gera um alerta novo (é uma mudança
    real), mas ficar atrasada dia após dia nunca dispara duas vezes — mesma
    técnica de idempotência de `_notify_trash_expiring_soon` (NOT EXISTS por
    type+resource_id), sem tabela nova.
    """
    rows = await conn.fetch(
        f"""
        SELECT oi.id, oi.company_id, oi.period, ot.name AS template_name,
               {EFFECTIVE_STATUS_SQL}
        FROM public.obligation_instances oi
        JOIN public.obligation_templates ot ON ot.id = oi.template_id
        {BLOCKING_LATERAL_SQL}
        {VALIDITY_LATERAL_SQL}
        WHERE ot.archived_at IS NULL
        """
    )
    for row in rows:
        eff_status = row["effective_status"]
        if eff_status not in _OBLIGATION_ALERT_STATUSES:
            continue
        notif_type = f"obligation_{eff_status}"

        already_notified = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.notifications WHERE type = $1 AND resource_id = $2)",
            notif_type, row["id"],
        )
        if already_notified:
            continue

        recipients = await conn.fetch(
            """
            SELECT DISTINCT user_id FROM public.user_company_access
            WHERE company_id = $1 AND folder_path IS NULL AND permission_level IN ('admin', 'operador')
            """,
            row["company_id"],
        )
        message = _obligation_alert_message(eff_status, row["template_name"], row["period"])
        for r in recipients:
            await conn.execute(
                """
                INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
                VALUES ($1, $2, $3, 'obligation_instance', $4, $5)
                """,
                r["user_id"], row["company_id"], notif_type, row["id"], message,
            )


async def _reset_demo_data_if_due(conn) -> None:
    global _last_demo_reset_at
    interval_secs = settings.DEMO_RESET_INTERVAL_HOURS * 3600
    now = time.monotonic()
    if _last_demo_reset_at is not None and now - _last_demo_reset_at < interval_secs:
        return

    from app.seed.demo_reset_service import reset_demo_data
    try:
        await reset_demo_data(conn)
        _last_demo_reset_at = now
    except Exception:
        logger.exception("Falha no reset periódico de dados demo — tenta de novo no próximo ciclo.")


async def _notify_trash_expiring_soon(conn) -> None:
    """ADR-031: notifica quem excluiu, 2 dias antes da exclusão definitiva (uma vez por item)."""
    docs = await conn.fetch(
        """
        SELECT d.id, d.name, d.company_id, al.user_id AS deleted_by
        FROM public.documents d
        LEFT JOIN LATERAL (
          SELECT user_id FROM public.activity_log
          WHERE item_id = d.id AND item_type = 'document' AND action = 'delete'
          ORDER BY created_at DESC LIMIT 1
        ) al ON true
        WHERE d.deleted_at IS NOT NULL
          AND d.trash_expires_at IS NOT NULL
          AND d.trash_expires_at BETWEEN now() AND now() + interval '2 days'
          AND al.user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.notifications n
            WHERE n.type = 'trash_expiring' AND n.resource_id = d.id
          )
        """
    )
    for doc in docs:
        await conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
            VALUES ($1, $2, 'trash_expiring', 'document', $3, $4)
            """,
            doc["deleted_by"], doc["company_id"], doc["id"],
            f'"{doc["name"]}" será removido permanentemente em breve. Restaure-o se necessário.',
        )

    folders = await conn.fetch(
        """
        SELECT f.id, f.name, f.company_id, al.user_id AS deleted_by
        FROM public.folders f
        LEFT JOIN LATERAL (
          SELECT user_id FROM public.activity_log
          WHERE item_id = f.id AND item_type = 'folder' AND action = 'delete'
          ORDER BY created_at DESC LIMIT 1
        ) al ON true
        WHERE f.deleted_at IS NOT NULL
          AND f.trash_expires_at IS NOT NULL
          AND f.trash_expires_at BETWEEN now() AND now() + interval '2 days'
          AND al.user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.notifications n
            WHERE n.type = 'trash_expiring' AND n.resource_id = f.id
          )
        """
    )
    for folder in folders:
        await conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
            VALUES ($1, $2, 'trash_expiring', 'folder', $3, $4)
            """,
            folder["deleted_by"], folder["company_id"], folder["id"],
            f'"{folder["name"]}" será removida permanentemente em breve. Restaure-a se necessário.',
        )


async def _purge_expired_trash(conn) -> None:
    """Exclui permanentemente (banco + storage) itens que passaram do prazo de retenção."""
    from app.routers.shares import expire_shares_for_resource
    from app.services import storage_service

    expired_docs = await conn.fetch(
        """
        SELECT d.id, d.storage_path, d.company_id, d.name, al.user_id AS deleted_by
        FROM public.documents d
        LEFT JOIN LATERAL (
          SELECT user_id FROM public.activity_log
          WHERE item_id = d.id AND item_type = 'document' AND action = 'delete'
          ORDER BY created_at DESC LIMIT 1
        ) al ON true
        WHERE d.deleted_at IS NOT NULL AND d.trash_expires_at < now()
        """
    )
    for doc in expired_docs:
        async with conn.transaction():
            await conn.execute("DELETE FROM public.documents WHERE id = $1", doc["id"])
            # activity_log.user_id é NOT NULL — só registra se soubermos quem excluiu originalmente
            # (sempre deveria saber, já que soft-delete sempre loga; defensivo contra dado legado).
            if doc["deleted_by"] is not None:
                await conn.execute(
                    """
                    INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
                    VALUES ($1, $2, 'delete', 'document', $3, $4, '{"auto_purge": true}'::jsonb)
                    """,
                    doc["deleted_by"], doc["company_id"], doc["id"], doc["name"],
                )
            await expire_shares_for_resource(conn, "document", doc["id"])

        if doc["storage_path"]:
            try:
                storage_service.delete_object(doc["storage_path"])
            except Exception:
                logger.warning("Falha ao remover objeto do storage para documento %s — pode ficar órfão.", doc["id"])
        logger.info("Purga automática — documento %s (%s) removido por retenção.", doc["id"], doc["name"])

    # Pastas vazias (sem documentos remanescentes) que também passaram do prazo
    expired_folders = await conn.fetch(
        """
        SELECT f.id, f.company_id, f.name FROM public.folders f
        WHERE f.deleted_at IS NOT NULL AND f.trash_expires_at < now()
          AND NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.folder_id = f.id)
        """
    )
    for folder in expired_folders:
        await conn.execute("DELETE FROM public.folders WHERE id = $1", folder["id"])
        await expire_shares_for_resource(conn, "folder", folder["id"])
        logger.info("Purga automática — pasta %s (%s) removida por retenção.", folder["id"], folder["name"])
