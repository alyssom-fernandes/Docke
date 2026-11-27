"""B4.2.8 (uso e cota) e A2-41 (foto no avatar)."""
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_retencao_v2 import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_uso_da_empresa_e_cota_so_do_administrador_geral(api, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    u = (await api.get(API + f"/companies/{co}/usage", headers=h)).json()
    assert u["cota_bytes"] is None and u["bytes_total"] >= 0 and "documentos" in u
    assert (await api.put(API + f"/companies/{co}/quota", json={"quota_gb": 1}, headers=h)).status_code == 403


@pytest.mark.asyncio
async def test_cota_recusa_envio_acima_do_limite(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    await admin.execute("UPDATE public.companies SET quota_bytes = 1000 WHERE id = $1", uuid.UUID(co))
    r = await api.post(API + "/documents/upload-url", json={"folder_id": empresa["fiscal"], "company_id": co, "name": "grande.pdf",
                                                            "size_bytes": 5000, "content_type": "application/pdf"}, headers=h)
    assert r.status_code == 413 and "limite de armazenamento" in r.text
    await admin.execute("UPDATE public.companies SET quota_bytes = NULL WHERE id = $1", uuid.UUID(co))


@pytest.mark.asyncio
async def test_foto_no_avatar_valida_tipo_tamanho_e_dono(api, empresa):  # noqa: F811
    h = _token(empresa["user"])
    assert (await api.post(API + "/auth/avatar/upload-url", json={"content_type": "image/svg+xml", "size_bytes": 10}, headers=h)).status_code == 422
    assert (await api.post(API + "/auth/avatar/upload-url", json={"content_type": "image/png", "size_bytes": 3 * 1024 * 1024}, headers=h)).status_code == 413
    # Chave de outra pessoa não é aceita.
    r = await api.put(API + "/auth/avatar", json={"avatar_key": f"avatars/{uuid.uuid4()}-abc.png"}, headers=h)
    assert r.status_code == 400
    r = await api.put(API + "/auth/avatar", json={"avatar_key": None}, headers=h)
    assert r.status_code == 200 and r.json()["avatar_url"] is None
    assert (await api.get(API + "/auth/me", headers=h)).json()["avatar_url"] is None
