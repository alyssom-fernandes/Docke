"""
Contrato de resposta (X3-16): as rotas de leitura das telas declaram
response_model, o JSON sai igual ao de antes e, nos testes (CONTRATO_ESTRITO),
campo fora do modelo ou tipo errado derruba a chamada.
"""
import datetime
import decimal
import uuid
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.config import settings
from app.schemas.base import Resposta
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


class _Filho(Resposta):
    quando: datetime.datetime | None


class _Item(Resposta):
    id: str
    valor: decimal.Decimal
    filho: _Filho | None = None


def _app_de_teste(linhas: list[dict[str, Any]]) -> FastAPI:
    app = FastAPI()

    @app.get("/com", response_model=list[_Item])
    async def com() -> list[dict[str, Any]]:
        return linhas

    @app.get("/sem")
    async def sem() -> list[dict[str, Any]]:
        return linhas

    return app


@pytest.mark.asyncio
async def test_json_igual_ao_de_antes_e_campo_a_mais_e_erro(monkeypatch):
    agora = datetime.datetime(2026, 11, 27, 10, 30, tzinfo=datetime.timezone.utc)
    linhas = [{"id": str(uuid.uuid4()), "valor": decimal.Decimal("2.50"), "filho": {"quando": agora}}, {"id": "b", "valor": 1}]
    transporte = httpx.ASGITransport(app=_app_de_teste(linhas))
    async with httpx.AsyncClient(transport=transporte, base_url="http://t") as c:
        com, sem = (await c.get("/com")).json(), (await c.get("/sem")).json()
    # Mesmo JSON (datas, decimais, campo ausente) que a rota sem modelo devolvia.
    assert com == sem
    assert "filho" not in com[1]

    linhas.append({"id": "c", "valor": 3, "segredo": "x"})
    monkeypatch.setattr(settings, "CONTRATO_ESTRITO", True)
    transporte = httpx.ASGITransport(app=_app_de_teste(linhas))
    async with httpx.AsyncClient(transport=transporte, base_url="http://t") as c:
        with pytest.raises(Exception, match="segredo"):
            await c.get("/com")

    # Em produção a resposta segue como veio (e o desvio vai para o log).
    monkeypatch.setattr(settings, "CONTRATO_ESTRITO", False)
    linhas.append({"id": 4, "valor": "não é número"})
    transporte = httpx.ASGITransport(app=_app_de_teste(linhas))
    async with httpx.AsyncClient(transport=transporte, base_url="http://t") as c:
        r = await c.get("/com")
    assert r.status_code == 200 and r.json()[-2:] == [{"id": "c", "valor": 3, "segredo": "x"}, {"id": 4, "valor": "não é número"}]


@pytest.mark.asyncio
async def test_rotas_das_telas_seguem_o_contrato(api, admin, empresa):  # noqa: F811
    assert settings.CONTRATO_ESTRITO
    h, co, uid = _token(empresa["user"]), empresa["co"], empresa["user"]
    doc = await _doc(admin, empresa, empresa["sub"], "Contrato.pdf", "contrato de prestação de serviços")
    lixo = await _doc(admin, empresa, empresa["sub"], "Rascunho.pdf", "rascunho")
    velha = str(uuid.uuid4())
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, path, name, created_by, deleted_at) VALUES ($1, $2, $3::ltree, 'Velha', $4, now())",
        velha, co, "v" + uuid.uuid4().hex[:10], uid,
    )
    await admin.execute(
        "INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)"
        " VALUES ($1, $2, 'view', 'document', $3, 'Contrato.pdf', '{\"origem\": \"teste\"}'::jsonb)",
        uuid.UUID(uid), uuid.UUID(co), uuid.UUID(doc),
    )
    await admin.execute(
        "INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)"
        " VALUES ($1, $2, 'version_added', 'document', $3, 'teste')",
        uuid.UUID(uid), uuid.UUID(co), uuid.UUID(doc),
    )
    try:
        assert (await api.post(API + "/favorites", json={"document_id": doc}, headers=h)).status_code == 201
        assert (await api.post(API + "/favorites", json={"folder_id": empresa["raiz"]}, headers=h)).status_code == 201
        r = await api.post(API + "/shares", json={"resource_type": "document", "resource_id": doc}, headers=h)
        assert r.status_code in (200, 201), r.text
        assert (await api.delete(API + f"/documents/{lixo}", headers=h)).status_code in (200, 204)

        chamadas = [
            ("/documents", {"folder_id": empresa["sub"], "company_id": co}),
            ("/documents", {"folder_id": empresa["sub"], "company_id": co, "limit": 1}),
            ("/documents/recent", {"company_id": co}),
            ("/documents/recent", {"company_id": co, "mine": "true"}),
            (f"/documents/{doc}", {}),
            (f"/documents/{doc}/text", {}),
            ("/folders", {"company_id": co}),
            ("/folders", {"company_id": co, "flat": "true"}),
            ("/folders/frequent", {"company_id": co}),
            (f"/folders/{empresa['raiz']}/summary", {}),
            ("/search", {"q": "contrato", "company_id": co}),
            ("/search", {"q": "", "company_id": co}),
            ("/search", {"q": "contrrato", "company_id": co}),
            ("/search/quick", {"q": "contr", "company_id": co}),
            ("/activity", {"company_id": co}),
            ("/shares", {"company_id": co}),
            ("/trash", {"company_id": co}),
            ("/favorites", {"company_id": co}),
            ("/notifications", {}),
            ("/companies", {}),
            (f"/companies/{co}", {}),
            (f"/companies/{co}/members", {}),
            (f"/companies/{co}/people", {}),
            (f"/companies/{co}/obligations/instances", {}),
            (f"/documents/{doc}/obligations", {}),
        ]
        for rota, params in chamadas:
            r = await api.get(API + rota, params=params, headers=h)
            assert r.status_code == 200, (rota, r.text)

        # Os campos que as telas leem continuam lá.
        lista = (await api.get(API + "/documents", params={"folder_id": empresa["sub"], "company_id": co}, headers=h)).json()
        d = next(x for x in lista if x["id"] == doc)
        assert d["favorited"] is True and d["active_share_count"] == 1 and d["uploaded_by_name"] == "Pessoa Listas"
        lix = (await api.get(API + "/trash", params={"company_id": co}, headers=h)).json()
        assert [x["id"] for x in lix["documents"]] == [lixo] and [x["id"] for x in lix["folders"]] == [velha]
        anc = (await api.get(API + "/favorites", params={"company_id": co}, headers=h)).json()
        assert {x["item_type"] for x in anc} == {"document", "folder"}
        frequentes = (await api.get(API + "/folders/frequent", params={"company_id": co}, headers=h)).json()
        assert [x["id"] for x in frequentes] == [empresa["sub"]]
    finally:
        await admin.execute("DELETE FROM public.notifications WHERE user_id = $1", uuid.UUID(uid))
        await admin.execute("DELETE FROM public.favorites WHERE user_id = $1", uuid.UUID(uid))
        await admin.execute("DELETE FROM public.folders WHERE id = $1", uuid.UUID(velha))
