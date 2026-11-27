"""Grupo como fonte de acesso (A9-37): o administrador geral põe qualquer conta; o admin da empresa só quem já é dela."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, sup, adm, fora = (str(uuid.uuid4()) for _ in range(4))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Grupo')", co)
    for uid, nome, papel in ((sup, "Supremo Grupo", "supremo"), (adm, "Admin Grupo", "usuario"), (fora, "Fora Grupo", "usuario")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, $4)", uid, f"g_{uid[:6]}", nome, papel)
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $2, 'admin', NULL)", adm, co)
    grupo = str(await admin.fetchval('INSERT INTO public."group" (company_id, name) VALUES ($1, \'Frentistas\') RETURNING id', co))
    yield {"co": co, "sup": sup, "adm": adm, "fora": fora, "grupo": grupo}
    await admin.execute("DELETE FROM public.companies WHERE id = $1", uuid.UUID(co))
    for uid in (sup, adm, fora):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_por_conta_no_grupo(api, cenario):  # noqa: F811
    url = API + f"/companies/{cenario['co']}/groups/{cenario['grupo']}/members"
    corpo = {"user_id": cenario["fora"]}
    assert (await api.post(url, json=corpo, headers=_token(cenario["adm"]))).status_code == 404
    r = await api.post(url, json=corpo, headers=_token(cenario["sup"]))
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_supremo_da_acesso_direto_em_outra_empresa(api, cenario):  # noqa: F811
    """A9-27: a conta nova já entra em outras empresas; o admin da empresa não descobre contas de fora."""
    url = API + f"/companies/{cenario['co']}/members/{cenario['fora']}/access"
    corpo = {"permission_level": "visualizador", "folder_id": None}
    assert (await api.post(url, json=corpo, headers=_token(cenario["adm"]))).status_code == 404
    r = await api.post(url, json=corpo, headers=_token(cenario["sup"]))
    assert r.status_code == 201, r.text
