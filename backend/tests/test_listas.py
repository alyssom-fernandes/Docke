"""
Busca e listas (achados A6-03, A6-04, A6-06, A6-12, A6-16, A6-17, A6-31 da
avaliação de 25/11/2026).
"""
import datetime
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def empresa(admin: asyncpg.Connection):
    co, user = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Listas')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user, f"{user[:8]}@test.local")
    await admin.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Pessoa Listas', 'usuario')",
        user, f"lst_{user[:6]}",
    )
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", user, co,
    )
    raiz, sub = str(uuid.uuid4()), str(uuid.uuid4())
    lr = "l" + uuid.uuid4().hex[:10]
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, path, name, created_by) VALUES ($1, $2, $3::ltree, 'Fiscal', $4)",
        raiz, co, lr, user,
    )
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, parent_id, path, name, created_by) VALUES ($1, $2, $3, $4::ltree, 'Notas', $5)",
        sub, co, raiz, lr + ".n" + uuid.uuid4().hex[:8], user,
    )
    yield {"co": co, "user": user, "raiz": raiz, "sub": sub}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.shares WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    await admin.execute("DELETE FROM public.users WHERE id = $1", user)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", user)


async def _doc(admin, e, folder, nome, texto, created_at=None, ocr="done"):
    doc = str(uuid.uuid4())
    await admin.execute(
        """
        INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                      storage_path, content_hash, ocr_status, ocr_text, uploaded_by, created_at)
        VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, 'x', $5, $6, $7, $8, COALESCE($9, now()))
        """,
        doc, e["co"], folder, nome, uuid.uuid4().hex * 2, ocr, texto, e["user"], created_at,
    )
    return doc


@pytest.mark.asyncio
async def test_busca_acha_cnpj_com_ou_sem_pontuacao_e_filtra(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    a = await _doc(admin, empresa, empresa["sub"], "Contrato fornecedor.pdf", "CNPJ 12.345.678/0001-90 contratante",
                   datetime.datetime(2026, 2, 1, tzinfo=datetime.timezone.utc))
    b = await _doc(admin, empresa, empresa["raiz"], "Guia.pdf", "cnpj 12345678000190 guia de recolhimento",
                   datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc))
    await _doc(admin, empresa, empresa["raiz"], "Escaneado.pdf", None, ocr="failed")

    for termo in ("12345678000190", "12.345.678/0001-90"):
        r = await api.get(API + "/search", params={"q": termo, "company_id": co}, headers=h)
        assert r.status_code == 200, r.text
        assert {x["id"] for x in r.json()["results"]} == {a, b}, termo
    assert r.json()["sem_texto"] == 1

    # Pasta com subpastas, pasta exata, período e ordenação.
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "folder_id": empresa["raiz"]}, headers=h)
    assert {x["id"] for x in r.json()["results"]} == {a, b}
    assert next(x for x in r.json()["results"] if x["id"] == a)["folder_path_label"] == "Fiscal / Notas"
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "folder_id": empresa["raiz"], "subfolders": "false"}, headers=h)
    assert [x["id"] for x in r.json()["results"]] == [b]
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "date_from": "2026-05-01"}, headers=h)
    assert [x["id"] for x in r.json()["results"]] == [b]
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "sort": "antigos"}, headers=h)
    assert [x["id"] for x in r.json()["results"]] == [a, b]
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "page_size": 1, "page": 2, "sort": "antigos"}, headers=h)
    assert (r.json()["total"], [x["id"] for x in r.json()["results"]]) == (2, [b])


@pytest.mark.asyncio
async def test_lixeira_ancorados_e_links_dizem_onde_quando_e_quem(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    d = await _doc(admin, empresa, empresa["sub"], "Recibo.pdf", "recibo")
    assert (await api.post(API + "/favorites", json={"document_id": d}, headers=h)).status_code in (200, 201)
    favs = (await api.get(API + "/favorites", params={"company_id": co}, headers=h)).json()
    assert favs[0]["location"] == "Fiscal / Notas"

    r = await api.post(API + "/shares", json={"resource_type": "document", "resource_id": d, "always_latest": True}, headers=h)
    assert r.status_code == 201, r.text
    share_id = r.json()["id"]
    await admin.execute("INSERT INTO public.share_accesses (share_id, success, user_agent) VALUES ($1, true, 'Firefox')", uuid.UUID(share_id))
    lista = (await api.get(API + "/shares", params={"company_id": co}, headers=h)).json()
    assert lista[0]["created_by_name"] == "Pessoa Listas"
    acessos = (await api.get(API + f"/shares/{share_id}/accesses", headers=h)).json()
    assert [(x["success"], x["user_agent"]) for x in acessos] == [(True, "Firefox")]
    # Linha do tempo do documento: acessos de todos os links dele (A5-25).
    por_doc = (await api.get(API + "/shares/by-resource/accesses", params={"resource_type": "document", "resource_id": d}, headers=h)).json()
    assert [(x["share_id"], x["user_agent"]) for x in por_doc] == [(share_id, "Firefox")]

    assert (await api.delete(API + f"/documents/{d}", headers=h)).status_code in (200, 204)
    itens = (await api.get(API + "/trash", params={"company_id": co}, headers=h)).json()
    item = next(x for x in (itens["documents"] if isinstance(itens, dict) else itens) if x["id"] == d)
    assert item["trash_expires_at"] is not None
    assert item["original_path"] == "Fiscal / Notas"
    assert item["deleted_by_name"] == "Pessoa Listas"


@pytest.mark.asyncio
async def test_notificacao_traz_pasta_do_documento_e_lixeira(api, admin, empresa):  # noqa: F811
    """A2-26: a notificação leva ao item (pasta do documento; lixeira se excluído)."""
    h, co = _token(empresa["user"]), empresa["co"]
    doc = await _doc(admin, empresa, empresa["sub"], "Aviso.pdf", "texto")
    for alvo, tipo in ((doc, "document"), (empresa["raiz"], "folder")):
        await admin.execute(
            "INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message) "
            "VALUES ($1, $2, 'version_added', $3, $4, 'teste')",
            empresa["user"], co, tipo, alvo,
        )
    try:
        r = await api.get(API + "/notifications", headers=h)
        assert r.status_code == 200, r.text
        por_id = {x["resource_id"]: x for x in r.json()["results"]}
        assert por_id[doc]["folder_id"] == empresa["sub"]
        assert por_id[doc]["company_id"] == co
        assert por_id[doc]["in_trash"] is False
        assert por_id[empresa["raiz"]]["folder_id"] is None
    finally:
        await admin.execute("DELETE FROM public.notifications WHERE user_id = $1", empresa["user"])


@pytest.mark.asyncio
async def test_busca_rapida_aceita_apostrofo_aspas_e_hifen(api, admin, empresa):  # noqa: F811
    """X3-06: termos com apóstrofo, aspas ou hífen solto não derrubam a busca rápida."""
    h, co = _token(empresa["user"]), empresa["co"]
    await _doc(admin, empresa, empresa["raiz"], "Conta d'água março.pdf", "conta de agua")
    for termo in ("d'água", '"', "-", "a-", "nf-e", "'", "conta d'"):
        r = await api.get(API + "/search/quick", params={"q": termo, "company_id": co}, headers=h)
        assert r.status_code == 200, (termo, r.text)
    r = await api.get(API + "/search/quick", params={"q": "d'água", "company_id": co}, headers=h)
    assert any("água" in x["name"] for x in r.json())
