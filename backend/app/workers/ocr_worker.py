"""
Worker de OCR com SKIP LOCKED — processa jobs da tabela ocr_jobs.

Fluxo por job:
  1. SELECT FOR UPDATE SKIP LOCKED → lock sem bloquear outros workers
  2. UPDATE status='processing', attempts+=1  → commit rápido libera lock
  3. Lê arquivo do storage
  4. OCRProvider.extract() → texto limpo
  5. Transação atômica (R3/I3):
       UPDATE documents SET ocr_text, ocr_status='done'
       UPDATE ocr_jobs  SET status='done', finished_at
  6. Erro → UPDATE ocr_jobs SET status='failed', error_message

Retry e jobs travados (M3.3):
  - Ao iniciar o loop: jobs em 'processing' há >10min → volta para 'pending' (ou 'failed' se attempts>=3)
  - POST /documents/:id/retry-ocr: cria novo job em 'pending' (M3.3)
"""
import asyncio
import logging
from datetime import datetime, timezone

from app.config import settings
from app.services import storage_service
from app.services.ocr_service import get_provider

logger = logging.getLogger("docke.ocr_worker")

# Intervalo entre polls quando não há jobs (segundos)
_POLL_INTERVAL = 10

# Tempo máximo em 'processing' antes de considerar travado (M3.3)
_MAX_PROCESSING_SECS = 600  # 10 minutos

# Máximo de tentativas antes de marcar como failed
_MAX_ATTEMPTS = 3


async def ocr_worker_loop() -> None:
    """
    Loop principal do worker. Iniciado como background task no lifespan.
    Usa a pool de admin (service_role) — jobs são processos do sistema, não de usuário.
    """
    # Aguarda pool estar pronta (lifespan garante init_db_pool antes)
    provider = get_provider()
    logger.info("OCR worker iniciado. Provedor: %s", type(provider).__name__)

    while True:
        try:
            processed = await _process_one_job(provider)
            if not processed:
                await asyncio.sleep(_POLL_INTERVAL)
        except asyncio.CancelledError:
            logger.info("OCR worker cancelado.")
            break
        except Exception as exc:
            logger.exception("Erro inesperado no loop do OCR worker: %s", exc)
            await asyncio.sleep(_POLL_INTERVAL)


async def _process_one_job(provider) -> bool:
    """
    Processa um job pendente. Retorna True se processou algo, False se não havia jobs.
    """
    from app.dependencies import _admin_pool

    if _admin_pool is None:
        return False

    async with _admin_pool.acquire() as conn:
        # Antes de pegar job: resgata jobs travados em 'processing'
        await _rescue_stuck_jobs(conn)

        # Pega o job mais antigo pendente com SKIP LOCKED
        async with conn.transaction():
            job = await conn.fetchrow(
                """
                SELECT j.id, j.document_id, j.attempts,
                       d.storage_path, d.mime_type, d.company_id
                FROM public.ocr_jobs j
                JOIN public.documents d ON d.id = j.document_id
                WHERE j.status = 'pending'
                ORDER BY j.created_at
                LIMIT 1
                FOR UPDATE OF j SKIP LOCKED
                """
            )
            if job is None:
                return False

            new_attempts = job["attempts"] + 1
            await conn.execute(
                """
                UPDATE public.ocr_jobs
                SET status = 'processing', started_at = now(), attempts = $2
                WHERE id = $1
                """,
                job["id"],
                new_attempts,
            )
        # Transação commitada — lock liberado

    # Lê arquivo do storage (fora de qualquer transação)
    file_bytes = storage_service.read_object(job["storage_path"])
    if file_bytes is None:
        await _mark_failed(job["id"], job["document_id"], "Arquivo não encontrado no storage.")
        return True

    # OCR
    try:
        text = await provider.extract(file_bytes, job["mime_type"] or "application/octet-stream")
    except Exception as exc:
        logger.exception("OCR falhou para doc %s: %s", job["document_id"], exc)
        text = ""
        if new_attempts >= _MAX_ATTEMPTS:
            await _mark_failed(job["id"], job["document_id"], str(exc))
            return True

    # Grava resultado em transação atômica (R3/I3: documents + ocr_jobs juntos)
    async with _admin_pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE public.documents
                SET ocr_text  = $2,
                    ocr_status = 'done',
                    updated_at = now()
                WHERE id = $1
                """,
                job["document_id"],
                text or "",
            )
            await conn.execute(
                """
                UPDATE public.ocr_jobs
                SET status = 'done', finished_at = now()
                WHERE id = $1
                """,
                job["id"],
            )

    logger.info(
        "OCR concluído — doc=%s chars=%d attempts=%d",
        job["document_id"], len(text or ""), new_attempts,
    )
    return True


async def _mark_failed(job_id, document_id, error_message: str) -> None:
    from app.dependencies import _admin_pool
    if _admin_pool is None:
        return
    async with _admin_pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE public.documents SET ocr_status = 'failed', updated_at = now()
                WHERE id = $1
                """,
                document_id,
            )
            await conn.execute(
                """
                UPDATE public.ocr_jobs
                SET status = 'failed', finished_at = now(), error_message = $2
                WHERE id = $1
                """,
                job_id,
                error_message,
            )
    logger.warning("OCR marcado como failed — job=%s doc=%s erro=%s", job_id, document_id, error_message)


async def _rescue_stuck_jobs(conn) -> None:
    """
    Jobs em 'processing' há mais de _MAX_PROCESSING_SECS:
    - Se attempts < _MAX_ATTEMPTS: volta para 'pending' (será tentado novamente)
    - Se attempts >= _MAX_ATTEMPTS: marca como 'failed'
    """
    await conn.execute(
        """
        UPDATE public.ocr_jobs
        SET status = CASE WHEN attempts < $1 THEN 'pending' ELSE 'failed' END,
            error_message = CASE WHEN attempts >= $1 THEN 'Timeout: job travado em processing.' ELSE error_message END
        WHERE status = 'processing'
          AND started_at < now() - ($2 || ' seconds')::interval
        """,
        _MAX_ATTEMPTS,
        str(_MAX_PROCESSING_SECS),
    )
