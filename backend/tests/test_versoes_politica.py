"""Retenção do histórico de versões por política da empresa (B1.4.9)."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from app.workers.maintenance_worker import _purge_old_versions
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, chefe, adm = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Versões')", co)
    for uid, papel in ((chefe, "supremo"), (adm, "usuario")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Versões', $3)", uid, f"v_{uid[:6]}", papel)
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", adm, co)
    pasta = await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Contratos', 'contratos') RETURNING id", co)
    doc = await admin.fetchval(
        """
        INSERT INTO public.documents (company_id, folder_id, name, storage_path, mime_type, file_type, size_bytes, content_hash, uploaded_by)
        VALUES ($1, $2, 'contrato.pdf', $3, 'application/pdf', 'pdf', 10, $4, $5) RETURNING id
        """, co, pasta, f"x/{co}/v3", f"vp-{co}", adm)
    ids = []
    for n, dias in ((1, 400), (2, 200), (3, 10)):
        ids.append(await admin.fetchval(
            """
            INSERT INTO public.document_versions (document_id, version_number, storage_key, size_bytes, mime_type, uploaded_by, created_at)
            VALUES ($1, $2, $3, 10, 'application/pdf', $4, now() - make_interval(days => $5)) RETURNING id
            """, doc, n, f"x/{co}/v{n}", adm, dias))
    await admin.execute("UPDATE public.documents SET current_version_id = $2 WHERE id = $1", doc, ids[2])
    yield {"co": co, "chefe": chefe, "adm": adm, "doc": doc, "versoes": ids}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (chefe, adm):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_politica_de_versoes(api, admin, cenario):  # noqa: F811
    co = cenario["co"]
    url = API + f"/companies/{co}/versions-policy"
    assert (await api.put(url, json={"keep_days": 180}, headers=_token(cenario["adm"]))).status_code == 403
    assert (await api.put(url, json={"keep_days": 5}, headers=_token(cenario["chefe"]))).status_code == 422

    # Sem prazo definido, nada sai.
    await _purge_old_versions(admin)
    assert await admin.fetchval("SELECT count(*) FROM public.document_versions WHERE document_id = $1", cenario["doc"]) == 3

    r = await api.put(url, json={"keep_days": 180}, headers=_token(cenario["chefe"]))
    assert r.status_code == 200, r.text
    await _purge_old_versions(admin)
    # A v1 foi substituída pela v2 há 200 dias (> 180): sai. A v2 foi substituída há 10 dias: fica. A atual nunca sai.
    restantes = [r["version_number"] for r in await admin.fetch(
        "SELECT version_number FROM public.document_versions WHERE document_id = $1 ORDER BY version_number", cenario["doc"])]
    assert restantes == [2, 3]
    log = await admin.fetchrow("SELECT actor_type, metadata->>'versao' AS v FROM public.activity_log WHERE company_id = $1 AND action = 'version_delete'", uuid.UUID(co))
    assert log["actor_type"] == "system" and log["v"] == "1"
