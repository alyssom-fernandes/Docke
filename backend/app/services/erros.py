"""
Rastreio de erros no Sentry (X3-11; decisão do dono 26/11: Sentry no plano
grátis). Sem o SDK: monta o evento e manda pela API de "store" do Sentry com
httpx, em segundo plano, sem atrasar a resposta. Sem SENTRY_DSN, não faz nada.

O que vai: tipo e mensagem do erro, a pilha (arquivos do app e linhas), a
rota e o método, a versão publicada e o ambiente. O que NÃO vai: corpo da
requisição, cabeçalhos, cookies, token, e-mail ou IP (LGPD; send_default_pii
desligado na prática). O usuário vai só como o id interno, para agrupar.
"""
import asyncio
import logging
import os
import time
import traceback
import uuid
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import settings

logger = logging.getLogger("docke.erros")
_ultimos: dict[str, float] = {}  # evita enviar o mesmo erro em rajada (1 por minuto por assinatura)


def _dsn() -> tuple[str, str] | None:
    if not settings.SENTRY_DSN:
        return None
    u = urlparse(settings.SENTRY_DSN)
    projeto = u.path.strip("/")
    if not (u.username and projeto):
        return None
    return f"{u.scheme}://{u.hostname}/api/{projeto}/store/", u.username


def _quadros(exc: BaseException) -> list[dict[str, Any]]:
    out = []
    for fs in traceback.extract_tb(exc.__traceback__)[-30:]:
        app = "/app/" in fs.filename.replace("\\", "/")
        out.append({"filename": os.path.basename(fs.filename), "abs_path": fs.filename if app else os.path.basename(fs.filename),
                    "function": fs.name, "lineno": fs.lineno, "in_app": app, "context_line": (fs.line or "")[:200] if app else None})
    return out


def montar_evento(exc: BaseException | None, *, mensagem: str | None = None, rota: str | None = None, metodo: str | None = None,
                  user_id: str | None = None, origem: str = "api", extra: dict[str, Any] | None = None) -> dict[str, Any]:
    evento: dict[str, Any] = {
        "event_id": uuid.uuid4().hex, "timestamp": time.time(), "platform": "python" if origem == "api" else "javascript",
        "level": "error", "logger": f"docke.{origem}", "environment": os.environ.get("FLY_APP_NAME", "local"),
        "release": os.environ.get("FLY_IMAGE_REF", "")[-40:] or None, "server_name": None,
        "tags": {"origem": origem, **({"rota": rota} if rota else {}), **({"metodo": metodo} if metodo else {})},
        "extra": extra or {},
    }
    if user_id:
        evento["user"] = {"id": user_id}
    if exc is not None:
        evento["exception"] = {"values": [{"type": type(exc).__name__, "value": str(exc)[:500], "stacktrace": {"frames": _quadros(exc)}}]}
    else:
        evento["message"] = (mensagem or "")[:1000]
    if rota:
        evento["transaction"] = f"{metodo or ''} {rota}".strip()
    return evento


async def _enviar(evento: dict[str, Any]) -> None:
    alvo = _dsn()
    if alvo is None:
        return
    url, chave = alvo
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            await c.post(url, json=evento, headers={"X-Sentry-Auth": f"Sentry sentry_version=7, sentry_client=docke/1.0, sentry_key={chave}"})
    except Exception as e:  # o rastreio nunca derruba nada
        logger.info("Sentry indisponível: %s", e)


def relatar(evento: dict[str, Any]) -> None:
    """Agenda o envio sem esperar. Mesmo erro (tipo + rota + última linha) no máximo 1 vez por minuto."""
    if _dsn() is None:
        return
    exc = (evento.get("exception") or {}).get("values", [{}])[0]
    quadro = (exc.get("stacktrace") or {}).get("frames", [{}])[-1:] or [{}]
    assinatura = f"{exc.get('type')}|{evento.get('transaction')}|{quadro[0].get('filename')}:{quadro[0].get('lineno')}|{evento.get('message', '')[:80]}"
    agora = time.time()
    if _ultimos.get(assinatura, 0) > agora - 60:
        return
    _ultimos[assinatura] = agora
    try:
        asyncio.get_running_loop().create_task(_enviar(evento))
    except RuntimeError:
        pass


class HandlerSentry(logging.Handler):
    """logger.exception(...) do app e dos workers vira evento no Sentry."""

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)

    def emit(self, record: logging.LogRecord) -> None:
        if record.name.startswith("docke.erros") or not (record.name.startswith("app") or record.name.startswith("docke")):
            return
        exc = record.exc_info[1] if record.exc_info else None
        relatar(montar_evento(exc, mensagem=record.getMessage()[:500], origem="worker" if "worker" in record.name else "api",
                              extra={"logger": record.name}))
