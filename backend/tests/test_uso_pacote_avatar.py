"""B4.2.8 (uso, cota e pacote de configuração) e A2-41 (foto no avatar)."""
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_retencao_v2 import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_pacote_de_configuracao_entre_empresas(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    r = await api.post(API + "/custom-fields", json={"company_id": co, "label": "Data de desligamento", "type": "data"}, headers=h)
    assert r.status_code == 201, r.text
    r = await api.post(API + f"/companies/{co}/retention/policies",
                       json={"company_id": co, "name": "RH após desligamento", "duration_months": 60}, headers=h)
    assert r.status_code == 201, r.text
    r = await api.get(API + f"/companies/{co}/config-package", headers=h)
    assert r.status_code == 200, r.text
    pacote = r.json()
    assert pacote["docke_pacote"] == 1
    assert any(c["label"] == "Data de desligamento" for c in pacote["campos"])
    assert any(p["name"] == "RH após desligamento" for p in pacote["politicas"])

    outra = str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Destino do Pacote')", outra)
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", empresa["user"], outra)
    try:
        previa = (await api.post(API + f"/companies/{outra}/config-package/import", json={"pacote": pacote}, headers=h)).json()
        assert previa["aplicado"] is False and "Data de desligamento" in previa["campos"]["novos"]
        assert not await admin.fetchval("SELECT count(*) FROM public.custom_field WHERE company_id = $1", uuid.UUID(outra))
        r = await api.post(API + f"/companies/{outra}/config-package/import", json={"pacote": pacote, "aplicar": True}, headers=h)
        assert r.status_code == 200, r.text
        assert await admin.fetchval("SELECT count(*) FROM public.custom_field WHERE company_id = $1 AND label = 'Data de desligamento'", uuid.UUID(outra)) == 1
        assert await admin.fetchval("SELECT count(*) FROM public.retention_policies WHERE company_id = $1 AND name = 'RH após desligamento'", uuid.UUID(outra)) == 1
        # Importar de novo não duplica nada.
        de_novo = (await api.post(API + f"/companies/{outra}/config-package/import", json={"pacote": pacote}, headers=h)).json()
        assert de_novo["campos"]["novos"] == [] and de_novo["politicas"]["novas"] == []
        # Uso da empresa e cota (só o administrador geral define).
        u = (await api.get(API + f"/companies/{co}/usage", headers=h)).json()
        assert u["cota_bytes"] is None and u["bytes_total"] >= 0
        assert (await api.put(API + f"/companies/{co}/quota", json={"quota_gb": 1}, headers=h)).status_code == 403
        assert (await api.post(API + f"/companies/{outra}/config-package/import", json={"pacote": {"x": 1}}, headers=h)).status_code == 422
    finally:
        await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", uuid.UUID(outra))
        await admin.execute("DELETE FROM public.companies WHERE id = $1", uuid.UUID(outra))


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
