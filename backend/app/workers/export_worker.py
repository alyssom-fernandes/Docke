"""
Worker das exportações completas (tabela company_exports, ver
app/services/export_service.py). Um pedido por vez, com SKIP LOCKED.
Na partida, pedidos que estavam em 'processing' (o processo caiu no meio)
voltam para a fila.
"""
import asyncio
import json
import logging

from app.services import storage_service
from app.services.busy import busy
from app.services.export_service import EXPORT_TTL_DAYS, build_and_upload, gather

logger = logging.getLogger("docke.export_worker")
_POLL_INTERVAL = 15


async def export_worker_loop() -> None:
    from app.dependencies import _admin_pool

    if _admin_pool is not None:
        await _admin_pool.execute("UPDATE public.company_exports SET status = 'pending' WHERE status = 'processing'")
    while True:
        try:
            if not await _process_one():
                await asyncio.sleep(_POLL_INTERVAL)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Erro inesperado no worker de exportação.")
            await asyncio.sleep(_POLL_INTERVAL)


async def _process_one() -> bool:
    from app.dependencies import _admin_pool

    if _admin_pool is None:
        return False
    async with _admin_pool.acquire() as conn:
        async with conn.transaction():
            job = await conn.fetchrow(
                """
                SELECT id, company_id FROM public.company_exports
                WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
                """
            )
            if job is None:
                return False
            await conn.execute(
                "UPDATE public.company_exports SET status = 'processing', started_at = now() WHERE id = $1", job["id"]
            )
        data = await gather(conn, job["company_id"])

    with busy():
        try:
            result = await asyncio.to_thread(
                build_and_upload,
                data,
                read_object=storage_service.read_object,
                upload=lambda key, path: storage_service.upload_file(key, path, "application/zip"),
                key_prefix=f"exports/{job['company_id']}/{job['id']}",
            )
        except Exception as exc:
            logger.exception("Exportação %s falhou.", job["id"])
            await _admin_pool.execute(
                "UPDATE public.company_exports SET status = 'failed', finished_at = now(), error_message = $2 WHERE id = $1",
                job["id"], f"Não foi possível montar a exportação: {type(exc).__name__}.",
            )
            return True

    await _admin_pool.execute(
        """
        UPDATE public.company_exports
        SET status = 'done', finished_at = now(), parts = $2::jsonb, document_count = $3,
            total_bytes = $4, hash_mismatches = $5, expires_at = now() + ($6 || ' days')::interval
        WHERE id = $1
        """,
        job["id"], json.dumps(result["parts"]), result["document_count"], result["total_bytes"],
        result["hash_mismatches"], str(EXPORT_TTL_DAYS),
    )
    logger.info(
        "Exportação %s pronta: %d documento(s), %d parte(s), %d divergência(s) de hash.",
        job["id"], result["document_count"], len(result["parts"]), result["hash_mismatches"],
    )
    return True


async def purge_expired_exports(conn) -> None:
    """Chamado pela manutenção: apaga do storage as exportações vencidas."""
    rows = await conn.fetch(
        "SELECT id, parts FROM public.company_exports WHERE status = 'done' AND expires_at < now()"
    )
    for row in rows:
        parts = row["parts"] if isinstance(row["parts"], list) else json.loads(row["parts"] or "[]")
        for part in parts:
            try:
                storage_service.delete_object(part["key"])
            except Exception:
                pass
        await conn.execute(
            "UPDATE public.company_exports SET status = 'failed', error_message = 'Expirada: gere uma nova.', parts = '[]'::jsonb WHERE id = $1",
            row["id"],
        )
