"""Registro de incidentes de segurança (LGPD art. 48; parte final do X2-17)."""
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest

from app.routers.security_incidents import pendencias_para_encerrar, somar_dias_uteis
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


def test_prazo_conta_so_dias_uteis():
    sexta = date(2026, 11, 27)
    assert somar_dias_uteis(sexta, 3) == date(2026, 12, 2)  # seg, ter, qua
    segunda = date(2026, 11, 30)
    assert somar_dias_uteis(segunda, 3) == date(2026, 12, 3)
    sabado = date(2026, 11, 28)
    assert somar_dias_uteis(sabado, 3) == date(2026, 12, 2)


def test_o_que_falta_para_encerrar():
    assert pendencias_para_encerrar({"medidas": "", "risco_relevante": None}) == [
        "as medidas tomadas para conter e reduzir os efeitos",
        "a avaliação de risco (se o incidente pode causar risco ou dano relevante aos titulares)",
    ]
    assert pendencias_para_encerrar({"medidas": "Link revogado", "risco_relevante": True,
                                     "comunicado_anpd_em": datetime.now(timezone.utc)}) == ["a data da comunicação aos titulares"]
    assert pendencias_para_encerrar({"medidas": "Link revogado", "risco_relevante": False, "avaliacao_risco": ""}) == [
        "o motivo de o risco não ser relevante"]
    assert pendencias_para_encerrar({"medidas": "x", "risco_relevante": False, "avaliacao_risco": "Arquivo cifrado"}) == []


@pytest.mark.asyncio
async def test_incidente_do_registro_ao_encerramento(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    co = empresa["co"]
    soube = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    r = await api.post(API + f"/companies/{co}/privacy/incidents", headers=h, json={
        "titulo": "Link público de holerites aberto sem senha", "descoberto_em": soube,
        "categorias": ["trabalhista", "identificacao"], "titulares_afetados": 12,
    })
    assert r.status_code == 201, r.text
    inc = r.json()
    assert inc["protocolo"].startswith("INC-")
    assert inc["status"] == "aberto" and inc["risco_relevante"] is None
    assert inc["eventos"][0]["tipo"] == "criado"
    iid = inc["id"]

    # Encerrar sem medidas nem avaliação: o Docke diz o que falta.
    r = await api.patch(API + f"/privacy/incidents/{iid}", headers=h, json={"status": "encerrado"})
    assert r.status_code == 422 and "medidas" in r.json()["detail"]

    # Risco relevante exige as duas comunicações.
    r = await api.patch(API + f"/privacy/incidents/{iid}", headers=h, json={
        "risco_relevante": True, "avaliacao_risco": "Holerite tem CPF e salário", "medidas": "Link revogado e acessos conferidos",
        "comunicado_anpd_em": datetime.now(timezone.utc).isoformat(), "protocolo_anpd": "00261.000123/2026-11",
    })
    assert r.status_code == 200, r.text
    r = await api.patch(API + f"/privacy/incidents/{iid}", headers=h, json={"status": "encerrado"})
    assert r.status_code == 422 and "titulares" in r.json()["detail"]

    futuro = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    r = await api.patch(API + f"/privacy/incidents/{iid}", headers=h, json={"comunicado_titulares_em": futuro})
    assert r.status_code == 422

    r = await api.patch(API + f"/privacy/incidents/{iid}", headers=h, json={
        "comunicado_titulares_em": datetime.now(timezone.utc).isoformat(), "status": "encerrado",
    })
    assert r.status_code == 200, r.text
    fim = r.json()
    assert fim["status"] == "encerrado" and fim["encerrado_at"]
    assert fim["comunicacao_atrasada"] is False
    assert {e["tipo"] for e in fim["eventos"]} >= {"criado", "risco", "medidas", "anpd", "titulares", "status"}

    # Encerrado não muda sem reabrir; nota pode.
    r = await api.patch(API + f"/privacy/incidents/{iid}", headers=h, json={"medidas": "outra"})
    assert r.status_code == 409
    r = await api.patch(API + f"/privacy/incidents/{iid}", headers=h, json={"nota": "Relatório final arquivado"})
    assert r.status_code == 200

    # Trilha de auditoria registra, com severidade crítica.
    n = await admin.fetchval(
        "SELECT count(*) FROM public.activity_log WHERE item_id = $1 AND action LIKE 'security_incident_%' AND severity = 'critical'",
        uuid.UUID(iid))
    assert n >= 2

    lista = (await api.get(API + f"/companies/{co}/privacy/incidents", headers=h)).json()
    assert [i["id"] for i in lista] == [iid]


@pytest.mark.asyncio
async def test_incidente_so_para_admin_e_prazo_atrasado(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    co = empresa["co"]
    antigo = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    r = await api.post(API + f"/companies/{co}/privacy/incidents", headers=h, json={
        "titulo": "Notebook com arquivos de RH furtado", "descoberto_em": antigo, "categorias": ["saude"],
    })
    assert r.status_code == 201, r.text
    iid = r.json()["id"]
    assert r.json()["comunicacao_atrasada"] is True
    assert r.json()["dados_sensiveis"] is True

    estranho = str(uuid.uuid4())
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", estranho, f"{estranho[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Fora', 'usuario')",
                        estranho, f"inc_{estranho[:6]}")
    try:
        r = await api.get(API + f"/companies/{co}/privacy/incidents", headers=_token(estranho))
        assert r.status_code == 403
        r = await api.get(API + f"/privacy/incidents/{iid}", headers=_token(estranho))
        assert r.status_code == 403
    finally:
        await admin.execute("DELETE FROM public.users WHERE id = $1", estranho)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", estranho)

    r = await api.post(API + f"/companies/{co}/privacy/incidents", headers=h, json={
        "titulo": "Futuro", "descoberto_em": (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
    })
    assert r.status_code == 422
