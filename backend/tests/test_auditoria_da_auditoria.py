"""Auditoria da auditoria (B3.3.8) e limpeza de avisos antigos (B4.4.7)."""
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_verificar_e_exportar_a_trilha_ficam_registrados(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    assert (await api.get(API + "/activity/verify-integrity", params={"company_id": co}, headers=h)).status_code == 200
    r = await api.get(API + "/activity/export", params={"company_id": co}, headers=h)
    assert r.status_code == 200, r.text
    acoes = [x["action"] for x in await admin.fetch(
        "SELECT action FROM public.activity_log WHERE company_id = $1 AND action LIKE 'audit_%' ORDER BY created_at", uuid.UUID(co),
    )]
    assert acoes == ["audit_verify", "audit_export"]


@pytest.mark.asyncio
async def test_limpeza_tira_so_avisos_lidos_antigos(admin, empresa):  # noqa: F811
    from app.workers.maintenance_worker import _cleanup_old_notifications

    co, user = uuid.UUID(empresa["co"]), uuid.UUID(empresa["user"])
    ids = []
    for lido in ("now() - interval '120 days'", "now() - interval '10 days'", "NULL"):
        ids.append(await admin.fetchval(
            f"""
            INSERT INTO public.notifications (user_id, company_id, type, message, read_at, created_at)
            VALUES ($1, $2, 'folder_activity', 'teste', {lido}, now() - interval '200 days') RETURNING id
            """,
            user, co,
        ))
    await _cleanup_old_notifications(admin)
    restantes = {r["id"] for r in await admin.fetch("SELECT id FROM public.notifications WHERE id = ANY($1::uuid[])", ids)}
    assert restantes == {ids[1], ids[2]}
    await admin.execute("DELETE FROM public.notifications WHERE id = ANY($1::uuid[])", ids)
