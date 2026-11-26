"""
Mantém a máquina da API ligada enquanto há trabalho em segundo plano.

A API roda na Fly com auto_stop: sem requisições por alguns minutos, a máquina
para — e leva junto o OCR de um PDF longo ou uma exportação no meio (achado
X3-09 da avaliação de 25/11/2026). O proxy da Fly só enxerga tráfego HTTP,
então, enquanto houver trabalho (um bloco `busy()` aberto ou fila de OCR ou de
exportação pendente), a própria API chama o endereço público dela a cada 45 s.
Sem fila, ela volta a desligar sozinha, como antes.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import contextmanager

import httpx

logger = logging.getLogger("docke.busy")
_busy = 0
_INTERVAL_SECS = 45


@contextmanager
def busy():
    global _busy
    _busy += 1
    try:
        yield
    finally:
        _busy -= 1


def _self_url() -> str | None:
    url = os.environ.get("DOCKE_SELF_PING_URL")
    if url:
        return url
    app = os.environ.get("FLY_APP_NAME")  # a Fly define em toda máquina
    return f"https://{app}.fly.dev/health" if app else None


async def _queue_pending() -> bool:
    from app.dependencies import _admin_pool

    if _admin_pool is None:
        return False
    try:
        return bool(await _admin_pool.fetchval(
            """
            SELECT EXISTS (SELECT 1 FROM public.ocr_jobs WHERE status IN ('pending', 'processing'))
                OR EXISTS (SELECT 1 FROM public.company_exports WHERE status IN ('pending', 'processing'))
            """
        ))
    except Exception:
        return False


async def keepalive_loop() -> None:
    url = _self_url()
    if not url:
        return  # fora da Fly (local, CI): nada a manter ligado
    async with httpx.AsyncClient(timeout=10.0) as client:
        while True:
            try:
                await asyncio.sleep(_INTERVAL_SECS)
                if _busy > 0 or await _queue_pending():
                    await client.get(url)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.debug("Ping de manter ligado falhou.", exc_info=True)
