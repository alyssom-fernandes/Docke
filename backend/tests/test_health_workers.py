"""Batimento dos workers (achado X3-11): /health/workers diz se algum parou."""
import pytest

from app.services import heartbeat
from tests.test_admin_scope import api  # noqa: F401 — fixture reaproveitada


@pytest.mark.asyncio
async def test_health_workers_aponta_worker_atrasado(api, monkeypatch):  # noqa: F811
    heartbeat.beat("ocr")
    r = await api.get("/health/workers")
    assert r.status_code == 200
    assert r.json()["workers"]["ocr"]["estado"] == "ok"
    monkeypatch.setitem(heartbeat._ultimo, "ocr", 0.0)
    r = await api.get("/health/workers")
    assert r.json()["workers"]["ocr"]["estado"] == "atrasado"
    assert r.json()["status"] == "degradado"
