"""Contrato da API (X3-16, A5-64): erros com código estável e detalhe sem dados internos."""
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_erros_tem_codigo_e_mantem_detail(api, empresa):  # noqa: F811
    h = _token(empresa["user"])
    r = await api.get(API + f"/documents/{uuid.uuid4()}", headers=h)
    assert r.status_code == 404
    assert r.headers["content-type"].startswith("application/problem+json")
    corpo = r.json()
    assert corpo["code"] == "nao_encontrado" and corpo["status"] == 404 and corpo["detail"] == "Documento não encontrado."

    r = await api.get(API + "/documents/nao-e-uuid", headers=h)
    assert r.status_code == 422
    assert r.json()["code"] == "dados_invalidos" and isinstance(r.json()["detail"], list)

    r = await api.get(API + f"/documents/{uuid.uuid4()}")
    assert r.status_code in (401, 403)
    assert r.json()["code"] in ("nao_autenticado", "sem_permissao")


@pytest.mark.asyncio
async def test_detalhe_sem_caminho_interno_e_texto_sob_demanda(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    texto = "Holerite de março " * 100
    doc = await _doc(admin, empresa, empresa["sub"], "Holerite.pdf", texto)
    r = await api.get(API + f"/documents/{doc}", headers=h)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "storage_path" not in d and "ocr_text" not in d
    assert d["ocr_excerpt"] == texto[:600] and d["ocr_text_length"] == len(texto)

    r = await api.get(API + f"/documents/{doc}/text", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["text"] == texto
