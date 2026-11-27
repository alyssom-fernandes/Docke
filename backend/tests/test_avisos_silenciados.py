"""Preferências de avisos por pessoa (A8-12): silenciar só os de rotina."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def pessoa(admin: asyncpg.Connection):
    co, uid = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Avisos')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Pessoa Avisos', 'usuario')", uid, f"av_{uid[:6]}")
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", uid, co)
    yield {"co": co, "uid": uid}
    await admin.execute("DELETE FROM public.notifications WHERE user_id = $1", uid)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_silenciar_aviso_de_rotina(api, admin, pessoa):  # noqa: F811
    h = _token(pessoa["uid"])
    r = await api.get(API + "/notifications/preferences", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["muted"] == []

    # Segurança não se desliga.
    r = await api.put(API + "/notifications/preferences", json={"muted": ["security_incident"]}, headers=h)
    assert r.status_code == 422

    r = await api.put(API + "/notifications/preferences", json={"muted": ["folder_activity", "share_accessed"]}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["muted"] == ["folder_activity", "share_accessed"]

    sql = ("INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)"
           " VALUES ($1, $2, $3, 'folder', $2, 'teste')")
    await admin.execute(sql, uuid.UUID(pessoa["uid"]), uuid.UUID(pessoa["co"]), "folder_activity")
    await admin.execute(sql, uuid.UUID(pessoa["uid"]), uuid.UUID(pessoa["co"]), "obligation_overdue")
    tipos = {r["type"] for r in await admin.fetch("SELECT type FROM public.notifications WHERE user_id = $1", uuid.UUID(pessoa["uid"]))}
    assert tipos == {"obligation_overdue"}
