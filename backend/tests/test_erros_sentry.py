"""Rastreio de erros (X3-11): o evento leva a pilha, nunca dado pessoal; sem DSN, nada sai."""
from unittest.mock import patch

import pytest

from app.services import erros
from tests.test_admin_scope import api  # noqa: F401 — fixture reaproveitada


def test_evento_sem_dado_pessoal():
    try:
        raise ValueError("falhou ao ler")
    except ValueError as e:
        ev = erros.montar_evento(e, rota="/api/v1/documents/{document_id}", metodo="GET", user_id="u-1")
    valor = ev["exception"]["values"][0]
    assert valor["type"] == "ValueError" and valor["stacktrace"]["frames"]
    assert ev["user"] == {"id": "u-1"} and ev["transaction"] == "GET /api/v1/documents/{document_id}"
    texto = str(ev)
    assert "Authorization" not in texto and "@" not in texto


def test_dsn_e_limite_de_rajada():
    with patch.object(erros.settings, "SENTRY_DSN", ""):
        assert erros._dsn() is None
    with patch.object(erros.settings, "SENTRY_DSN", "https://chave123@o1.ingest.sentry.io/456"):
        assert erros._dsn() == ("https://o1.ingest.sentry.io/api/456/store/", "chave123")


@pytest.mark.asyncio
async def test_erro_do_navegador_aceito(api):  # noqa: F811
    r = await api.post("/api/v1/client-errors", json={"message": "TypeError: x is undefined", "path": "/documents?pasta=1"})
    assert r.status_code == 204
