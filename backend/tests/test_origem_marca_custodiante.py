"""B1.3.9 (origem do valor), B2.4.7 (marca d'água) e B3.4.3 (bloqueio por custodiante)."""
import datetime
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_retencao_v2 import _doc, empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_origem_do_valor_manual_e_em_lote(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    r = await api.post(API + "/custom-fields", json={"company_id": co, "label": "Centro de custo", "type": "texto"}, headers=h)
    assert r.status_code == 201, r.text
    campo = r.json()["id"]
    assert (await api.put(API + "/folder-fields", json={"company_id": co, "folder_id": empresa["fiscal"], "custom_field_id": campo}, headers=h)).status_code == 200
    agora = datetime.datetime.now(datetime.timezone.utc)
    a = await _doc(admin, empresa, empresa["fiscal"], "A.pdf", agora)
    b = await _doc(admin, empresa, empresa["fiscal"], "B.pdf", agora)
    r = await api.put(API + f"/documents/{a}/field-values", json=[{"custom_field_id": campo, "value": "100"}], headers=h)
    assert r.status_code == 200, r.text
    r = await api.put(API + "/documents/field-values/batch", json={"document_ids": [b], "values": [{"custom_field_id": campo, "value": "200"}]}, headers=h)
    assert r.status_code == 200, r.text
    va = (await api.get(API + f"/documents/{a}/field-values", headers=h)).json()
    vb = (await api.get(API + f"/documents/{b}/field-values", headers=h)).json()
    assert va[0]["source"] == "manual"
    assert vb[0]["source"] == "lote" and vb[0]["updated_by_name"] == "Admin Retenção"
    # Editar à mão depois do lote volta a ser manual.
    await api.put(API + f"/documents/{b}/field-values", json=[{"custom_field_id": campo, "value": "201"}], headers=h)
    assert (await api.get(API + f"/documents/{b}/field-values", headers=h)).json()[0]["source"] == "manual"


@pytest.mark.asyncio
async def test_marca_dagua_configuravel(api, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    padrao = (await api.get(API + f"/companies/{co}/watermark", headers=h)).json()
    assert padrao == {"texto": None, "intensidade": "padrao", "previa": True, "link": True}
    r = await api.put(API + f"/companies/{co}/watermark", json={"texto": "  CONFIDENCIAL ", "intensidade": "forte", "previa": True, "link": False}, headers=h)
    assert r.status_code == 200, r.text
    assert (await api.get(API + f"/companies/{co}/watermark", headers=h)).json() == {"texto": "CONFIDENCIAL", "intensidade": "forte", "previa": True, "link": False}
    assert (await api.put(API + f"/companies/{co}/watermark", json={"intensidade": "berrante"}, headers=h)).status_code == 422


@pytest.mark.asyncio
async def test_bloqueio_por_custodiante(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    doc = await _doc(admin, empresa, empresa["fiscal"], "Contrato do custodiante.pdf", datetime.datetime.now(datetime.timezone.utc))
    assert not await admin.fetchval("SELECT public.document_is_under_hold($1)", uuid.UUID(doc))
    r = await api.post(API + f"/companies/{co}/retention/holds",
                       json={"company_id": co, "resource_type": "custodian", "resource_id": empresa["user"], "reason": "Processo trabalhista"}, headers=h)
    assert r.status_code == 201, r.text
    assert await admin.fetchval("SELECT public.document_is_under_hold($1)", uuid.UUID(doc))
    lista = (await api.get(API + f"/companies/{co}/retention/holds", headers=h)).json()
    assert lista[0]["resource_name"] == "Admin Retenção" and lista[0]["custodian_documents"] >= 1
    # Pessoa de fora da empresa não pode ser custodiante aqui.
    r = await api.post(API + f"/companies/{co}/retention/holds",
                       json={"company_id": co, "resource_type": "custodian", "resource_id": str(uuid.uuid4()), "reason": "x"}, headers=h)
    assert r.status_code == 404
    await admin.execute("UPDATE public.legal_holds SET released_at = now() WHERE company_id = $1", uuid.UUID(co))
