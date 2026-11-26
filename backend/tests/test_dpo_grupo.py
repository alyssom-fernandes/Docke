"""
Relatório para o encarregado de dados (B3.7.7) e visão de todas as pessoas
do grupo para o administrador geral (FA-A9-04).
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, chefe, adm, func = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto DPO')", co)
    for uid, nome, papel in ((chefe, "Chefe DPO", "supremo"), (adm, "Admin DPO", "usuario"), (func, "Func DPO", "usuario")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, $4)", uid, f"d_{uid[:6]}", nome, papel)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $3, 'admin', NULL), ($2, $3, 'visualizador', 'fiscal')",
        adm, func, co,
    )
    await admin.execute(
        "INSERT INTO public.folders (company_id, name, path, sensitivity) VALUES ($1, 'RH', 'rh', 'sensivel'), ($1, 'Fiscal', 'fiscal', 'normal')", co)
    yield {"co": co, "chefe": chefe, "adm": adm, "func": func}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (chefe, adm, func):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_relatorio_do_encarregado(api, admin, cenario):  # noqa: F811
    co = cenario["co"]
    assert (await api.get(API + f"/companies/{co}/privacy/report", headers=_token(cenario["func"]))).status_code == 403
    r = await api.get(API + f"/companies/{co}/privacy/report", headers=_token(cenario["adm"]))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("text/csv")
    linhas = r.text.lstrip("﻿").splitlines()
    # Só quem acessa a pasta sensível entra (o admin da empresa toda); quem só vê Fiscal, não.
    quem = [ln for ln in linhas if ln.startswith('"Quem acessa"')]
    assert any("Admin DPO" in ln and '"RH"' in ln for ln in quem) and not any("Func DPO" in ln for ln in quem)
    acoes = {a["action"] for a in await admin.fetch("SELECT action FROM public.activity_log WHERE company_id = $1", uuid.UUID(co))}
    assert "lgpd_report" in acoes


@pytest.mark.asyncio
async def test_pessoas_de_todas_as_empresas(api, cenario):  # noqa: F811
    assert (await api.get(API + "/admin/people", headers=_token(cenario["adm"]))).status_code == 403
    r = await api.get(API + "/admin/people", headers=_token(cenario["chefe"]))
    assert r.status_code == 200, r.text
    func = next(p for p in r.json() if p["user_id"] == cenario["func"])
    assert func["companies"] == [{"company_id": cenario["co"], "company_name": "Posto DPO", "role": "visualizador"}]
    assert func["mfa_enabled"] is False and func["is_active"] is True
