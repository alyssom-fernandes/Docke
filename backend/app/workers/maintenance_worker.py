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
import re
import time

import asyncpg

from app.config import settings
from app.services.obligations_service import (
    BLOCKING_LATERAL_SQL,
    EFFECTIVE_STATUS_SQL,
    NOT_APPLICABLE_LATERAL_SQL,
    VALIDITY_LATERAL_SQL,
    ObligationsService,
    period_label,
)

logger = logging.getLogger("docke.maintenance_worker")

_CHECK_INTERVAL_SECS = 3600  # roda a cada hora
_STATS_REFRESH_INTERVAL_SECS = 15 * 60  # Fase 3.1/3.3 — "atualizado há X" promete no máximo 15min de atraso

# None (não 0.0!) força um reset já na primeira iteração do loop — a origem
# de time.monotonic() é arbitrária por plataforma (não é "segundos desde o
# boot" garantido), então comparar contra 0.0 podia atrasar o primeiro reset
# em até DEMO_RESET_INTERVAL_HOURS depois de todo deploy, sem nenhum aviso.
_last_demo_reset_at: float | None = None

# Varredura de arquivos de empresas apagadas: uma vez por dia basta.
_VARREDURA_INTERVALO_SECS = 24 * 3600
_last_varredura_at: float | None = None


async def maintenance_worker_loop() -> None:
    from app.services.heartbeat import beat

    while True:
        beat("manutencao")
        try:
            await _run_once()
        except asyncio.CancelledError:
            logger.info("Maintenance worker cancelado.")
            break
        except Exception as exc:
            logger.exception("Erro inesperado no maintenance worker: %s", exc)
        await asyncio.sleep(_CHECK_INTERVAL_SECS)


async def push_worker_loop() -> None:
    """Envia os avisos novos da central para os celulares inscritos (Web Push, B4.4.5)."""
    import httpx

    from app.routers.push import enviar_pendentes
    from app.services.heartbeat import beat

    async with httpx.AsyncClient(timeout=10) as client:
        while True:
            beat("avisos")
            try:
                from app.dependencies import _admin_pool
                if _admin_pool is not None:
                    async with _admin_pool.acquire() as conn:
                        await enviar_pendentes(conn, client)
            except asyncio.CancelledError:
                logger.info("Push worker cancelado.")
                break
            except Exception as exc:
                logger.exception("Erro no envio de avisos push: %s", exc)
            await asyncio.sleep(20)


async def stats_refresh_loop() -> None:
    """
    Loop separado do maintenance_worker_loop principal (que roda de hora em
    hora) — os agregados do dashboard (Fase 3.1) prometem no máximo 15min de
    atraso pro usuário, então precisam do próprio ritmo.
    """
    from app.services.heartbeat import beat

    while True:
        beat("estatisticas")
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
        await _cleanup_stale_pending_uploads(conn)
        await _cleanup_old_notifications(conn)
        try:
            await _purge_old_versions(conn)
        except Exception as exc:  # noqa: BLE001 — não pode parar a manutenção
            logger.exception("Falha ao aplicar a retenção de versões: %s", exc)
        from app.workers.export_worker import purge_expired_exports
        await purge_expired_exports(conn)
        # Recorrência (A7-07): competências mensais e anuais aparecem sozinhas.
        try:
            await ObligationsService.generate_due_instances(conn)
        except Exception as exc:  # noqa: BLE001 — um modelo ruim não pode parar a manutenção
            logger.exception("Falha ao gerar competências de obrigações: %s", exc)
        await _notify_obligation_alerts(conn)
        await _notify_retention_expiring_soon(conn)
        await _scan_retention_expirations(conn)
        await _reset_demo_data_if_due(conn)
        try:
            await _varrer_arquivos_de_empresas_apagadas(conn)
        except Exception as exc:  # noqa: BLE001 — melhor esforço; tenta de novo no dia seguinte
            logger.exception("Falha na varredura de arquivos de empresas apagadas: %s", exc)
        # Partições futuras da trilha (X3-13): cria as que faltam, 24 meses à frente.
        try:
            criadas = await conn.fetchval("SELECT public.ensure_activity_log_partitions(24)")
            if criadas:
                logger.info("Trilha: %d partição(ões) mensal(is) criada(s).", criadas)
        except Exception as exc:  # noqa: BLE001 — não pode parar a manutenção
            logger.exception("Falha ao garantir partições da trilha: %s", exc)


# Onde o storage guarda arquivos por empresa: o primeiro trecho depois do
# prefixo é sempre o id da empresa.
_PREFIXOS_POR_EMPRESA = ("documents/", "derivatives/documents/", "exports/", "company-logos/")
_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def chaves_de_empresas_apagadas(objetos, empresas_existentes: set[str], limite) -> list[str]:
    """
    Escolhe, entre (chave, data) do storage, as chaves de empresas que não
    existem mais no banco e que não mudam desde antes de `limite`. Tudo o que
    não tem um id de empresa reconhecível fica onde está: a varredura nunca
    apaga um arquivo cuja dona ela não sabe dizer.
    """
    apagar: list[str] = []
    for chave, alterado in objetos:
        prefixo = next((p for p in _PREFIXOS_POR_EMPRESA if chave.startswith(p)), None)
        if prefixo is None:
            continue
        m = _UUID_RE.match(chave[len(prefixo):])
        if not m or m.group(0) in empresas_existentes:
            continue
        if alterado is None or alterado >= limite:
            continue
        apagar.append(chave)
    return apagar


async def _varrer_arquivos_de_empresas_apagadas(conn) -> int:
    """
    Recolhe do storage os arquivos de empresas apagadas do banco (o reset da
    demo, a exclusão de uma empresa ou uma falha no meio de uma exclusão
    deixavam objetos sem dono no R2). Só apaga o que tem mais de 1 dia, para
    não pegar uma empresa criada agora cuja transação ainda não apareceu.
    """
    global _last_varredura_at
    agora = time.monotonic()
    if _last_varredura_at is not None and agora - _last_varredura_at < _VARREDURA_INTERVALO_SECS:
        return 0
    _last_varredura_at = agora

    from datetime import datetime, timedelta, timezone

    from app.services import storage_service

    existentes = {str(r["id"]) for r in await conn.fetch("SELECT id FROM public.companies")}
    limite = datetime.now(timezone.utc) - timedelta(days=1)

    def _listar_e_apagar() -> tuple[int, int]:
        objetos = [o for p in _PREFIXOS_POR_EMPRESA for o in storage_service.list_objects(p)]
        chaves = chaves_de_empresas_apagadas(objetos, existentes, limite)
        falhas = 0
        for chave in chaves:
            try:
                storage_service.delete_object(chave)
            except Exception:  # noqa: BLE001
                falhas += 1
        return len(chaves), falhas

    apagados, falhas = await asyncio.to_thread(_listar_e_apagar)
    if apagados:
        logger.info("Varredura do storage: %d arquivo(s) de empresas apagadas removido(s), %d falha(s).", apagados, falhas)
    return apagados


async def _cleanup_old_notifications(conn) -> None:
    """Avisos lidos há mais de 90 dias saem da caixa (B4.4.7): ela não cresce
    sem fim. Os não lidos ficam até alguém ler."""
    st = await conn.execute(
        "DELETE FROM public.notifications WHERE read_at IS NOT NULL AND read_at < now() - interval '90 days'"
    )
    n = int(st.split()[-1]) if st else 0
    if n:
        logger.info("Limpeza: %d aviso(s) lido(s) antigo(s) removido(s).", n)


async def _cleanup_stale_pending_uploads(conn) -> None:
    """
    Registros provisórios de upload (sem hash) com mais de 6 horas: o envio
    nunca se completou (aba fechada, rede caiu). Saem do banco e do storage,
    para não ocupar o nome do arquivo nem aparecer como documento.
    """
    from app.services import storage_service

    rows = await conn.fetch(
        """
        DELETE FROM public.documents
        WHERE content_hash IS NULL AND copied_from IS NULL AND created_at < now() - interval '6 hours'
        RETURNING id, storage_path
        """
    )
    for row in rows:
        if row["storage_path"]:
            try:
                storage_service.delete_object(row["storage_path"])
            except Exception:
                pass
    if rows:
        logger.info("Limpeza: %d envio(s) incompleto(s) removido(s).", len(rows))


async def _scan_retention_expirations(conn) -> None:
    """
    Fase 5.5: varre documentos ativos cujo prazo de retenção calculado
    (`document_retention_info`) já passou e que NÃO estão sob legal hold,
    inserindo-os na fila de revisão humana. Nunca apaga nada — só registra o
    candidato. Idempotente pelo índice único parcial em
    `retention_review_queue` (no máximo uma entrada pending/deferred por
    documento) — reprocessar o scan não duplica a fila nem "ressuscita" um
    item que já foi decidido (approved/rejected ficam fora do índice, então
    não bloqueiam uma reentrada se o documento voltar a vencer sob uma nova
    política — mas isso é cenário raro e aceitável nesta fatia).
    """
    await conn.execute(
        """
        INSERT INTO public.retention_review_queue (company_id, document_id, policy_id, policy_name_snapshot, computed_expires_at)
        SELECT d.company_id, d.id, info.policy_id, info.policy_name, info.expires_at
        FROM public.documents d
        CROSS JOIN LATERAL public.document_retention_info(d.id) info
        WHERE d.deleted_at IS NULL
          AND info.expires_at IS NOT NULL
          AND info.expires_at < CURRENT_DATE
          AND NOT public.document_is_under_hold(d.id)
        ON CONFLICT (document_id) WHERE status IN ('pending', 'deferred') DO NOTHING
        """
    )


_RETENTION_WARNING_DAYS = (90, 30, 7)


async def _notify_retention_expiring_soon(conn) -> None:
    """
    Fase 14.5: avisa admin/operador com acesso não-escopado à empresa quando o
    prazo de retenção de um documento (calculado por `document_retention_info`,
    mesma fonte de verdade do `_scan_retention_expirations`) está a 90/30/7 dias
    de vencer. Documentos sob legal hold não entram (o prazo não vai "vencer"
    de fato enquanto o hold existir). Idempotente por (type, resource_id) —
    cada janela tem seu próprio `type`, então um documento recebe no máximo um
    aviso por janela conforme o tempo passa (90 dias antes, depois 30, depois 7),
    nunca duas vezes a mesma janela.
    """
    # Só a janela mais próxima: um documento a 25 dias do prazo recebe o aviso
    # de 30 dias, não o de 90 e o de 30 juntos (achado X3-09 — com a máquina
    # desligada por dias, as três janelas chegavam de uma vez).
    janelas = sorted(_RETENTION_WARNING_DAYS)
    for i, days in enumerate(janelas):
        anterior = janelas[i - 1] if i > 0 else -1
        notif_type = f"retention_expiring_{days}"
        rows = await conn.fetch(
            """
            SELECT d.id, d.name, d.company_id, info.expires_at
            FROM public.documents d
            CROSS JOIN LATERAL public.document_retention_info(d.id) info
            WHERE d.deleted_at IS NULL
              AND info.expires_at IS NOT NULL
              AND info.expires_at >= CURRENT_DATE
              AND info.expires_at <= CURRENT_DATE + ($1::int * interval '1 day')
              AND ($3::int < 0 OR info.expires_at > CURRENT_DATE + ($3::int * interval '1 day'))
              AND NOT public.document_is_under_hold(d.id)
              AND NOT EXISTS (
                SELECT 1 FROM public.notifications n
                WHERE n.type = $2 AND n.resource_id = d.id
              )
            """,
            days, notif_type, anterior,
        )
        for row in rows:
            recipients = await conn.fetch(
                """
                SELECT DISTINCT user_id FROM public.user_company_access
                WHERE company_id = $1 AND folder_path IS NULL AND permission_level IN ('admin', 'operador')
                """,
                row["company_id"],
            )
            message = (
                f'"{row["name"]}" vence a retenção em {days} dia(s) '
                f'({row["expires_at"].strftime("%d/%m/%Y")}).'
            )
            for r in recipients:
                await conn.execute(
                    """
                    INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
                    VALUES ($1, $2, $3, 'document', $4, $5)
                    """,
                    r["user_id"], row["company_id"], notif_type, row["id"], message,
                )


_OBLIGATION_ALERT_STATUSES = ("overdue", "at_risk", "blocked", "expired")


def _obligation_alert_message(status: str, template_name: str, period: str) -> str:
    period = period_label(period)
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
        SELECT oi.id, oi.company_id, oi.period, oi.owner_id, ot.name AS template_name,
               {EFFECTIVE_STATUS_SQL}
        FROM public.obligation_instances oi
        JOIN public.obligation_templates ot ON ot.id = oi.template_id
        {BLOCKING_LATERAL_SQL}
        {VALIDITY_LATERAL_SQL}
        {NOT_APPLICABLE_LATERAL_SQL}
        WHERE ot.archived_at IS NULL
          AND public.company_feature_enabled(oi.company_id, 'obrigacoes')
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

        # Com responsável, o aviso vai para ele; atraso e documento vencido
        # também sobem para quem administra a empresa (A7-08). Sem
        # responsável, vai para admins e operadores, como antes.
        recipients = await conn.fetch(
            """
            SELECT DISTINCT user_id FROM public.user_company_access
            WHERE company_id = $1 AND folder_path IS NULL
              AND (
                ($2::uuid IS NULL AND permission_level IN ('admin', 'operador'))
                OR user_id = $2::uuid
                OR ($2::uuid IS NOT NULL AND $3 AND permission_level = 'admin')
              )
            """,
            row["company_id"], row["owner_id"], eff_status in ("overdue", "expired"),
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
    """
    Restaura a demo quando a última restauração (a data de criação das
    empresas fictícias, guardada no banco) passou de DEMO_RESET_INTERVAL_HOURS.
    Antes, toda partida da máquina restaurava a demo: quem ficava alguns
    minutos parado (auto_stop) voltava para uma demo nova, com IDs diferentes,
    e via 404 no que estava aberto. A senha da conta demo continua sendo
    conferida na partida: se o segredo DEMO_PASSWORD mudou, restaura na hora
    (o reset sincroniza a senha no Auth).
    """
    global _last_demo_reset_at
    if not settings.DEMO_PASSWORD:
        return
    from app.seed.demo_data import COMPANIES
    from app.seed.demo_reset_service import _demo_password_works, reset_demo_data

    force = False
    if _last_demo_reset_at is None:  # primeira passada desde a partida
        _last_demo_reset_at = time.monotonic()
        try:
            force = not await _demo_password_works()
        except Exception:
            force = False
    if not force:
        ultima = await conn.fetchval(
            "SELECT min(created_at) FROM public.companies WHERE name = ANY($1::text[])", [c[0] for c in COMPANIES]
        )
        if ultima is not None and await conn.fetchval(
            "SELECT $1::timestamptz > now() - ($2 || ' hours')::interval", ultima, str(settings.DEMO_RESET_INTERVAL_HOURS)
        ):
            return
    try:
        await reset_demo_data(conn)
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
          -- Sob legal hold ou com retenção travada vigente, o documento fica
          -- na lixeira até o bloqueio acabar (achado X3-07); o banco também
          -- recusaria o DELETE (migration 20261125000001).
          AND public.document_deletion_block_reason(d.id) IS NULL
        """
    )
    for doc in expired_docs:
        version_keys = [r["storage_key"] for r in await conn.fetch(
            "SELECT DISTINCT storage_key FROM public.document_versions WHERE document_id = $1", doc["id"],
        )]
        try:
            await _purge_document(conn, doc, expire_shares_for_resource)
        except asyncpg.exceptions.RaiseError:
            # O bloqueio pode ter começado entre a consulta e a exclusão.
            logger.warning("Purga automática pulou o documento %s: exclusão bloqueada por hold ou retenção.", doc["id"])
            continue

        # Arquivo atual, versões antigas e derivados (X3-08), fora do laço assíncrono.
        falhas = await asyncio.to_thread(storage_service.delete_document_objects, [doc["storage_path"], *version_keys])
        if falhas:
            logger.warning("Purga do documento %s: %d objeto(s) não saíram do storage: %s", doc["id"], len(falhas), falhas)
        logger.info("Purga automática — documento %s (%s) removido por retenção.", doc["id"], doc["name"])

    await _purge_expired_folders(conn, expire_shares_for_resource)


async def _purge_document(conn, doc, expire_shares_for_resource) -> None:
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


async def _purge_expired_folders(conn, expire_shares_for_resource) -> None:
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


async def _purge_old_versions(conn) -> int:
    """
    Retenção do histórico de versões (B1.4.9): nas empresas que definiram um
    prazo, apaga a versão antiga substituída há mais tempo que ele (nunca a
    atual; legal hold e retenção travada protegem, e o gatilho do banco
    recusa). Fica na trilha como ação do sistema. Até 200 por volta.
    """
    import asyncio
    import json

    from app.services import storage_service

    rows = await conn.fetch(
        """
        SELECT v.id, v.document_id, v.version_number, v.storage_key, d.company_id, d.name, c.versions_keep_days,
               coalesce(d.uploaded_by, (SELECT u.id FROM public.users u WHERE u.role = 'supremo' ORDER BY u.created_at LIMIT 1)) AS ator
        FROM public.document_versions v
        JOIN public.documents d ON d.id = v.document_id
        JOIN public.companies c ON c.id = d.company_id
        WHERE c.versions_keep_days IS NOT NULL
          AND d.current_version_id IS DISTINCT FROM v.id
          AND v.storage_key IS DISTINCT FROM d.storage_path
          AND public.document_deletion_block_reason(d.id) IS NULL
          AND EXISTS (
            SELECT 1 FROM public.document_versions n
            WHERE n.document_id = v.document_id AND n.version_number > v.version_number
              AND n.created_at < now() - make_interval(days => c.versions_keep_days)
          )
        ORDER BY v.created_at
        LIMIT 200
        """
    )
    apagadas = 0
    for r in rows:
        try:
            await conn.execute("DELETE FROM public.document_versions WHERE id = $1", r["id"])
        except Exception:  # noqa: BLE001 — bloqueio que surgiu no meio: fica para a próxima
            continue
        apagadas += 1
        if r["ator"] is not None:
            await conn.execute(
                """
                INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, actor_type, metadata)
                VALUES ($1, $2, 'version_delete', 'document', $3, $4, 'system', $5::jsonb)
                """,
                r["ator"], r["company_id"], r["document_id"], r["name"],
                json.dumps({"versao": int(r["version_number"]), "motivo": f"política: versões antigas guardadas por {r['versions_keep_days']} dias"}),
            )
        ainda = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM public.document_versions WHERE storage_key = $1)", r["storage_key"])
        if not ainda:
            for key in (r["storage_key"], storage_service.derivative_pdf_key(r["storage_key"]),
                        storage_service.ocr_pdf_key(r["storage_key"]), storage_service.thumb_key(r["storage_key"])):
                try:
                    await asyncio.to_thread(storage_service.delete_object, key)
                except Exception:  # noqa: BLE001 — melhor esforço; o órfão é recolhido pela varredura do R2
                    pass
    if apagadas:
        logger.info("Versões antigas apagadas pela política da empresa: %d", apagadas)
    return apagadas
