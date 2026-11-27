"""Recursos ligáveis por empresa (Ajustes → Recursos)."""
import uuid

import pytest

from app.services.features_service import merge
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


def test_padrao_e_tudo_ligado_menos_o_canal_do_titular():
    r = merge({})
    assert all(r[k] for k in ("links", "pedidos", "obrigacoes", "exames", "comentarios", "ocr"))
    assert r["canal_titular"] is False
    assert merge('{"links": false}', True) == {**r, "links": False, "canal_titular": True}


@pytest.mark.asyncio
async def test_desligar_links_bloqueia_criar_e_o_link_que_ja_existia(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    r = await api.get(API + f"/companies/{co}/features", headers=h)
    assert r.status_code == 200 and r.json()["features"]["links"] is True

    doc = await _doc(admin, empresa, empresa["sub"], "Contrato.pdf", "texto")
    base = {"resource_type": "document", "resource_id": doc, "always_latest": True, "expires_in": "7d"}
    r = await api.post(API + "/shares", json=base, headers=h)
    assert r.status_code == 201, r.text
    token = r.json()["token"]
    assert (await api.get(API + f"/s/{token}/info")).status_code == 200

    r = await api.put(API + f"/companies/{co}/features", json={"features": {"links": False}}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["features"]["links"] is False

    r = await api.post(API + "/shares", json=base, headers=h)
    assert r.status_code == 403 and "Ajustes → Recursos" in r.json()["detail"]
    r = await api.get(API + f"/s/{token}/info")
    assert r.status_code == 410 and "desligou" in r.json()["detail"]

    # A mudança fica na trilha, com o que mudou.
    meta = await admin.fetchval(
        "SELECT metadata FROM public.activity_log WHERE company_id = $1 AND action = 'features' ORDER BY created_at DESC LIMIT 1", co,
    )
    assert '"links": false' in str(meta)

    # Ligar de novo devolve o link como estava.
    r = await api.put(API + f"/companies/{co}/features", json={"features": {"links": True}}, headers=h)
    assert r.status_code == 200
    assert (await api.get(API + f"/s/{token}/info")).status_code == 200


@pytest.mark.asyncio
async def test_so_quem_administra_muda_e_chave_desconhecida_e_recusada(api, admin, empresa):  # noqa: F811
    co = empresa["co"]
    oper = str(uuid.uuid4())
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", oper, f"{oper[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Operador Recursos', 'usuario')",
                        oper, f"rec_{oper[:6]}")
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'operador')", oper, co)
    try:
        # Lê (a tela se adapta), mas não muda.
        assert (await api.get(API + f"/companies/{co}/features", headers=_token(oper))).status_code == 200
        r = await api.put(API + f"/companies/{co}/features", json={"features": {"obrigacoes": False}}, headers=_token(oper))
        assert r.status_code == 403
        r = await api.put(API + f"/companies/{co}/features", json={"features": {"inventado": False}}, headers=_token(empresa["user"]))
        assert r.status_code == 422 and "inventado" in r.json()["detail"]
    finally:
        await admin.execute("DELETE FROM public.user_company_access WHERE user_id = $1", oper)
        await admin.execute("DELETE FROM public.users WHERE id = $1", oper)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", oper)


@pytest.mark.asyncio
async def test_comentarios_obrigacoes_e_pedidos_desligados(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    doc = await _doc(admin, empresa, empresa["sub"], "Holerite.pdf", "texto")
    r = await api.put(API + f"/companies/{co}/features",
                      json={"features": {"comentarios": False, "obrigacoes": False, "pedidos": False, "canal_titular": True}}, headers=h)
    assert r.status_code == 200, r.text
    f = r.json()["features"]
    assert f["comentarios"] is False and f["obrigacoes"] is False and f["pedidos"] is False and f["canal_titular"] is True
    assert await admin.fetchval("SELECT lgpd_channel_enabled FROM public.companies WHERE id = $1", co) is True

    r = await api.post(API + f"/documents/{doc}/comments", json={"body": "Conferir o valor"}, headers=h)
    assert r.status_code == 403 and r.json().get("code") == "recurso_desligado:comentarios"
    r = await api.post(API + f"/companies/{co}/obligations/templates", json={
        "company_id": co, "name": "Taxa do condomínio", "frequency": "mensal", "due_day": 10,
    }, headers=h)
    assert r.status_code == 403
    r = await api.post(API + "/upload-requests", json={"company_id": co, "folder_id": empresa["sub"], "title": "Notas"}, headers=h)
    assert r.status_code == 403

    # O Início não avisa de obrigações desligadas.
    resumo = (await api.get(API + f"/today/company/{co}/resumo", headers=h)).json()
    assert resumo["obrigacoes_vencidas"] == 0 and resumo["obrigacoes_semana"] == 0

    # A lista de empresas já traz os recursos, para a tela se adaptar sem outra chamada.
    lista = (await api.get(API + "/companies", headers=h)).json()
    minha = next(c for c in lista if c["id"] == co)
    assert minha["features"]["comentarios"] is False and minha["features"]["canal_titular"] is True
