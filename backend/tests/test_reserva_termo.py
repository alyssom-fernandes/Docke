"""
Reserva para edição (B1.4.7), termo de confidencialidade no link público
(B3.2.5) e base legal/finalidade por pasta (B3.7.6).
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, adm, op1, op2 = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Reserva')", co)
    for uid, nome in ((adm, "Admin Reserva"), (op1, "Ana Reserva"), (op2, "Bruno Reserva")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"r_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $4, 'admin'), ($2, $4, 'operador'), ($3, $4, 'operador')",
        adm, op1, op2, co)
    pasta = await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Contratos', 'contratos') RETURNING id", co)
    doc = await admin.fetchval(
        """
        INSERT INTO public.documents (company_id, folder_id, name, storage_path, mime_type, file_type, size_bytes, content_hash, uploaded_by, ocr_status)
        VALUES ($1, $2, 'contrato.pdf', $3, 'application/pdf', 'pdf', 10, $4, $5, 'done') RETURNING id
        """, co, pasta, f"x/{co}/c", f"rs-{co}", adm)
    yield {"co": co, "adm": adm, "op1": op1, "op2": op2, "pasta": str(pasta), "doc": str(doc)}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.shares WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (adm, op1, op2):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_reserva_para_edicao(api, cenario):  # noqa: F811
    doc = cenario["doc"]
    h1, h2, ha = _token(cenario["op1"]), _token(cenario["op2"]), _token(cenario["adm"])
    r = await api.post(API + f"/documents/{doc}/checkout", json={}, headers=h1)
    assert r.status_code == 200, r.text
    assert r.json()["full_name"] == "Ana Reserva"
    # O outro operador não altera nem reserva; lê o detalhe com a reserva.
    r = await api.patch(API + f"/documents/{doc}", json={"name": "outro.pdf"}, headers=h2)
    assert r.status_code == 423 and r.json()["code"] == "em_edicao"
    assert (await api.post(API + f"/documents/{doc}/checkout", json={}, headers=h2)).status_code == 423
    assert (await api.get(API + f"/documents/{doc}", headers=h2)).json()["checkout"]["full_name"] == "Ana Reserva"
    # Quem reservou altera.
    assert (await api.patch(API + f"/documents/{doc}", json={"name": "contrato-v2.pdf"}, headers=h1)).status_code == 200
    # O outro operador não libera; o admin libera.
    assert (await api.post(API + f"/documents/{doc}/checkin", headers=h2)).status_code == 403
    assert (await api.post(API + f"/documents/{doc}/checkin", headers=ha)).status_code == 200
    assert (await api.patch(API + f"/documents/{doc}", json={"name": "contrato-v3.pdf"}, headers=h2)).status_code == 200


@pytest.mark.asyncio
async def test_link_com_termo_pede_nome_e_aceite(api, cenario):  # noqa: F811
    r = await api.post(API + "/shares", json={"resource_type": "folder", "resource_id": cenario["pasta"], "expires_in": "7d",
                                              "terms_text": "Uso só para a auditoria de 2026."}, headers=_token(cenario["adm"]))
    assert r.status_code == 201, r.text
    token, share_id = r.json()["token"], r.json()["id"]
    info = await api.get(API + f"/s/{token}/info")
    assert info.json()["terms_text"] == "Uso só para a auditoria de 2026."
    r = await api.post(API + f"/s/{token}/content", json={})
    assert r.status_code == 403 and r.json()["code"] == "termo_pendente"
    r = await api.post(API + f"/s/{token}/content", json={"visitor_name": "Carla Auditora", "accepted_terms": True})
    assert r.status_code == 200, r.text
    acessos = await api.get(API + f"/shares/{share_id}/accesses", headers=_token(cenario["adm"]))
    assert any(a.get("visitor_name") == "Carla Auditora" for a in acessos.json())


@pytest.mark.asyncio
async def test_base_legal_e_finalidade(api, cenario):  # noqa: F811
    h = _token(cenario["adm"])
    url = API + f"/folders/{cenario['pasta']}/privacy"
    r = await api.put(url, json={"sensitivity": "pessoal", "legal_basis": "Execução de contrato", "purpose": "Gestão de contratos de fornecedores"}, headers=h)
    assert r.status_code == 200, r.text
    r = await api.get(url, headers=h)
    assert r.json()["legal_basis"] == "Execução de contrato" and "Execução de contrato" in r.json()["bases_legais"]
    # Sem classificação, base e finalidade saem.
    r = await api.put(url, json={"sensitivity": "normal", "legal_basis": "Execução de contrato"}, headers=h)
    assert r.json()["legal_basis"] is None
