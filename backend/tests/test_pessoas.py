"""
Pessoas e acessos (achados A9-10, A9-16, A9-17, A9-18, A9-37 e X2-13 da
avaliação de 25/11/2026).
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, outra = str(uuid.uuid4()), str(uuid.uuid4())
    gestora, func, externo = (str(uuid.uuid4()) for _ in range(3))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Pessoas'), ($2, 'Outra Pessoas')", co, outra)
    for uid, nome in ((gestora, "Gestora Pessoas"), (func, "Funcionário Pessoas"), (externo, "Externo Pessoas")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute(
            "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"p_{uid[:6]}", nome,
        )
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin'), ($3, $2, 'visualizador')",
        gestora, co, func,
    )
    # O externo também acessa outra empresa que a gestora não administra.
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'operador'), ($1, $3, 'operador')",
        externo, co, outra,
    )
    grupo = await admin.fetchval("INSERT INTO public.\"group\" (company_id, name) VALUES ($1, 'Fiscal') RETURNING id", co)
    await admin.execute("INSERT INTO public.group_member (group_id, user_id) VALUES ($1, $2)", grupo, func)
    await admin.execute(
        "INSERT INTO public.group_access (group_id, company_id, permission_level) VALUES ($1, $2, 'operador')", grupo, co,
    )
    yield {"co": co, "outra": outra, "gestora": gestora, "func": func, "externo": externo}
    for c in (co, outra):
        await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", c)
        await admin.execute("DELETE FROM public.companies WHERE id = $1", c)
    for uid in (gestora, func, externo):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_pessoas_mostram_acesso_por_grupo_e_papel_troca_no_lugar(api, admin, cenario):  # noqa: F811
    h, co = _token(cenario["gestora"]), cenario["co"]
    r = await api.get(API + f"/companies/{co}/people", headers=h)
    assert r.status_code == 200, r.text
    func = next(p for p in r.json() if p["user_id"] == cenario["func"])
    assert [g["role"] for g in func["grants"]] == ["visualizador"]
    assert [(g["group_name"], g["role"]) for g in func["via_groups"]] == [("Fiscal", "operador")]
    externo = next(p for p in r.json() if p["user_id"] == cenario["externo"])
    assert externo["company_count"] == 2

    # Trocar o papel no mesmo lugar; repetir a concessão dá 409 com explicação.
    access_id = func["grants"][0]["access_id"]
    r = await api.patch(API + f"/companies/{co}/access/{access_id}", json={"permission_level": "operador"}, headers=h)
    assert r.status_code == 200, r.text
    r = await api.post(API + f"/companies/{co}/members/{cenario['func']}/access", json={"permission_level": "admin"}, headers=h)
    assert r.status_code == 409

    # A única admin não perde o papel.
    gestora = next(p for p in (await api.get(API + f"/companies/{co}/people", headers=h)).json() if p["user_id"] == cenario["gestora"])
    r = await api.patch(API + f"/companies/{co}/access/{gestora['grants'][0]['access_id']}", json={"permission_level": "operador"}, headers=h)
    assert r.status_code == 409

    # Com acesso pelo grupo, a última concessão direta pode sair.
    r = await api.delete(API + f"/companies/{co}/access/{access_id}", headers=h)
    assert r.status_code == 204, r.text

    acoes = [a["action"] for a in await admin.fetch(
        "SELECT action FROM public.activity_log WHERE company_id = $1 AND item_type = 'access' ORDER BY created_at", uuid.UUID(co),
    )]
    assert acoes == ["access_role_change", "access_revoke"]


@pytest.mark.asyncio
async def test_desativar_reativar_e_limites(api, admin, cenario):  # noqa: F811
    h, co = _token(cenario["gestora"]), cenario["co"]
    hf = _token(cenario["func"])
    assert (await api.get(API + "/auth/me", headers=hf)).status_code == 200

    r = await api.post(API + f"/companies/{co}/members/{cenario['func']}/deactivate", headers=h)
    assert r.status_code == 200, r.text
    assert (await api.get(API + "/auth/me", headers=hf)).status_code == 403
    pessoas = (await api.get(API + f"/companies/{co}/people", headers=h)).json()
    assert next(p for p in pessoas if p["user_id"] == cenario["func"])["is_active"] is False

    assert (await api.post(API + f"/companies/{co}/members/{cenario['func']}/activate", headers=h)).status_code == 200
    assert (await api.get(API + "/auth/me", headers=hf)).status_code == 200

    # Quem também está em empresa que a gestora não administra: ela não desativa a conta.
    r = await api.post(API + f"/companies/{co}/members/{cenario['externo']}/deactivate", headers=h)
    assert r.status_code == 403
    # A si mesma também não.
    assert (await api.post(API + f"/companies/{co}/members/{cenario['gestora']}/deactivate", headers=h)).status_code == 422
    # Operador não administra.
    assert (await api.get(API + f"/companies/{co}/people", headers=_token(cenario["externo"]))).status_code == 403

    # Remover da empresa tira também dos grupos dela.
    assert (await api.delete(API + f"/companies/{co}/members/{cenario['func']}", headers=h)).status_code == 204
    assert await admin.fetchval("SELECT count(*) FROM public.group_member WHERE user_id = $1", uuid.UUID(cenario["func"])) == 0


@pytest.mark.asyncio
async def test_cnpj_com_digito_errado_e_recusado(api, cenario):  # noqa: F811
    h, co = _token(cenario["gestora"]), cenario["co"]
    r = await api.patch(API + f"/companies/{co}", json={"cnpj": "12.345.678/0001-99"}, headers=h)
    assert r.status_code == 422
    r = await api.patch(API + f"/companies/{co}", json={"cnpj": "11.222.333/0001-81"}, headers=h)
    assert r.status_code == 200, r.text
