"""Conferência de integridade do arquivo guardado (J1-08, B1.4.8)."""
import hashlib
import uuid

import pytest

from app.services import storage_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_conferir_integridade_compara_com_o_hash_da_versao(api, admin, empresa):  # noqa: F811
    if not storage_service.is_mock():
        pytest.skip("precisa do storage simulado")
    h = _token(empresa["user"])
    doc = await _doc(admin, empresa, empresa["raiz"], "Contrato.pdf", "contrato")
    key = f"{empresa['co']}/integ-{uuid.uuid4().hex}.pdf"
    conteudo = b"%PDF-1.4 contrato original"
    storage_service.put_object_bytes(key, conteudo, "application/pdf")
    sha = hashlib.sha256(conteudo).hexdigest()
    versao = await admin.fetchval(
        "INSERT INTO public.document_versions (document_id, version_number, storage_key, size_bytes, mime_type, uploaded_by)"
        " VALUES ($1, 1, $2, $3, 'application/pdf', $4) RETURNING id",
        uuid.UUID(doc), key, len(conteudo), empresa["user"],
    )
    await admin.execute(
        "UPDATE public.documents SET storage_path = $2, content_hash = $3, current_version_id = $4 WHERE id = $1",
        uuid.UUID(doc), key, sha, versao,
    )

    # Versão 1 sem sha256 próprio: usa o hash do envio.
    r = await api.post(API + f"/documents/{doc}/integrity", headers=h)
    assert r.status_code == 200, r.text
    assert (r.json()["resultado"], r.json()["sha256_registrado"], r.json()["versao"]) == ("integro", sha, 1)
    acao = await admin.fetchrow(
        "SELECT metadata->>'resultado' AS r, severity FROM public.activity_log WHERE item_id = $1 AND action = 'integrity_check'",
        uuid.UUID(doc),
    )
    assert (acao["r"], acao["severity"]) == ("integro", "info")

    # Arquivo trocado por fora: divergente e crítico na trilha.
    storage_service.put_object_bytes(key, b"%PDF-1.4 adulterado", "application/pdf")
    r = await api.post(API + f"/documents/{doc}/integrity", headers=h)
    assert r.json()["resultado"] == "divergente"

    # A listagem de versões traz a impressão digital.
    r = await api.get(API + f"/documents/{doc}/versions", headers=h)
    assert r.status_code == 200, r.text
    corpo = r.json()
    lista = corpo if isinstance(corpo, list) else corpo.get("versions", corpo.get("results", []))
    assert lista[0]["sha256"] == sha

    # Arquivo sumido do storage.
    await admin.execute("UPDATE public.documents SET storage_path = $2 WHERE id = $1", uuid.UUID(doc), f"{empresa['co']}/nao-existe.pdf")
    r = await api.post(API + f"/documents/{doc}/integrity", headers=h)
    assert r.json()["resultado"] == "arquivo_ausente"

    # Sem acesso: 404.
    outro = str(uuid.uuid4())
    r = await api.post(API + f"/documents/{outro}/integrity", headers=h)
    assert r.status_code == 404
