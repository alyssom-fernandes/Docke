"""Ranking com sinais de uso (B2.1.4): o que a pessoa ancorou ou abriu sobe na busca."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, uid = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Ranking')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Ranking', 'usuario')", uid, f"k_{uid[:6]}")
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", uid, co)
    pasta = await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Contratos', 'contratos') RETURNING id", co)
    docs = []
    for i in range(3):
        docs.append(str(await admin.fetchval(
            """
            INSERT INTO public.documents (company_id, folder_id, name, storage_path, mime_type, file_type, size_bytes, content_hash, uploaded_by)
            VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, $5, $6) RETURNING id
            """, co, pasta, f"Contrato de aluguel {i}.pdf", f"x/{co}/{i}", f"rk-{co}-{i}", uid)))
    yield {"co": co, "uid": uid, "docs": docs}
    await admin.execute("DELETE FROM public.favorites WHERE user_id = $1", uid)
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_ancorado_sobe_na_relevancia(api, admin, cenario):  # noqa: F811
    h = _token(cenario["uid"])
    antes = await api.get(API + "/search", params={"q": "contrato aluguel", "company_id": cenario["co"]}, headers=h)
    assert antes.status_code == 200, antes.text
    ultimo = antes.json()["results"][-1]["id"]
    await admin.execute("INSERT INTO public.favorites (user_id, document_id) VALUES ($1, $2)", uuid.UUID(cenario["uid"]), uuid.UUID(ultimo))
    depois = await api.get(API + "/search", params={"q": "contrato aluguel", "company_id": cenario["co"]}, headers=h)
    assert depois.json()["results"][0]["id"] == ultimo
    assert depois.json()["results"][0]["usado_por_mim"] is True
