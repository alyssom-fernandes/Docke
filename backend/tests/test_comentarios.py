"""Comentários e anotações: camada separada, permissões e busca (B2.4.6, B2.6.7)."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, adm, leitor, fiscal_only = (str(uuid.uuid4()) for _ in range(4))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Comentário')", co)
    for uid, nome in ((adm, "Admin Coment"), (leitor, "Leitor Coment"), (fiscal_only, "Fiscal Coment")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"c_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $4, 'admin', NULL), ($2, $4, 'visualizador', NULL), ($3, $4, 'visualizador', 'fis')",
        adm, leitor, fiscal_only, co)
    rh = await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'RH', 'rh') RETURNING id", co)
    await admin.execute("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Fiscal', 'fis')", co)
    doc = await admin.fetchval(
        """
        INSERT INTO public.documents (folder_id, company_id, name, mime_type, file_type, size_bytes, storage_path, content_hash, uploaded_by)
        VALUES ($1, $2, 'Contrato.pdf', 'application/pdf', 'pdf', 10, 'x/c.pdf', 'abc', $3) RETURNING id
        """,
        rh, co, uuid.UUID(adm))
    yield {"co": co, "adm": adm, "leitor": leitor, "fiscal": fiscal_only, "doc": str(doc)}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", uuid.UUID(co))
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", uuid.UUID(co))
    await admin.execute("DELETE FROM public.companies WHERE id = $1", uuid.UUID(co))
    for uid in (adm, leitor, fiscal_only):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_comentarios_anotacoes_e_busca(api, admin, cenario):  # noqa: F811
    url = API + f"/documents/{cenario['doc']}/comments"
    # Leitor comenta; anotação exige página com x e y.
    r = await api.post(url, json={"body": "Falta a assinatura da testemunha", "page": 2, "x": 0.4, "y": 0.8}, headers=_token(cenario["leitor"]))
    assert r.status_code == 201, r.text
    anot = r.json()["id"]
    assert (await api.post(url, json={"body": "x", "x": 0.4, "y": 0.5}, headers=_token(cenario["leitor"]))).status_code == 422
    assert (await api.post(url, json={"body": "Conferido pelo financeiro"}, headers=_token(cenario["adm"]))).status_code == 201
    # Quem não enxerga a pasta não vê nem comenta.
    assert (await api.get(url, headers=_token(cenario["fiscal"]))).status_code == 404
    assert (await api.post(url, json={"body": "oi"}, headers=_token(cenario["fiscal"]))).status_code == 404

    lista = (await api.get(url, headers=_token(cenario["adm"]))).json()
    assert [c["page"] for c in lista] == [None, 2] and lista[1]["x"] == pytest.approx(0.4)

    # Busca nos comentários: acha para quem enxerga, some para quem não enxerga.
    busca = API + f"/companies/{cenario['co']}/comments/search"
    achou = (await api.get(busca, params={"q": "testemunha"}, headers=_token(cenario["adm"]))).json()
    assert achou and achou[0]["document_name"] == "Contrato.pdf" and achou[0]["anotacao"] is True
    assert (await api.get(busca, params={"q": "testemunha"}, headers=_token(cenario["fiscal"]))).json() == []

    # Apagar: o autor ou o admin da pasta; outro leitor não.
    cid_adm = next(c["id"] for c in lista if c["page"] is None)
    assert (await api.delete(API + f"/comments/{cid_adm}", headers=_token(cenario["leitor"]))).status_code == 403
    assert (await api.patch(API + f"/comments/{anot}", json={"resolved": True}, headers=_token(cenario["adm"]))).status_code == 200
    assert (await api.delete(API + f"/comments/{anot}", headers=_token(cenario["adm"]))).status_code == 204
    assert await admin.fetchval("SELECT count(*) FROM public.activity_log WHERE action IN ('comment_added', 'annotation_added') AND company_id = $1",
                                uuid.UUID(cenario["co"])) == 2
