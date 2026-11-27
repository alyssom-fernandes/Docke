"""B1.1.9/B4.3.7: lotes de envio no servidor; B1.1.5: juntar como nova versão (regras)."""
import datetime
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_retencao_v2 import _doc, empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_lote_concluido_vira_aviso_e_relatorio(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    r = await api.post(API + "/upload-batches", json={"company_id": co, "folder_name": "Arquivo", "total": 3}, headers=h)
    assert r.status_code == 201, r.text
    lote = r.json()["id"]
    lista = (await api.get(API + "/upload-batches", params={"company_id": co}, headers=h)).json()
    assert lista[0]["situacao"] == "em_andamento"
    r = await api.patch(API + f"/upload-batches/{lote}", json={"ok": 2, "concluido": True, "falhas": [{"nome": "a.exe", "motivo": "Tipo não aceito"}]}, headers=h)
    assert r.status_code == 200, r.text
    lista = (await api.get(API + "/upload-batches", params={"company_id": co}, headers=h)).json()
    assert lista[0]["situacao"] == "concluido" and lista[0]["n_falhas"] == 1 and lista[0]["ok"] == 2
    msg = await admin.fetchval("SELECT message FROM public.notifications WHERE type = 'upload_batch' AND resource_id = $1", uuid.UUID(lote))
    assert msg == 'Envio para "Arquivo" concluído: 2 disponíveis, 1 precisa de atenção.'
    csv = (await api.get(API + f"/upload-batches/{lote}/relatorio", headers=h)).text
    assert "a.exe;Tipo não aceito" in csv
    # Outra pessoa não mexe no lote; lote antigo sem notícia aparece interrompido.
    assert (await api.patch(API + f"/upload-batches/{lote}", json={"ok": 0}, headers=_token(str(uuid.uuid4())))).status_code in (401, 403, 404)
    r = await api.post(API + "/upload-batches", json={"company_id": co, "total": 5}, headers=h)
    await admin.execute("UPDATE public.upload_batches SET started_at = now() - interval '3 hours' WHERE id = $1", uuid.UUID(r.json()["id"]))
    lista = (await api.get(API + "/upload-batches", params={"company_id": co}, headers=h)).json()
    assert any(x["situacao"] == "interrompido" for x in lista)
    await admin.execute("DELETE FROM public.notifications WHERE company_id = $1", uuid.UUID(co))


@pytest.mark.asyncio
async def test_juntar_so_quem_enviou(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    agora = datetime.datetime.now(datetime.timezone.utc)
    antigo = await _doc(admin, empresa, empresa["fiscal"], "Nota.xml", agora - datetime.timedelta(days=3))
    novo = await _doc(admin, empresa, empresa["fiscal"], "Nota (2).xml", agora - datetime.timedelta(days=2))
    # Enviado há mais de 24 h: não junta mais.
    r = await api.post(API + f"/documents/{novo}/juntar", json={"destino_id": antigo}, headers=h)
    assert r.status_code == 403
    r = await api.post(API + f"/documents/{novo}/juntar", json={"destino_id": novo}, headers=h)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_numeros_do_inicio_por_pasta(api, admin, empresa):  # noqa: F811
    """B4.1.5: escopo "minha área" nos números do Início."""
    h, co = _token(empresa["user"]), empresa["co"]
    agora = datetime.datetime.now(datetime.timezone.utc)
    await _doc(admin, empresa, empresa["fiscal"], "No fiscal.pdf", agora)
    await _doc(admin, empresa, empresa["raiz"], "Na raiz.pdf", agora)
    toda = (await api.get(API + f"/companies/{co}/stats", headers=h)).json()
    so_fiscal = (await api.get(API + f"/companies/{co}/stats", params={"folder_id": empresa["fiscal"]}, headers=h)).json()
    assert so_fiscal["total_documents"] == 1 and so_fiscal["documents_today"] == 1
    assert toda["total_documents"] >= 2
    assert (await api.get(API + f"/companies/{co}/stats", params={"folder_id": str(uuid.uuid4())}, headers=h)).status_code == 404
