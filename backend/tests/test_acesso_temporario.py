"""
Acesso temporário por pessoa (B3.1.8) e buscas salvas (B2.1.5).
"""
import uuid
from datetime import date, timedelta

import asyncpg
import pytest
import pytest_asyncio

from app.services import access_expiry
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, adm, auditor = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Prazo')", co)
    for uid, nome in ((adm, "Admin Prazo"), (auditor, "Auditor Prazo")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"t_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $3, 'admin', NULL), ($2, $3, 'visualizador', 'fiscal')",
        adm, auditor, co,
    )
    await admin.execute("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Fiscal', 'fiscal')", co)
    yield {"co": co, "adm": adm, "auditor": auditor}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (adm, auditor):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_acesso_com_prazo_sai_sozinho(api, admin, cenario):  # noqa: F811
    co, h = cenario["co"], _token(cenario["adm"])
    url = API + f"/companies/{co}/members/{cenario['auditor']}/access"
    ontem = (date.today() - timedelta(days=1)).isoformat()
    r = await api.post(url, json={"permission_level": "visualizador", "expires_on": ontem}, headers=h)
    assert r.status_code == 422

    r = await api.post(url, json={"permission_level": "visualizador", "expires_on": date.today().isoformat()}, headers=h)
    assert r.status_code == 201, r.text
    pessoas = await api.get(API + f"/companies/{co}/people", headers=h)
    aud = next(p for p in pessoas.json() if p["user_id"] == cenario["auditor"])
    temporario = next(g for g in aud["grants"] if g["expires_at"])
    assert len(aud["grants"]) == 2

    # Vencido: o worker retira e registra na trilha como ação do sistema.
    await admin.execute("UPDATE public.user_company_access SET expires_at = now() - interval '1 minute' WHERE id = $1",
                        uuid.UUID(temporario["access_id"]))
    assert await access_expiry.expirar(admin) >= 1
    restantes = await admin.fetch("SELECT folder_path::text FROM public.user_company_access WHERE user_id = $1 AND company_id = $2",
                                  uuid.UUID(cenario["auditor"]), uuid.UUID(co))
    assert [r["folder_path"] for r in restantes] == ["fiscal"]
    log = await admin.fetchrow(
        "SELECT actor_type, metadata->>'motivo' AS motivo FROM public.activity_log WHERE company_id = $1 AND action = 'access_revoke'",
        uuid.UUID(co))
    assert log["actor_type"] == "system" and "prazo" in log["motivo"]


@pytest.mark.asyncio
async def test_buscas_salvas_sao_de_cada_pessoa(api, cenario):  # noqa: F811
    co = cenario["co"]
    h1, h2 = _token(cenario["adm"]), _token(cenario["auditor"])
    r = await api.post(API + "/search/saved", json={"company_id": co, "name": "Notas 2026", "query": "q=nota&periodo=ano"}, headers=h1)
    assert r.status_code == 201, r.text
    # Mesmo nome atualiza a consulta em vez de duplicar.
    r = await api.post(API + "/search/saved", json={"company_id": co, "name": "Notas 2026", "query": "?q=nota&tipo=pdf"}, headers=h1)
    lista = (await api.get(API + "/search/saved", params={"company_id": co}, headers=h1)).json()
    assert [(x["name"], x["query"]) for x in lista] == [("Notas 2026", "q=nota&tipo=pdf")]
    assert (await api.get(API + "/search/saved", params={"company_id": co}, headers=h2)).json() == []
    # Outra pessoa não apaga; a dona apaga.
    await api.delete(API + f"/search/saved/{lista[0]['id']}", headers=h2)
    assert len((await api.get(API + "/search/saved", params={"company_id": co}, headers=h1)).json()) == 1
    assert (await api.delete(API + f"/search/saved/{lista[0]['id']}", headers=h1)).status_code == 204
    assert (await api.get(API + "/search/saved", params={"company_id": co}, headers=h1)).json() == []
    # Empresa que a pessoa não acessa: recusado.
    r = await api.post(API + "/search/saved", json={"company_id": str(uuid.uuid4()), "name": "X", "query": "q=x"}, headers=h1)
    assert r.status_code == 403
