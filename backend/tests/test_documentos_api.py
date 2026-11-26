"""
Pastas e documentos pela API (achados A4-12, A4-26, A4-40, A4-61 e X2-13 da
avaliação de 25/11/2026): nomes de pasta validados na criação, renomear e mover
geram evento na trilha, a lista de documentos é paginada e não mostra envios
incompletos, e a restauração em lote desfaz uma exclusão.
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def empresa(admin: asyncpg.Connection):
    co, user = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Docs API')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user, f"{user[:8]}@test.local")
    await admin.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Admin Docs', 'usuario')",
        user, f"docs_{user[:6]}",
    )
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')",
        user, co,
    )
    yield {"co": co, "user": user}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    await admin.execute("DELETE FROM public.users WHERE id = $1", user)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", user)


@pytest.mark.asyncio
async def test_pasta_com_nome_duplicado_ou_invalido_e_recusada(api, empresa):  # noqa: F811
    h = _token(empresa["user"])
    r = await api.post(API + "/folders", json={"name": "  Fiscal  ", "company_id": empresa["co"]}, headers=h)
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "Fiscal"
    r = await api.post(API + "/folders", json={"name": "fiscal", "company_id": empresa["co"]}, headers=h)
    assert r.status_code == 409
    r = await api.post(API + "/folders", json={"name": "Notas: 2026", "company_id": empresa["co"]}, headers=h)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_renomear_pasta_e_documento_entram_na_trilha(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    pasta = (await api.post(API + "/folders", json={"name": "Contratos", "company_id": empresa["co"]}, headers=h)).json()
    outra = (await api.post(API + "/folders", json={"name": "RH", "company_id": empresa["co"]}, headers=h)).json()
    assert (await api.patch(API + f"/folders/{pasta['id']}/rename", json={"name": "RH"}, headers=h)).status_code == 409
    r = await api.patch(API + f"/folders/{pasta['id']}/rename", json={"name": "Contratos 2026"}, headers=h)
    assert r.status_code == 200, r.text

    doc = str(uuid.uuid4())
    await admin.execute(
        """
        INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                      storage_path, content_hash, ocr_status, uploaded_by)
        VALUES ($1, $2, $3, 'Contrato.pdf', 'application/pdf', 'pdf', 10, 'x', $4, 'done', $5)
        """,
        doc, empresa["co"], outra["id"], uuid.uuid4().hex * 2, empresa["user"],
    )
    r = await api.patch(API + f"/documents/{doc}", json={"name": "Contrato assinado.pdf"}, headers=h)
    assert r.status_code == 200, r.text

    eventos = await admin.fetch(
        "SELECT item_type, metadata->>'de' AS de, metadata->>'para' AS para FROM public.activity_log"
        " WHERE company_id = $1 AND action = 'rename' ORDER BY created_at",
        empresa["co"],
    )
    assert [(e["item_type"], e["de"], e["para"]) for e in eventos] == [
        ("folder", "Contratos", "Contratos 2026"),
        ("document", "Contrato.pdf", "Contrato assinado.pdf"),
    ]


@pytest.mark.asyncio
async def test_lista_paginada_sem_envios_incompletos_e_restauracao_em_lote(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    pasta = (await api.post(API + "/folders", json={"name": "Fiscal", "company_id": empresa["co"]}, headers=h)).json()
    ids = []
    for i in range(7):
        did = str(uuid.uuid4())
        ids.append(did)
        await admin.execute(
            """
            INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                          storage_path, content_hash, ocr_status, uploaded_by)
            VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, 'x', $5, 'done', $6)
            """,
            did, empresa["co"], pasta["id"], f"NF {i}.pdf", uuid.uuid4().hex * 2, empresa["user"],
        )
    # Envio incompleto (sem hash): não aparece.
    await admin.execute(
        """
        INSERT INTO public.documents (company_id, folder_id, name, mime_type, file_type, size_bytes, storage_path, uploaded_by)
        VALUES ($1, $2, 'Pela metade.pdf', 'application/pdf', 'pdf', 10, 'y', $3)
        """,
        empresa["co"], pasta["id"], empresa["user"],
    )
    params = {"folder_id": pasta["id"], "company_id": empresa["co"], "limit": 3, "offset": 3, "sort": "name"}
    r = await api.get(API + "/documents", params=params, headers=h)
    assert r.status_code == 200
    assert r.headers["X-Total-Count"] == "7"
    assert [d["name"] for d in r.json()] == ["NF 3.pdf", "NF 4.pdf", "NF 5.pdf"]
    r = await api.get(API + "/documents", params={**params, "q": "nf 6", "offset": 0}, headers=h)
    assert [d["name"] for d in r.json()] == ["NF 6.pdf"]

    r = await api.post(API + "/documents/bulk-delete", json={"document_ids": ids[:4]}, headers=h)
    assert r.status_code == 200 and r.json()["deleted"] == 4
    r = await api.post(API + "/documents/bulk-restore", json={"document_ids": ids[:4]}, headers=h)
    assert r.status_code == 200 and r.json()["restored"] == 4
    assert await admin.fetchval(
        "SELECT count(*) FROM public.documents WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", ids
    ) == 7
