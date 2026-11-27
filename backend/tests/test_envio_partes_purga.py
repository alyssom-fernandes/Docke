"""
Envio em partes (multipart) de ponta a ponta e purga automática da lixeira
(achado X3-17: os dois caminhos não tinham teste dedicado).
"""
import hashlib
import uuid
from urllib.parse import urlparse

import pytest

from app.services import storage_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


def _so_mock():
    if not storage_service.is_mock():
        pytest.skip("precisa do storage simulado")


async def _abrir(api, h, empresa, nome):  # noqa: F811
    r = await api.post(API + "/documents/multipart/create", json={
        "folder_id": empresa["raiz"], "company_id": empresa["co"], "name": nome,
        "size_bytes": 25 * 1024 * 1024, "content_type": "application/pdf",
    }, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.asyncio
async def test_envio_em_partes_junta_na_ordem_e_confirma(api, admin, empresa):  # noqa: F811
    _so_mock()
    h = _token(empresa["user"])
    criado = await _abrir(api, h, empresa, f"Contrato grande {uuid.uuid4().hex[:6]}.pdf")
    assert criado["total_parts"] == 3
    doc_id = criado["document_id"]

    partes = [b"%PDF-1.4 parte um " + uuid.uuid4().hex.encode(), b" parte dois ", b" parte tres %%EOF"]
    etags = []
    # Envia fora de ordem: o storage junta pela numeração, não pela chegada.
    for numero in (2, 1, 3):
        r = await api.post(API + f"/documents/multipart/{doc_id}/part-url",
                           json={"upload_id": criado["upload_id"], "part_number": numero}, headers=h)
        assert r.status_code == 200, r.text
        caminho = urlparse(r.json()["upload_url"]).path
        r = await api.put(caminho, content=partes[numero - 1])
        assert r.status_code == 200, r.text
        etags.append({"part_number": numero, "etag": r.headers["ETag"]})

    r = await api.post(API + f"/documents/multipart/{doc_id}/complete",
                       json={"upload_id": criado["upload_id"], "parts": etags}, headers=h)
    assert r.status_code == 200, r.text

    linha = await admin.fetchrow(
        "SELECT content_hash, size_bytes, ocr_status FROM public.documents WHERE id = $1", uuid.UUID(doc_id))
    inteiro = b"".join(partes)
    assert linha["content_hash"] == hashlib.sha256(inteiro).hexdigest()
    assert linha["size_bytes"] == len(inteiro)  # tamanho real, não o declarado
    assert await admin.fetchval(
        "SELECT count(*) FROM public.ocr_jobs WHERE document_id = $1 AND status = 'pending'", uuid.UUID(doc_id)) == 1

    # Confirmar de novo não duplica.
    r = await api.post(API + f"/documents/multipart/{doc_id}/complete",
                       json={"upload_id": criado["upload_id"], "parts": etags}, headers=h)
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_envio_em_partes_cancelado_nao_deixa_documento(api, admin, empresa):  # noqa: F811
    _so_mock()
    h = _token(empresa["user"])
    criado = await _abrir(api, h, empresa, f"Abandonado {uuid.uuid4().hex[:6]}.pdf")
    r = await api.post(API + f"/documents/multipart/{criado['document_id']}/abort",
                       json={"upload_id": criado["upload_id"]}, headers=h)
    assert r.status_code == 204
    assert not await admin.fetchval(
        "SELECT EXISTS (SELECT 1 FROM public.documents WHERE id = $1)", uuid.UUID(criado["document_id"]))
    # Cancelar de novo é inofensivo.
    r = await api.post(API + f"/documents/multipart/{criado['document_id']}/abort",
                       json={"upload_id": criado["upload_id"]}, headers=h)
    assert r.status_code == 204


@pytest.mark.asyncio
async def test_purga_automatica_apaga_banco_e_arquivos_vencidos(admin, empresa):  # noqa: F811
    _so_mock()
    from app.workers.maintenance_worker import _purge_expired_trash

    async def _na_lixeira(nome, prazo):
        doc = uuid.uuid4()
        chave = storage_service.storage_key(empresa["co"], str(doc), "pdf")
        storage_service.put_object_bytes(chave, b"%PDF-1.4 " + nome.encode(), "application/pdf")
        storage_service.put_object_bytes(storage_service.thumb_key(chave), b"miniatura", "image/webp")
        await admin.execute(
            """
            INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                          storage_path, content_hash, ocr_status, uploaded_by, deleted_at, trash_expires_at)
            VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, $5, $6, 'done', $7, now() - interval '40 days', now() + $8::text::interval)
            """,
            doc, uuid.UUID(empresa["co"]), uuid.UUID(empresa["raiz"]), nome, chave, uuid.uuid4().hex * 2,
            uuid.UUID(empresa["user"]), prazo,
        )
        return doc, chave

    vencido, chave_vencida = await _na_lixeira(f"Vencido {uuid.uuid4().hex[:6]}.pdf", "-1 day")
    no_prazo, chave_no_prazo = await _na_lixeira(f"No prazo {uuid.uuid4().hex[:6]}.pdf", "5 days")

    await _purge_expired_trash(admin)

    assert not await admin.fetchval("SELECT EXISTS (SELECT 1 FROM public.documents WHERE id = $1)", vencido)
    assert storage_service.read_object(chave_vencida) is None
    assert storage_service.read_object(storage_service.thumb_key(chave_vencida)) is None
    # O que ainda está no prazo da lixeira fica, com o arquivo.
    assert await admin.fetchval("SELECT EXISTS (SELECT 1 FROM public.documents WHERE id = $1)", no_prazo)
    assert storage_service.read_object(chave_no_prazo) is not None
    await admin.execute("DELETE FROM public.documents WHERE id = $1", no_prazo)
