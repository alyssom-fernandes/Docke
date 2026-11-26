"""Política de links públicos por empresa (FA-A5-08)."""
import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_senha_obrigatoria_e_validade_maxima(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    doc = await _doc(admin, empresa, empresa["sub"], "Contrato.pdf", "texto")
    r = await api.put(API + f"/companies/{co}/share-policy", json={"require_password": True, "max_days": 7}, headers=h)
    assert r.status_code == 200, r.text
    assert (await api.get(API + f"/companies/{co}/share-policy", headers=h)).json() == {"require_password": True, "max_days": 7}

    base = {"resource_type": "document", "resource_id": doc, "always_latest": True}
    r = await api.post(API + "/shares", json={**base, "expires_in": "7d"}, headers=h)
    assert r.status_code == 422 and "senha" in r.json()["detail"]
    r = await api.post(API + "/shares", json={**base, "expires_in": "30d", "password": "abcd1234"}, headers=h)
    assert r.status_code == 422 and "7 dias" in r.json()["detail"]
    r = await api.post(API + "/shares", json={**base, "expires_in": "never", "password": "abcd1234"}, headers=h)
    assert r.status_code == 422
    r = await api.post(API + "/shares", json={**base, "expires_in": "7d", "password": "abcd1234"}, headers=h)
    assert r.status_code == 201, r.text
    link = r.json()["id"]

    # Edição não pode tirar a senha nem estender além do limite.
    assert (await api.patch(API + f"/shares/{link}", json={"password": ""}, headers=h)).status_code == 422
    assert (await api.patch(API + f"/shares/{link}", json={"expires_in": "30d"}, headers=h)).status_code == 422
    assert (await api.patch(API + f"/shares/{link}", json={"max_views": 5}, headers=h)).status_code == 200

    await api.put(API + f"/companies/{co}/share-policy", json={"require_password": False, "max_days": None}, headers=h)
    r = await api.post(API + "/shares", json={**base, "expires_in": "never"}, headers=h)
    assert r.status_code == 201, r.text
