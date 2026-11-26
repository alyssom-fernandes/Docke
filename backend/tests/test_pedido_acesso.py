"""Pedido de acesso dentro do Docke (B3.1.6)."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, outra, adm, func, estranho = (str(uuid.uuid4()) for _ in range(5))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Pedido'), ($2, 'Outra Pedido')", co, outra)
    for uid, nome in ((adm, "Admin Pedido"), (func, "Func Pedido"), (estranho, "Estranho Pedido")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"q_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $3, 'admin', NULL), ($2, $3, 'visualizador', 'fiscal'), ($4, $5, 'admin', NULL)",
        adm, func, co, estranho, outra)
    await admin.execute("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Fiscal', 'fiscal')", co)
    rh = str(await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'RH', 'rh') RETURNING id", co))
    yield {"co": co, "adm": adm, "func": func, "estranho": estranho, "rh": rh}
    await admin.execute("DELETE FROM public.notifications WHERE company_id = ANY($1::uuid[])", [co, outra])
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = ANY($1::uuid[])", [co, outra])
    await admin.execute("DELETE FROM public.companies WHERE id = ANY($1::uuid[])", [co, outra])
    for uid in (adm, func, estranho):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_pedir_e_aprovar_acesso(api, admin, cenario):  # noqa: F811
    url = API + "/companies/access-requests"
    # Quem não é da empresa não descobre a pasta.
    assert (await api.post(url, json={"folder_id": cenario["rh"]}, headers=_token(cenario["estranho"]))).status_code == 404
    r = await api.post(url, json={"folder_id": cenario["rh"], "message": "Preciso dos holerites"}, headers=_token(cenario["func"]))
    assert r.status_code == 201, r.text
    assert (await api.post(url, json={"folder_id": cenario["rh"]}, headers=_token(cenario["func"]))).status_code == 409
    aviso = await admin.fetchval("SELECT message FROM public.notifications WHERE user_id = $1 AND type = 'access_request'", uuid.UUID(cenario["adm"]))
    assert "Func Pedido" in aviso and "RH" in aviso

    lista = await api.get(API + f"/companies/{cenario['co']}/access-requests", headers=_token(cenario["adm"]))
    assert lista.status_code == 200 and lista.json()[0]["requester_name"] == "Func Pedido"
    assert (await api.get(API + f"/companies/{cenario['co']}/access-requests", headers=_token(cenario["func"]))).status_code == 403

    pid = lista.json()[0]["id"]
    assert (await api.post(url + f"/{pid}/decide", json={"aprovar": True}, headers=_token(cenario["func"]))).status_code == 403
    r = await api.post(url + f"/{pid}/decide", json={"aprovar": True, "permission_level": "operador"}, headers=_token(cenario["adm"]))
    assert r.status_code == 200, r.text
    papel = await admin.fetchval("SELECT public.user_has_access($1, 'rh'::ltree, $2)", uuid.UUID(cenario["func"]), uuid.UUID(cenario["co"]))
    assert papel == "operador"
    assert await admin.fetchval("SELECT count(*) FROM public.notifications WHERE user_id = $1 AND type = 'access_request_decided'", uuid.UUID(cenario["func"])) == 1
    # Já respondido; e agora já acessa.
    assert (await api.post(url + f"/{pid}/decide", json={"aprovar": False}, headers=_token(cenario["adm"]))).status_code == 409
    assert (await api.post(url, json={"folder_id": cenario["rh"]}, headers=_token(cenario["func"]))).status_code == 409
