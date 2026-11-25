"""
Worker de OCR com SKIP LOCKED — processa jobs da tabela ocr_jobs.

Fluxo por job:
  1. SELECT FOR UPDATE SKIP LOCKED (só jobs sem espera pendente em next_retry_at)
  2. UPDATE status='processing', attempts+=1  → commit rápido libera lock
  3. Lê o arquivo do storage (numa thread, sem travar o event loop)
  4. Extrai o texto (app/services/ocr_service.py)
  5. Transação atômica (R3/I3): documents (texto, 'done', ocr_completed_at),
     a versão atual em document_versions e o job.

Falhas (achado X3-02 da avaliação de 25/11/2026): antes, um erro na 1ª ou 2ª
tentativa virava texto vazio com status 'done', e o documento sumia da busca
sem ninguém saber. Agora:
  - erro de leitura ou de extração: o job volta para 'pending' com espera
    crescente (30 s, 2 min) e, na 3ª tentativa, o documento fica 'failed' com
    o motivo — a interface mostra a falha e o botão de tentar de novo;
  - formato sem extração conhecida ou arquivo ausente: 'failed' na hora.

Jobs travados (M3.3): em 'processing' há mais de 10 min voltam para 'pending'
(ou 'failed' se já tiveram 3 tentativas).
"""
import asyncio
import logging

from app.services import storage_service
from app.services.busy import busy
from app.services.ocr_service import Extraction, UnsupportedFormat, get_provider, legacy_office_extension

logger = logging.getLogger("docke.ocr_worker")

_POLL_INTERVAL = 10
_MAX_PROCESSING_SECS = 900  # 15 min: PDF escaneado longo leva minutos no Tesseract
_MAX_ATTEMPTS = 3
_RETRY_DELAYS_SECS = (30, 120)


class _MissingFile(Exception):
    pass


async def ocr_worker_loop() -> None:
    """Loop principal. Iniciado como background task no lifespan; usa a pool de admin."""
    provider = get_provider()
    logger.info("OCR worker iniciado. Tesseract: %s", "sim" if provider.tesseract else "não (só texto nativo)")

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


async def extract_document_text(provider, storage_path: str, mime_type: str, *, max_ocr_pages: int | None = None) -> Extraction:
    """Lê o objeto do storage e extrai o texto. DOC/XLS passam pelo PDF derivado do LibreOffice."""
    kwargs = {} if max_ocr_pages is None else {"max_ocr_pages": max_ocr_pages}
    ext = legacy_office_extension(mime_type)
    if ext:
        derivative_key = storage_service.derivative_pdf_key(storage_path)
        pdf_bytes = await asyncio.to_thread(storage_service.read_object, derivative_key)
        if pdf_bytes is None:
            pdf_bytes = await asyncio.to_thread(storage_service.convert_office_to_pdf, storage_path, ext)
            if pdf_bytes is None:
                raise RuntimeError("Não foi possível converter o arquivo para leitura do texto.")
            await asyncio.to_thread(storage_service.put_object_bytes, derivative_key, pdf_bytes, "application/pdf")
        return await provider.extract(pdf_bytes, "application/pdf", **kwargs)

    file_bytes = await asyncio.to_thread(storage_service.read_object, storage_path)
    if file_bytes is None:
        raise _MissingFile("Arquivo não encontrado no armazenamento.")
    return await provider.extract(file_bytes, mime_type or "application/octet-stream", **kwargs)


async def _process_one_job(provider) -> bool:
    """Processa um job pendente. Retorna True se processou algo, False se não havia jobs."""
    from app.dependencies import _admin_pool

    if _admin_pool is None:
        return False

    async with _admin_pool.acquire() as conn:
        await _rescue_stuck_jobs(conn)

        async with conn.transaction():
            job = await conn.fetchrow(
                """
                SELECT j.id, j.document_id, j.attempts,
                       d.storage_path, d.mime_type, d.company_id
                FROM public.ocr_jobs j
                JOIN public.documents d ON d.id = j.document_id
                WHERE j.status = 'pending'
                  AND (j.next_retry_at IS NULL OR j.next_retry_at <= now())
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
                SET status = 'processing', started_at = now(), attempts = $2, next_retry_at = NULL
                WHERE id = $1
                """,
                job["id"],
                new_attempts,
            )
            await conn.execute(
                "UPDATE public.documents SET ocr_status = 'processing' WHERE id = $1 AND ocr_status = 'pending'",
                job["document_id"],
            )

    try:
        with busy():
            extraction = await extract_document_text(provider, job["storage_path"], job["mime_type"])
    except (UnsupportedFormat, _MissingFile) as exc:
        await _mark_failed(job["id"], job["document_id"], str(exc))
        return True
    except Exception as exc:
        logger.exception("Extração de texto falhou para doc %s (tentativa %d): %s", job["document_id"], new_attempts, exc)
        if new_attempts >= _MAX_ATTEMPTS:
            await _mark_failed(job["id"], job["document_id"], "Não foi possível ler o texto deste arquivo.")
        else:
            await _schedule_retry(job["id"], job["document_id"], new_attempts, str(exc))
        return True

    if extraction.searchable_pdf:
        try:
            await asyncio.to_thread(
                storage_service.put_object_bytes,
                storage_service.ocr_pdf_key(job["storage_path"]),
                extraction.searchable_pdf,
                "application/pdf",
            )
        except Exception:
            logger.warning("Não foi possível guardar o PDF pesquisável do doc %s.", job["document_id"])

    async with _admin_pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE public.documents
                SET ocr_text = $2, ocr_status = 'done', ocr_completed_at = now(), updated_at = now()
                WHERE id = $1
                """,
                job["document_id"],
                extraction.text,
            )
            # A versão atual (mesmo objeto no storage) guarda o próprio texto:
            # é o que a comparação de versões usa para PDF, DOCX e afins.
            await conn.execute(
                """
                UPDATE public.document_versions
                SET ocr_text = $3, ocr_status = 'done'
                WHERE document_id = $1 AND storage_key = $2
                """,
                job["document_id"],
                job["storage_path"],
                extraction.text,
            )
            await conn.execute(
                "UPDATE public.ocr_jobs SET status = 'done', finished_at = now(), error_message = NULL WHERE id = $1",
                job["id"],
            )

    logger.info(
        "Texto extraído — doc=%s chars=%d paginas_ocr=%d tentativa=%d",
        job["document_id"], len(extraction.text), extraction.ocr_pages, new_attempts,
    )
    return True


async def _schedule_retry(job_id, document_id, attempts: int, error_message: str) -> None:
    from app.dependencies import _admin_pool

    delay = _RETRY_DELAYS_SECS[min(attempts, len(_RETRY_DELAYS_SECS)) - 1]
    async with _admin_pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE public.ocr_jobs
                SET status = 'pending', next_retry_at = now() + ($2 || ' seconds')::interval, error_message = $3
                WHERE id = $1
                """,
                job_id,
                str(delay),
                error_message[:500],
            )
            await conn.execute(
                "UPDATE public.documents SET ocr_status = 'pending' WHERE id = $1 AND ocr_status = 'processing'",
                document_id,
            )
    logger.warning("OCR do doc %s volta à fila em %d s (tentativa %d de %d).", document_id, delay, attempts, _MAX_ATTEMPTS)


async def _mark_failed(job_id, document_id, error_message: str) -> None:
    from app.dependencies import _admin_pool
    if _admin_pool is None:
        return
    async with _admin_pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "UPDATE public.documents SET ocr_status = 'failed', updated_at = now() WHERE id = $1",
                document_id,
            )
            await conn.execute(
                """
                UPDATE public.ocr_jobs
                SET status = 'failed', finished_at = now(), error_message = $2
                WHERE id = $1
                """,
                job_id,
                error_message[:500],
            )
    logger.warning("OCR marcado como failed — job=%s doc=%s erro=%s", job_id, document_id, error_message)


async def _rescue_stuck_jobs(conn) -> None:
    """
    Jobs em 'processing' há mais de _MAX_PROCESSING_SECS (o processo caiu no meio):
    - attempts < _MAX_ATTEMPTS: voltam para 'pending';
    - senão: 'failed', e o documento também.
    """
    failed = await conn.fetch(
        """
        UPDATE public.ocr_jobs
        SET status = CASE WHEN attempts < $1 THEN 'pending' ELSE 'failed' END,
            error_message = CASE WHEN attempts >= $1 THEN 'A leitura do texto demorou demais e foi interrompida.' ELSE error_message END,
            finished_at = CASE WHEN attempts >= $1 THEN now() ELSE finished_at END
        WHERE status = 'processing'
          AND started_at < now() - ($2 || ' seconds')::interval
        RETURNING document_id, status
        """,
        _MAX_ATTEMPTS,
        str(_MAX_PROCESSING_SECS),
    )
    for row in failed:
        await conn.execute(
            "UPDATE public.documents SET ocr_status = $2 WHERE id = $1",
            row["document_id"], "failed" if row["status"] == "failed" else "pending",
        )
