"""
Metadados (achados A8-16, A8-20 e A8-T2 da avaliação de 25/11/2026): valor
padrão validado pelo tipo, campo arquivado pode voltar e as mudanças entram
na trilha.
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def empresa(admin: asyncpg.Connection):
    co, user = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Metadados V2')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user, f"{user[:8]}@test.local")
    await admin.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Admin Metadados', 'usuario')", user, f"md_{user[:6]}",
    )
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", user, co,
    )
    yield {"co": co, "user": user}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    await admin.execute("DELETE FROM public.users WHERE id = $1", user)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", user)


@pytest.mark.asyncio
async def test_padrao_validado_campo_volta_e_trilha(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    cnpj = (await api.post(API + "/custom-fields", json={"company_id": co, "label": "CNPJ do fornecedor", "type": "cnpj"}, headers=h)).json()
    banco = (await api.post(API + "/custom-fields", json={
        "company_id": co, "label": "Banco", "type": "selecao", "format_config": {"options": ["Itaú", "Bradesco"]},
    }, headers=h)).json()

    r = await api.put(API + "/folder-fields", json={"company_id": co, "custom_field_id": cnpj["id"], "default_value": "abc"}, headers=h)
    assert r.status_code == 422
    r = await api.put(API + "/folder-fields", json={"company_id": co, "custom_field_id": banco["id"], "default_value": "Santander"}, headers=h)
    assert r.status_code == 422
    r = await api.put(API + "/folder-fields", json={"company_id": co, "custom_field_id": banco["id"], "default_value": "Itaú"}, headers=h)
    assert r.status_code == 200, r.text

    assert (await api.post(API + f"/custom-fields/{banco['id']}/archive", headers=h)).status_code == 204
    r = await api.post(API + f"/custom-fields/{banco['id']}/restore", headers=h)
    assert r.status_code == 200, r.text
    ids = [f["id"] for f in (await api.get(API + "/custom-fields", params={"company_id": co}, headers=h)).json()]
    assert banco["id"] in ids

    acoes = [a["action"] for a in await admin.fetch(
        "SELECT action FROM public.activity_log WHERE company_id = $1 AND item_type = 'config' ORDER BY created_at", uuid.UUID(co),
    )]
    assert acoes == ["field_rule_apply", "field_archive", "field_restore"]


@pytest.mark.asyncio
async def test_tipos_novos_validam_e_formatam(api, admin, empresa):  # noqa: F811
    """B1.3.2: moeda, e-mail, telefone, CEP e sim/não."""
    from app.routers.custom_fields import _normalize_extra

    h, co = _token(empresa["user"]), empresa["co"]
    casos = {"moeda": ("1.234,56", "abc"), "email": ("ana@posto.com.br", "ana@"), "telefone": ("11987654321", "123"),
             "cep": ("01310100", "123"), "booleano": ("sim", "talvez")}
    for tipo, (bom, ruim) in casos.items():
        f = await api.post(API + "/custom-fields", json={"company_id": co, "label": f"Campo {tipo}", "type": tipo}, headers=h)
        assert f.status_code in (200, 201), (tipo, f.text)
        fid = f.json()["id"]
        r = await api.put(API + "/folder-fields", json={"company_id": co, "custom_field_id": fid, "default_value": ruim}, headers=h)
        assert r.status_code == 422, (tipo, r.text)
        r = await api.put(API + "/folder-fields", json={"company_id": co, "custom_field_id": fid, "default_value": bom}, headers=h)
        assert r.status_code == 200, (tipo, r.text)
    assert _normalize_extra("moeda", "1.234,56")[0] == "R$ 1.234,56"
    assert _normalize_extra("telefone", "11987654321")[0] == "(11) 98765-4321"
    assert _normalize_extra("cep", "01310100")[0] == "01310-100"
    assert _normalize_extra("booleano", "NÃO")[0] == "Não"
