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
    assert {k: r.json()[k] for k in ("sensitivity", "effective", "inherited")} == {"sensitivity": "normal", "effective": "sensivel", "inherited": True}

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


@pytest.mark.asyncio
async def test_visualizador_nao_baixa_de_pasta_sensivel(api, admin, empresa):  # noqa: F811
    """B3.7.5: em pasta sensível, quem só visualiza abre a prévia mas não baixa; quem edita baixa."""
    h, co = _token(empresa["user"]), empresa["co"]
    leitor = str(uuid.uuid4())
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", leitor, f"{leitor[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Leitor LGPD', 'usuario')", leitor, f"lg_{leitor[:6]}")
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'visualizador')", leitor, co,
    )
    try:
        assert (await api.put(API + f"/folders/{empresa['raiz']}/privacy", json={"sensitivity": "sensivel"}, headers=h)).status_code == 200
        doc = await _doc(admin, empresa, empresa["sub"], "Exame periódico.pdf", "exame")
        r = await api.get(API + f"/documents/{doc}/download-url", headers=_token(leitor))
        assert r.status_code == 403, r.text
        r = await api.post(API + "/documents/bulk-download", json={"document_ids": [doc]}, headers=_token(leitor))
        assert r.status_code == 403, r.text
        r = await api.get(API + f"/documents/{doc}/download-url", headers=h)
        assert r.status_code == 200, r.text
    finally:
        await api.put(API + f"/folders/{empresa['raiz']}/privacy", json={"sensitivity": "normal"}, headers=h)
        await admin.execute("DELETE FROM public.activity_log WHERE user_id = $1", uuid.UUID(leitor))
        await admin.execute("DELETE FROM public.user_company_access WHERE user_id = $1", uuid.UUID(leitor))
        await admin.execute("DELETE FROM public.users WHERE id = $1", uuid.UUID(leitor))
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uuid.UUID(leitor))


@pytest.mark.asyncio
async def test_sugere_classificar_pasta_com_cpf_ou_saude(api, admin, empresa):  # noqa: F811
    """B3.7.1: CPF no texto sugere "pessoal"; termo de saúde sugere "sensível"; pasta já classificada some."""
    h, co = _token(empresa["user"]), empresa["co"]
    await _doc(admin, empresa, empresa["raiz"], "Holerite.pdf", "Funcionário CPF 529.982.247-25 salário")
    await _doc(admin, empresa, empresa["sub"], "Exame.pdf", "ASO admissional apto")
    r = await api.get(API + f"/companies/{co}/privacy/suggestions", headers=h)
    assert r.status_code == 200, r.text
    por_id = {x["id"]: x for x in r.json()}
    assert por_id[empresa["sub"]]["sugestao"] == "sensivel"
    assert por_id[empresa["raiz"]]["sugestao"] == "pessoal"
    assert (await api.put(API + f"/folders/{empresa['raiz']}/privacy", json={"sensitivity": "pessoal"}, headers=h)).status_code == 200
    ids = {x["id"] for x in (await api.get(API + f"/companies/{co}/privacy/suggestions", headers=h)).json()}
    assert empresa["raiz"] not in ids and empresa["sub"] not in ids  # a subpasta herda a classificação
    await api.put(API + f"/folders/{empresa['raiz']}/privacy", json={"sensitivity": "normal"}, headers=h)
