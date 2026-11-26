"""
Worker das miniaturas (A4-20, A5-42): a cada 30 s gera as que faltam, poucas
por vez, sem disputar com o OCR. Documentos novos primeiro; os antigos entram
aos poucos.
"""
import asyncio
import logging

logger = logging.getLogger("docke.miniaturas")

_INTERVALO = 30


async def thumbnail_worker_loop() -> None:
    from app.services.busy import busy
    from app.services.heartbeat import beat
    from app.services.nfe_service import processar_pendentes as ler_nfes
    from app.services.thumbnail_service import generate_pending

    while True:
        beat("miniaturas")
        feitos = 0
        notas = 0
        try:
            from app.dependencies import _admin_pool
            if _admin_pool is not None:
                async with _admin_pool.acquire() as conn:
                    with busy():
                        feitos = await generate_pending(conn)
                        # XML de NF-e recém-enviado: lê a chave e o cabeçalho da nota.
                        notas = await ler_nfes(conn)
                if notas:
                    logger.info("XMLs de NF-e lidos: %d", notas)
                if feitos:
                    logger.info("Miniaturas geradas: %d", feitos)
                    await asyncio.sleep(2)  # ainda pode haver fila: segue logo
                    continue
        except asyncio.CancelledError:
            logger.info("Worker de miniaturas cancelado.")
            break
        except Exception as exc:
            logger.exception("Erro no worker de miniaturas: %s", exc)
        await asyncio.sleep(_INTERVALO)
