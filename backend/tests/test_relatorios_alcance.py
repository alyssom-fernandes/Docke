"""
Relatórios prontos na Atividade (FA-A6-07), links na trilha (B3.2.8 em parte),
calendário das obrigações (B3.5.10) e busca reversa de acesso (FA-A9-07).
"""
import uuid
from datetime import date, timedelta

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, adm, func = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Relatórios')", co)
    for uid, nome in ((adm, "Admin Rel"), (func, "Func Rel")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"r_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $3, 'admin', NULL), ($2, $3, 'operador', 'rh')",
        adm, func, co,
    )
    await admin.execute(
        "INSERT INTO public.folders (company_id, name, path, sensitivity) VALUES ($1, 'RH', 'rh', 'pessoal'), ($1, 'Fiscal', 'fiscal', 'normal')", co)
    await admin.execute("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Holerites', 'rh.holerites')", co)
    pasta = str(await admin.fetchval("SELECT id FROM public.folders WHERE company_id = $1 AND path = 'fiscal'", co))
    tpl = await admin.fetchval(
        """
        INSERT INTO public.obligation_templates (company_id, name, frequency, criticality, sla_days)
        VALUES ($1, 'Guia do FGTS', 'mensal', 'alta', 3) RETURNING id
        """, co)
    await admin.execute(
        "INSERT INTO public.obligation_instances (template_id, company_id, period, due_date) VALUES ($1, $2, '2026-12', $3)",
        tpl, co, date.today() + timedelta(days=10))
    yield {"co": co, "adm": adm, "func": func, "pasta": pasta}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.shares WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (adm, func):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_link_na_trilha_e_relatorio_por_varias_acoes(api, cenario):  # noqa: F811
    co, h = cenario["co"], _token(cenario["adm"])
    r = await api.post(API + "/shares", json={"resource_type": "folder", "resource_id": cenario["pasta"], "expires_in": "7d"}, headers=h)
    assert r.status_code == 201, r.text
    assert (await api.delete(API + f"/shares/{r.json()['id']}", headers=h)).status_code == 204
    r = await api.get(API + "/activity", params={"company_id": co, "action": "share_create,share_revoke"}, headers=h)
    assert r.status_code == 200, r.text
    acoes = sorted(e["action"] for e in r.json()["results"])
    assert acoes == ["share_create", "share_revoke"]
    assert all(e["item_name_snapshot"] == "Fiscal" for e in r.json()["results"])


@pytest.mark.asyncio
async def test_calendario_ics_e_csv(api, cenario):  # noqa: F811
    h = _token(cenario["adm"])
    r = await api.get(API + "/obligations/calendar", params={"company_id": cenario["co"]}, headers=h)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/calendar")
    corpo = r.text
    assert "BEGIN:VCALENDAR" in corpo and "SUMMARY:Guia do FGTS" in corpo and "TRIGGER:-P3D" in corpo
    r = await api.get(API + "/obligations/calendar", params={"company_id": cenario["co"], "formato": "csv"}, headers=h)
    assert r.status_code == 200 and "Guia do FGTS" in r.text and "Vencimento" in r.text


@pytest.mark.asyncio
async def test_o_que_a_pessoa_acessa(api, cenario):  # noqa: F811
    co = cenario["co"]
    r = await api.get(API + f"/companies/{co}/people/{cenario['func']}/reach", headers=_token(cenario["adm"]))
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["company_role"] is None and d["total_folders"] == 3
    assert {(f["name"], f["role"]) for f in d["folders"]} == {("RH", "operador"), ("Holerites", "operador")}
    assert d["sensitive_count"] == 2
    # Quem não administra a empresa não vê o alcance dos outros.
    assert (await api.get(API + f"/companies/{co}/people/{cenario['adm']}/reach", headers=_token(cenario["func"]))).status_code == 403
