"""LGPD: pastas sensíveis e pedido do titular (X2-17)."""
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_pasta_sensivel_bloqueia_link_e_vale_para_subpastas(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    r = await api.put(API + f"/folders/{empresa['raiz']}/privacy", json={"sensitivity": "sensivel"}, headers=h)
    assert r.status_code == 200, r.text
    r = await api.get(API + f"/folders/{empresa['sub']}/privacy", headers=h)
    assert r.json() == {"sensitivity": "normal", "effective": "sensivel", "inherited": True}

    doc = await _doc(admin, empresa, empresa["sub"], "ASO admissional.pdf", "exame")
    r = await api.post(API + "/shares", json={"resource_type": "document", "resource_id": doc, "always_latest": True}, headers=h)
    assert r.status_code == 422, r.text
    assert "sensível" in r.json()["detail"]

    pastas = (await api.get(API + f"/companies/{empresa['co']}/privacy/folders", headers=h)).json()
    assert [(p["name"], p["sensitivity"], p["documentos"]) for p in pastas] == [("Fiscal", "sensivel", 1)]

    r = await api.put(API + f"/folders/{empresa['raiz']}/privacy", json={"sensitivity": "normal"}, headers=h)
    r = await api.post(API + "/shares", json={"resource_type": "document", "resource_id": doc, "always_latest": True}, headers=h)
    assert r.status_code == 201, r.text
    assert (await api.put(API + f"/folders/{empresa['raiz']}/privacy", json={"sensitivity": "xpto"}, headers=h)).status_code == 422


@pytest.mark.asyncio
async def test_pedido_do_titular_acha_cpf_e_registra_sem_o_cpf(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    doc = await _doc(admin, empresa, empresa["sub"], "Holerite março.pdf", "Funcionário CPF 529.982.247-25 salário")
    r = await api.get(API + f"/companies/{co}/privacy/titular", params={"q": "52998224725"}, headers=h)
    assert r.status_code == 200, r.text
    assert doc in [x["id"] for x in r.json()["results"]]
    ev = await admin.fetchrow(
        "SELECT metadata, item_name_snapshot FROM public.activity_log WHERE company_id = $1 AND action = 'lgpd_titular_search'",
        uuid.UUID(co),
    )
    assert ev is not None
    assert "52998224725" not in str(ev["metadata"]) and "529.982" not in str(ev["metadata"])
