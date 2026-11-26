"""Organizar páginas de PDF: girar, reordenar, remover e extrair (B2.4.5)."""
import io
import uuid

import pytest

from app.services import storage_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


def _pdf(n: int) -> bytes:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    for i in range(n):
        pdf.new_page(200 + i * 10, 300)  # larguras diferentes para reconhecer cada página
    buf = io.BytesIO()
    pdf.save(buf)
    pdf.close()
    return buf.getvalue()


def _larguras(data: bytes) -> list[tuple[int, int]]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        return [(round(pdf[i].get_width()), pdf[i].get_rotation()) for i in range(len(pdf))]
    finally:
        pdf.close()


@pytest.mark.asyncio
async def test_organizar_e_extrair_paginas(api, admin, empresa):  # noqa: F811
    if not storage_service.is_mock():
        pytest.skip("precisa do storage simulado")
    h = _token(empresa["user"])
    doc = await _doc(admin, empresa, empresa["raiz"], "Contrato.pdf", "contrato")
    key = f"{empresa['co']}/paginas-{uuid.uuid4().hex}.pdf"
    storage_service.put_object_bytes(key, _pdf(3), "application/pdf")
    await admin.execute("UPDATE public.documents SET storage_path = $2 WHERE id = $1", uuid.UUID(doc), key)

    # Página inexistente: erro claro.
    r = await api.post(API + f"/documents/{doc}/pages", json={"paginas": [{"indice": 5}]}, headers=h)
    assert r.status_code == 422 and "3 páginas" in r.json()["detail"]

    # Nova versão: inverte a ordem, gira a primeira e tira a do meio.
    corpo = {"paginas": [{"indice": 2, "rotacao": 90}, {"indice": 0}], "modo": "versao"}
    r = await api.post(API + f"/documents/{doc}/pages", json=corpo, headers=h)
    assert r.status_code == 200, r.text
    assert "1 removida" in r.json()["resumo"] and "ordem nova" in r.json()["resumo"]
    atual = await admin.fetchrow("SELECT storage_path, ocr_status FROM public.documents WHERE id = $1", uuid.UUID(doc))
    assert atual["storage_path"] != key and atual["ocr_status"] == "pending"
    assert _larguras(storage_service.read_object(atual["storage_path"])) == [(300, 90), (200, 0)]  # girada: a largura vira a altura (300)
    # O original continua guardado, intacto.
    assert len(_larguras(storage_service.read_object(key))) == 3

    # Extrair: documento novo na mesma pasta, com só a página escolhida.
    r = await api.post(API + f"/documents/{doc}/pages", json={"paginas": [{"indice": 1}], "modo": "extrair", "nome": "Assinatura"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Assinatura.pdf"
    novo = await admin.fetchrow("SELECT storage_path, copied_from::text, folder_id::text FROM public.documents WHERE id = $1::uuid", r.json()["document_id"])
    assert novo["copied_from"] == doc and _larguras(storage_service.read_object(novo["storage_path"])) == [(200, 0)]
