"""Revisão periódica de acessos (A9-21, FA-A9-05, B3.1.7, B3.7.8)."""
import uuid
from datetime import date, timedelta

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, adm, op = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Revisão')", co)
    for uid, nome in ((adm, "Admin Revisão"), (op, "Operador Revisão")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"rv_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $3, 'admin'), ($2, $3, 'operador')",
        adm, op, co,
    )
    yield {"co": co, "adm": adm, "op": op}
    await admin.execute("DELETE FROM public.notifications WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.access_reviews WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (adm, op):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_campanha_de_revisao_decide_conclui_e_repete(api, admin, cenario):  # noqa: F811
    h, co = _token(cenario["adm"]), cenario["co"]
    prazo = (date.today() + timedelta(days=10)).isoformat()
    # Operador não abre revisão; responsável precisa administrar a empresa.
    r = await api.post(API + f"/companies/{co}/access-reviews", headers=_token(cenario["op"]),
                       json={"title": "Trimestral", "reviewer_id": cenario["adm"], "due_date": prazo})
    assert r.status_code == 403
    r = await api.post(API + f"/companies/{co}/access-reviews", headers=h,
                       json={"title": "Trimestral", "reviewer_id": cenario["op"], "due_date": prazo})
    assert r.status_code == 422

    r = await api.post(API + f"/companies/{co}/access-reviews", headers=h,
                       json={"title": "Trimestral", "reviewer_id": cenario["adm"], "due_date": prazo, "repeat_months": 3})
    assert r.status_code == 201, r.text
    rid = r.json()["id"]
    det = (await api.get(API + f"/access-reviews/{rid}", headers=h)).json()
    itens = {i["person_name"]: i for i in det["items"]}
    assert set(itens) == {"Admin Revisão", "Operador Revisão"}
    assert itens["Operador Revisão"]["snapshot"][0]["papel"] == "operador"
    aviso = await admin.fetchval("SELECT count(*) FROM public.notifications WHERE type = 'access_review' AND user_id = $1", uuid.UUID(cenario["adm"]))
    assert aviso == 1

    url = API + f"/access-reviews/{rid}/items/{itens['Operador Revisão']['id']}"
    assert (await api.post(url, json={"decision": "retirar"}, headers=h)).status_code == 422
    r = await api.post(url, json={"decision": "retirar", "note": "Saiu da equipe em outubro"}, headers=h)
    assert r.json() == {"faltam": 1, "concluida": False, "proxima": None}
    r = await api.post(API + f"/access-reviews/{rid}/items/{itens['Admin Revisão']['id']}", json={"decision": "manter"}, headers=h)
    assert r.json()["concluida"] is True and r.json()["proxima"]

    csv = await api.get(API + f"/access-reviews/{rid}/evidence.csv", headers=h)
    assert csv.status_code == 200 and "Saiu da equipe em outubro" in csv.text and "retirar" in csv.text
    lista = (await api.get(API + f"/companies/{co}/access-reviews", headers=h)).json()
    assert [(x["closed_at"] is None, x["decididos"]) for x in lista] == [(True, 0), (False, 2)]
