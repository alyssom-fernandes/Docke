"""ZIP em lote enviado em partes (achado X3-04)."""
import io
import uuid
import zipfile

import pytest

from app.services import storage_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_zip_em_lote_vem_completo_e_valido(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    d1 = await _doc(admin, empresa, empresa["raiz"], "Nota A.pdf", "nota a")
    d2 = await _doc(admin, empresa, empresa["raiz"], "Nota B.pdf", "nota b")
    for d in (d1, d2):
        key = await admin.fetchval("SELECT storage_path FROM public.documents WHERE id = $1", uuid.UUID(d))
        if storage_service.is_mock():
            storage_service.put_object_bytes(key, f"conteudo {d}".encode(), "application/pdf")
    r = await api.post(API + "/documents/bulk-download", json={"document_ids": [d1, d2]}, headers=h)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/zip"
    assert int(r.headers["content-length"]) == len(r.content)
    nomes = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    if storage_service.is_mock():
        assert sorted(nomes) == ["Nota A.pdf", "Nota B.pdf"]
