"""
Eventos da NF-e ligados à nota pela chave (B2.5.9) e matriz de conformidade
do grupo (FA-A7-04).
"""
import uuid
from datetime import date, timedelta

import asyncpg
import pytest
import pytest_asyncio

from app.services import nfe_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_nfe_sessoes import CHAVE, XML_NFE

API = "/api/v1"

XML_CANCELAMENTO = f"""<?xml version="1.0" encoding="UTF-8"?>
<procEventoNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">
  <evento versao="1.00"><infEvento Id="ID110111{CHAVE}01">
    <chNFe>{CHAVE}</chNFe><dhEvento>2026-11-21T09:00:00-03:00</dhEvento><tpEvento>110111</tpEvento>
    <detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>135260000000001</nProt><xJust>Erro no valor da nota emitida</xJust></detEvento>
  </infEvento></evento>
  <retEvento versao="1.00"><infEvento><cStat>135</cStat><nProt>135260000000999</nProt></infEvento></retEvento>
</procEventoNFe>""".encode()


@pytest_asyncio.fixture(loop_scope="session")
async def base(admin: asyncpg.Connection):
    co, co2, uid = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Eventos'), ($2, 'Posto Matriz')", co, co2)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Eventos', 'usuario')", uid, f"e_{uid[:6]}")
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin'), ($1, $3, 'admin')", uid, co, co2)
    pasta = await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Fiscal', 'fiscal') RETURNING id", co)
    docs = []
    for i, nome in enumerate(("nota.xml", "cancelamento.xml")):
        docs.append(await admin.fetchval(
            """
            INSERT INTO public.documents (company_id, folder_id, name, storage_path, mime_type, file_type, size_bytes, content_hash, uploaded_by)
            VALUES ($1, $2, $3, $4, 'application/xml', 'xml', 900, $5, $6) RETURNING id
            """, co, pasta, nome, f"x/{co}/{i}", f"ev-{co}-{i}", uid))
    yield {"co": co, "co2": co2, "uid": uid, "docs": docs}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = ANY($1::uuid[])", [co, co2])
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = ANY($1::uuid[])", [co, co2])
    await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


def test_le_o_evento():
    ev = nfe_service.ler_evento(XML_CANCELAMENTO)
    assert ev["chave"] == CHAVE and ev["tipo"] == "110111" and ev["descricao"] == "Cancelamento"
    assert ev["texto"] == "Erro no valor da nota emitida" and ev["protocolo"] == "135260000000999"
    assert nfe_service.ler_evento(XML_NFE) is None


@pytest.mark.asyncio
async def test_nota_cancelada_pelo_evento(api, admin, base):  # noqa: F811
    nota, evento = base["docs"]
    await nfe_service.gravar(admin, nota, base["co"], nfe_service.ler(XML_NFE))
    await nfe_service.gravar_evento(admin, evento, base["co"], nfe_service.ler_evento(XML_CANCELAMENTO))
    await nfe_service.gravar(admin, evento, base["co"], None)
    h = _token(base["uid"])
    r = await api.get(API + f"/documents/{nota}", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["nfe"]["cancelada"] is True and r.json()["nfe"]["eventos"][0]["descricao"] == "Cancelamento"
    r = await api.get(API + f"/documents/{evento}", headers=h)
    assert r.json()["nfe"] is None and r.json()["nfe_evento"]["nota"]["id"] == str(nota)


@pytest.mark.asyncio
async def test_matriz_do_grupo(api, admin, base):  # noqa: F811
    hoje = date.today()
    for co, status in ((base["co"], "approved"), (base["co2"], "pending")):
        tpl = await admin.fetchval(
            "INSERT INTO public.obligation_templates (company_id, name, frequency, criticality) VALUES ($1, 'DCTFWeb', 'mensal', 'alta') RETURNING id", co)
        await admin.execute(
            "INSERT INTO public.obligation_instances (template_id, company_id, period, due_date, status) VALUES ($1, $2, '2026-10', $3, $4)",
            tpl, co, hoje - timedelta(days=5), status)
    r = await api.get(API + "/obligations/matrix", headers=_token(base["uid"]))
    assert r.status_code == 200, r.text
    m = r.json()
    assert "DCTFWeb" in m["obrigacoes"]
    assert m["celulas"][base["co"]]["DCTFWeb"]["status"] == "approved"
    assert m["celulas"][base["co2"]]["DCTFWeb"]["status"] == "overdue"
    resumo = {e["company_id"]: e for e in m["empresas"]}
    assert resumo[base["co2"]]["atrasadas"] == 1 and resumo[base["co"]]["em_dia"] == 1
