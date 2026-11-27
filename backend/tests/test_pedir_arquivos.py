"""
Pedir arquivos a terceiros (FA-A4-11, B3.5.8): link de envio para uma pasta,
sem conta, com a mesma conferência do envio normal e aviso a quem pediu.
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from app.services import storage_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, oper, leitor = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Pedidos')", co)
    for uid, nome in ((oper, "Operador Pedidos"), (leitor, "Leitor Pedidos")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"p_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $3, 'operador'), ($2, $3, 'visualizador')",
        oper, leitor, co,
    )
    pasta = str(await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Contabilidade', 'contabilidade') RETURNING id", co))
    yield {"co": co, "oper": oper, "leitor": leitor, "pasta": pasta}
    await admin.execute("DELETE FROM public.notifications WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.upload_requests WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.ocr_jobs WHERE document_id IN (SELECT id FROM public.documents WHERE company_id = $1)", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (oper, leitor):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


async def _enviar(api, admin, token, nome, conteudo, quem="Contador Silva", senha=None):  # noqa: F811
    r = await api.post(API + f"/r/{token}/upload-url", json={
        "name": nome, "size_bytes": len(conteudo), "content_type": "application/pdf", "sender_name": quem, "password": senha})
    if r.status_code != 201:
        return r
    doc = r.json()["document_id"]
    chave = await admin.fetchval("SELECT storage_path FROM public.documents WHERE id = $1", uuid.UUID(doc))
    storage_service.mock_save(chave, conteudo)
    return await api.post(API + f"/r/{token}/confirm", json={"document_id": doc, "password": senha})


@pytest.mark.asyncio
async def test_pedido_recebe_arquivo_e_avisa_quem_pediu(api, admin, cenario):  # noqa: F811
    co, pasta = cenario["co"], cenario["pasta"]
    # Só quem pode enviar na pasta cria o pedido.
    r = await api.post(API + "/upload-requests", json={"company_id": co, "folder_id": pasta, "title": "Notas de novembro"},
                       headers=_token(cenario["leitor"]))
    assert r.status_code == 403
    r = await api.post(API + "/upload-requests", json={"company_id": co, "folder_id": pasta, "title": "Notas de novembro", "max_files": 2},
                       headers=_token(cenario["oper"]))
    assert r.status_code == 201, r.text
    token = r.json()["token"]

    info = await api.get(API + f"/r/{token}/info")
    assert info.status_code == 200 and info.json()["folder_name"] == "Contabilidade" and info.json()["requires_password"] is False

    r = await _enviar(api, admin, token, "nota-novembro.pdf", PDF)
    assert r.status_code == 200, r.text
    doc = await admin.fetchrow("SELECT folder_id::text, content_hash FROM public.documents WHERE company_id = $1 AND name = 'nota-novembro.pdf'", uuid.UUID(co))
    assert doc["folder_id"] == pasta and doc["content_hash"]
    aviso = await admin.fetchval("SELECT message FROM public.notifications WHERE company_id = $1 AND type = 'upload_request_received'", uuid.UUID(co))
    assert "Contador Silva" in aviso and "nota-novembro.pdf" in aviso

    # O mesmo conteúdo de novo: recusado sem revelar o nome do que já existe.
    r = await _enviar(api, admin, token, "outra-coisa.pdf", PDF)
    assert r.status_code == 409 and "nota-novembro" not in r.json()["detail"]

    # Tipo não aceito.
    r = await api.post(API + f"/r/{token}/upload-url", json={"name": "programa.exe", "size_bytes": 10, "sender_name": "X"})
    assert r.status_code == 422

    # Lista do pedido para quem vê a pasta.
    lista = await api.get(API + "/upload-requests", params={"company_id": co, "folder_id": pasta}, headers=_token(cenario["leitor"]))
    assert lista.status_code == 200 and lista.json()[0]["received"] == 1 and lista.json()[0]["status"] == "aberto"
    recebidos = await api.get(API + f"/upload-requests/{lista.json()[0]['id']}/files", headers=_token(cenario["oper"]))
    assert [x["sender_name"] for x in recebidos.json()] == ["Contador Silva"]

    # Limite de arquivos.
    assert (await _enviar(api, admin, token, "b.pdf", PDF + b"b")).status_code == 200
    r = await api.post(API + f"/r/{token}/upload-url", json={"name": "c.pdf", "size_bytes": 10, "sender_name": "X"})
    assert r.status_code == 409

    # Encerrado: o link deixa de valer.
    assert (await api.post(API + f"/upload-requests/{lista.json()[0]['id']}/revoke", headers=_token(cenario["leitor"]))).status_code == 403
    assert (await api.post(API + f"/upload-requests/{lista.json()[0]['id']}/revoke", headers=_token(cenario["oper"]))).status_code == 200
    assert (await api.get(API + f"/r/{token}/info")).status_code == 410


@pytest.mark.asyncio
async def test_pedido_com_senha(api, admin, cenario):  # noqa: F811
    r = await api.post(API + "/upload-requests", json={
        "company_id": cenario["co"], "folder_id": cenario["pasta"], "title": "Holerites", "password": "segredo123"},
        headers=_token(cenario["oper"]))
    assert r.status_code == 201, r.text
    token = r.json()["token"]
    assert (await api.get(API + f"/r/{token}/info")).json()["requires_password"] is True
    r = await _enviar(api, admin, token, "holerite.pdf", PDF + b"h", senha="errada")
    assert r.status_code == 401
    r = await _enviar(api, admin, token, "holerite.pdf", PDF + b"h", senha="segredo123")
    assert r.status_code == 200, r.text
    assert (await api.get(API + "/r/token-que-nao-existe/info")).status_code == 404


@pytest.mark.asyncio
async def test_pedido_da_obrigacao_vincula_o_arquivo(api, admin, cenario):  # noqa: F811
    """A7-55, B3.5.8: o arquivo que chega pelo pedido já comprova a competência e vai para conferência."""
    co, pasta = cenario["co"], cenario["pasta"]
    modelo = await admin.fetchval(
        "INSERT INTO public.obligation_templates (company_id, name, frequency) VALUES ($1, 'Certidão negativa', 'unica') RETURNING id", co,
    )
    inst = await admin.fetchval(
        "INSERT INTO public.obligation_instances (template_id, company_id, period, due_date) VALUES ($1, $2, 'Vigente', current_date + 10) RETURNING id",
        modelo, co,
    )
    try:
        r = await api.post(API + "/upload-requests", headers=_token(cenario["oper"]), json={
            "company_id": co, "folder_id": pasta, "title": "Certidão", "obligation_instance_id": str(inst)})
        assert r.status_code == 201, r.text
        assert r.json()["obligation_instance_id"] == str(inst)
        # Competência de outra empresa não entra.
        r2 = await api.post(API + "/upload-requests", headers=_token(cenario["oper"]), json={
            "company_id": co, "folder_id": pasta, "title": "Errado", "obligation_instance_id": str(uuid.uuid4())})
        assert r2.status_code == 404

        r = await _enviar(api, admin, r.json()["token"], "Certidao.pdf", PDF + b"certidao")
        assert r.status_code == 200, r.text
        vinculos = await admin.fetchval("SELECT count(*) FROM public.obligation_documents WHERE obligation_instance_id = $1", inst)
        assert vinculos == 1
        assert await admin.fetchval("SELECT status FROM public.obligation_instances WHERE id = $1", inst) == "reviewing"
    finally:
        await admin.execute("DELETE FROM public.obligation_documents WHERE obligation_instance_id = $1", inst)
        await admin.execute("DELETE FROM public.obligation_templates WHERE id = $1", modelo)
