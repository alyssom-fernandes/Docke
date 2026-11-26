"""O conteúdo do arquivo tem de bater com a extensão (X3-18)."""
import uuid

import pytest

from app.services import storage_service
from app.services.file_signature import content_matches_extension
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.parametrize("nome,cabeca,ok", [
    ("a.pdf", b"%PDF-1.7\n...", True),
    ("a.pdf", b"MZ\x90\x00\x03", False),
    ("a.pdf", b"<html><script>", False),
    ("a.png", b"\x89PNG\r\n\x1a\n....", True),
    ("a.jpg", b"\xff\xd8\xff\xe0", True),
    ("a.jpg", b"GIF89a", False),
    ("a.docx", b"PK\x03\x04", True),
    ("a.xlsx", b"%PDF-", False),
    ("a.xls", b"<table><tr><td>extrato", True),  # "xls" de banco que é HTML
    ("a.xls", b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", True),
    ("a.xml", b"\xef\xbb\xbf<?xml version", True),
    ("a.xml", b"  <nfeProc>", True),
    ("a.xml", b"MZ\x90\x00", False),
    ("a.csv", b"cnpj;valor\n", True),
    ("a.txt", b"\x7fELF\x02\x01\x01\x00", False),
    ("a.txt", b"", True),
    ("a.exe", b"MZ", False),
])
def test_assinatura(nome, cabeca, ok):
    assert content_matches_extension(nome, cabeca) is ok


@pytest.mark.asyncio
async def test_envio_com_conteudo_falso_e_recusado(api, admin, empresa):  # noqa: F811
    if not storage_service.is_mock():
        pytest.skip("precisa do storage simulado")
    h = _token(empresa["user"])
    for conteudo, esperado in ((b"MZ\x90\x00 executavel", 415), (b"%PDF-1.4 nota fiscal " + uuid.uuid4().hex.encode(), 200)):
        r = await api.post(API + "/documents/upload-url", json={
            "folder_id": empresa["raiz"], "company_id": empresa["co"], "name": f"Nota {uuid.uuid4().hex[:6]}.pdf",
            "size_bytes": len(conteudo), "content_type": "application/pdf",
        }, headers=h)
        assert r.status_code in (200, 201), r.text
        doc_id = r.json()["document_id"]
        key = await admin.fetchval("SELECT storage_path FROM public.documents WHERE id = $1", uuid.UUID(doc_id))
        storage_service.put_object_bytes(key, conteudo, "application/pdf")
        r = await api.post(API + f"/documents/{doc_id}/confirm", headers=h)
        assert r.status_code == esperado, r.text
        existe = await admin.fetchval("SELECT EXISTS (SELECT 1 FROM public.documents WHERE id = $1)", uuid.UUID(doc_id))
        assert existe is (esperado == 200)


def test_xml_com_entidade_e_recusado():
    from xml.etree import ElementTree

    from app.services.file_signature import safe_xml_fromstring
    bomba = b'<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><l>&b;</l>'
    with pytest.raises(ElementTree.ParseError):
        safe_xml_fromstring(bomba)
    assert safe_xml_fromstring(b"<nfeProc><NFe/></nfeProc>").tag == "nfeProc"
