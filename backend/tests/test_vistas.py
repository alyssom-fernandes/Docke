"""Vistas salvas por pasta (B1.2.7)."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, outra, adm, func, estranho = (str(uuid.uuid4()) for _ in range(5))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Vista'), ($2, 'Outra Vista')", co, outra)
    for uid, nome in ((adm, "Admin Vista"), (func, "Func Vista"), (estranho, "Estranho Vista")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"v_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $3, 'admin', NULL), ($2, $3, 'visualizador', NULL), ($4, $5, 'admin', NULL)",
        adm, func, co, estranho, outra)
    pasta = str(await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'RH', 'rh') RETURNING id", co))
    yield {"co": co, "adm": adm, "func": func, "estranho": estranho, "pasta": pasta}
    await admin.execute("DELETE FROM public.companies WHERE id = ANY($1::uuid[])", [co, outra])
    for uid in (adm, func, estranho):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_vistas_compartilhadas_e_pessoais(api, cenario):  # noqa: F811
    base = API + f"/companies/{cenario['co']}/views"
    cfg = {"sort": {"key": "field:x", "dir": "asc"}, "groupBy": "kind"}
    r = await api.post(base, json={"name": "Por tipo", "folder_id": cenario["pasta"], "config": cfg}, headers=_token(cenario["func"]))
    assert r.status_code == 201, r.text
    compartilhada = r.json()["id"]
    r = await api.post(base, json={"name": "Minha", "shared": False, "config": cfg}, headers=_token(cenario["func"]))
    assert r.status_code == 201
    # Quem é de fora não vê nem cria.
    assert (await api.get(base, headers=_token(cenario["estranho"]))).status_code == 404

    do_admin = (await api.get(base, params={"folder_id": cenario["pasta"]}, headers=_token(cenario["adm"]))).json()
    assert [v["name"] for v in do_admin] == ["Por tipo"] and do_admin[0]["config"]["groupBy"] == "kind"
    do_func = (await api.get(base, params={"folder_id": cenario["pasta"]}, headers=_token(cenario["func"]))).json()
    assert {v["name"] for v in do_func} == {"Por tipo", "Minha"}
    # Em outra pasta (raiz), só a de "todas as pastas".
    assert [v["name"] for v in (await api.get(base, headers=_token(cenario["func"]))).json()] == ["Minha"]

    # Apaga quem criou ou o admin; o estranho não.
    assert (await api.delete(API + f"/views/{compartilhada}", headers=_token(cenario["estranho"]))).status_code == 403
    assert (await api.delete(API + f"/views/{compartilhada}", headers=_token(cenario["adm"]))).status_code == 204
