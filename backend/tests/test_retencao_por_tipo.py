"""Prazo de guarda por tipo de documento e por metadado (A7-89)."""
import datetime
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_retencao_v2 import _doc, _policy, empresa  # noqa: F401 — fixtures reaproveitadas

API = "/api/v1"


@pytest.mark.asyncio
async def test_atribuicao_por_tipo_e_por_metadado(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    criado = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=5)
    nfe = await _doc(admin, empresa, empresa["fiscal"], "NF 1.xml", criado)
    outro = await _doc(admin, empresa, empresa["fiscal"], "Recibo.pdf", criado)
    holerite = await _doc(admin, empresa, empresa["raiz"], "Holerite março.pdf", criado)
    await admin.execute("UPDATE public.documents SET tipo_fiscal = 'NF-e' WHERE id = $1", uuid.UUID(nfe))

    campo = await admin.fetchval(
        """
        INSERT INTO public.custom_field (company_id, label, field_key, type, format_config, created_by)
        VALUES ($1, 'Tipo de documento', 'tipo_doc', 'texto', '{}'::jsonb, $2) RETURNING id::text
        """,
        uuid.UUID(co), uuid.UUID(empresa["user"]),
    )
    await admin.execute(
        "INSERT INTO public.document_field_value (company_id, document_id, custom_field_id, value_text) VALUES ($1, $2, $3, 'Holerite')",
        uuid.UUID(co), uuid.UUID(holerite), uuid.UUID(campo),
    )

    nf5 = await _policy(api, h, co, name="NF-e 5 anos", duration_months=60)
    rh = await _policy(api, h, co, name="Holerites 10 anos", duration_months=120)

    # Simulação respeita o filtro: só a NF-e entra.
    r = await api.get(API + f"/companies/{co}/retention/assignments/simulate",
                      params={"policy_id": nf5["id"], "match_tipo_fiscal": "nf-e"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["total_documents_in_scope"] == 1

    r = await api.post(API + f"/companies/{co}/retention/assignments",
                       json={"company_id": co, "policy_id": nf5["id"], "match_tipo_fiscal": "NF-e"}, headers=h)
    assert r.status_code == 201, r.text
    r = await api.post(API + f"/companies/{co}/retention/assignments",
                       json={"company_id": co, "policy_id": rh["id"], "match_field_id": campo, "match_field_value": "holerite"}, headers=h)
    assert r.status_code == 201, r.text
    # Campo sem valor é recusado.
    r = await api.post(API + f"/companies/{co}/retention/assignments",
                       json={"company_id": co, "policy_id": rh["id"], "match_field_id": campo}, headers=h)
    assert r.status_code == 422

    async def vencedora(doc):
        return await admin.fetchval("SELECT policy_name FROM public.document_retention_info($1)", uuid.UUID(doc))

    assert await vencedora(nfe) == "NF-e 5 anos"
    assert await vencedora(outro) is None
    assert await vencedora(holerite) == "Holerites 10 anos"

    lista = (await api.get(API + f"/companies/{co}/retention/assignments", headers=h)).json()
    por_politica = {a["policy_name"]: a for a in lista}
    assert por_politica["NF-e 5 anos"]["document_count"] == 1
    assert por_politica["Holerites 10 anos"]["match_field_label"] == "Tipo de documento"
