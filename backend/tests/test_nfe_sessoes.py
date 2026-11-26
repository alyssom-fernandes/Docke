"""
NF-e lida no envio (FA-A4-12, B2.5.5, B2.5.6) e sessões ativas com
encerramento remoto (FA-A8-02, B4.2.6, FA-A9-10).
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio
from jose import jwt

from app.config import settings
from app.services import nfe_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"

CHAVE = "35261112345678000190550010000012341000012345"

XML_NFE = f"""<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe><infNFe Id="NFe{CHAVE}" versao="4.00">
    <ide><mod>55</mod><serie>1</serie><nNF>1234</nNF><natOp>Venda</natOp><dhEmi>2026-11-20T10:15:00-03:00</dhEmi></ide>
    <emit><CNPJ>12345678000190</CNPJ><xNome>Distribuidora Exemplo</xNome></emit>
    <dest><CNPJ>98765432000155</CNPJ><xNome>Posto Exemplo</xNome></dest>
    <total><ICMSTot><vNF>1500.50</vNF></ICMSTot></total>
  </infNFe></NFe>
</nfeProc>""".encode()


def _token_sessao(user_id: str, session_id: str, email: str = "x@test.local") -> dict[str, str]:
    claims = {"sub": user_id, "role": "authenticated", "aud": "authenticated", "aal": "aal2",
              "session_id": session_id, "email": email}
    return {"Authorization": f"Bearer {jwt.encode(claims, settings.JWT_SECRET, algorithm='HS256')}"}


@pytest_asyncio.fixture(loop_scope="session")
async def base(admin: asyncpg.Connection):
    co, adm, pessoa = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto NF-e')", co)
    for uid, nome in ((adm, "Admin NF-e"), (pessoa, "Pessoa NF-e")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')",
                            uid, f"n_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $3, 'admin'), ($2, $3, 'visualizador')",
        adm, pessoa, co,
    )
    pasta = await admin.fetchval(
        "INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Fiscal', 'fiscal') RETURNING id", co)
    docs = []
    for i in range(2):
        docs.append(str(await admin.fetchval(
            """
            INSERT INTO public.documents (company_id, folder_id, name, storage_path, mime_type, file_type, size_bytes, content_hash, uploaded_by)
            VALUES ($1, $2, $3, $4, 'application/xml', 'xml', 900, $5, $6) RETURNING id
            """,
            co, pasta, f"nota-{i}.xml", f"documents/{co}/nota-{i}.xml", f"hash-nfe-{co}-{i}", adm,
        )))
    yield {"co": co, "adm": adm, "pessoa": pessoa, "docs": docs}
    await admin.execute("DELETE FROM auth.sessions WHERE user_id = ANY($1::uuid[])", [adm, pessoa])
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (adm, pessoa):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


def test_le_os_campos_da_nota():
    campos = nfe_service.ler(XML_NFE)
    assert campos["chave"] == CHAVE and campos["modelo"] == "55" and campos["numero"] == "1234"
    assert nfe_service.ler(b"<?xml version='1.0'?><outro><a>1</a></outro>") is None


@pytest.mark.asyncio
async def test_nota_gravada_duplicada_e_achada_pela_chave(api, admin, base):  # noqa: F811
    for d in base["docs"]:
        await nfe_service.gravar(admin, d, base["co"], nfe_service.ler(XML_NFE))
    tipo, comp = await admin.fetchrow("SELECT tipo_fiscal, competencia::text FROM public.documents WHERE id = $1", base["docs"][0])
    assert tipo == "NF-e" and comp == "2026-11-01"

    r = await api.get(API + f"/documents/{base['docs'][0]}", headers=_token(base["pessoa"]))
    assert r.status_code == 200, r.text
    nota = r.json()["nfe"]
    assert nota["chave"] == CHAVE and nota["valor_total"] == 1500.5
    assert [d["id"] for d in nota["duplicatas"]] == [base["docs"][1]]

    # Chave com espaços a cada 4 dígitos acha as duas cópias.
    com_espacos = " ".join(CHAVE[i:i + 4] for i in range(0, 44, 4))
    r = await api.get(API + "/search", params={"q": com_espacos, "company_id": base["co"]}, headers=_token(base["pessoa"]))
    assert r.status_code == 200, r.text
    assert {x["id"] for x in r.json()["results"]} == set(base["docs"])


@pytest.mark.asyncio
async def test_sessoes_listar_encerrar_e_corte_imediato(api, admin, base):  # noqa: F811
    adm = base["adm"]
    atual, outra = str(uuid.uuid4()), str(uuid.uuid4())
    for sid, ua in ((atual, "Mozilla/5.0 (Windows NT 10.0) Chrome/130"), (outra, "Mozilla/5.0 (iPhone) Safari/17")):
        await admin.execute(
            "INSERT INTO auth.sessions (id, user_id, created_at, updated_at, user_agent) VALUES ($1, $2, now(), now(), $3)",
            sid, adm, ua,
        )
    h = _token_sessao(adm, atual)
    r = await api.get(API + "/auth/sessions", headers=h)
    assert r.status_code == 200, r.text
    sess = {s["id"]: s for s in r.json()["sessions"]}
    assert sess[atual]["atual"] is True and sess[outra]["atual"] is False

    # Esta sessão não se encerra por aqui; a outra sim.
    assert (await api.delete(API + f"/auth/sessions/{atual}", headers=h)).status_code == 422
    assert (await api.delete(API + f"/auth/sessions/{outra}", headers=h)).status_code == 200

    # O token de uma sessão encerrada é recusado na hora.
    r = await api.get(API + f"/companies/{base['co']}/people", headers=_token_sessao(adm, outra))
    assert r.status_code == 401 and r.json()["code"] == "sessao_encerrada"

    # O admin encerra as sessões de alguém da empresa; fica na trilha.
    sid_p = str(uuid.uuid4())
    await admin.execute("INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())", sid_p, base["pessoa"])
    r = await api.post(API + f"/companies/{base['co']}/members/{base['pessoa']}/end-sessions", headers=h)
    assert r.status_code == 200 and r.json()["encerradas"] == 1
    r = await api.get(API + "/auth/me", headers=_token_sessao(base["pessoa"], sid_p))
    assert r.status_code == 401
    acoes = {a["action"] for a in await admin.fetch("SELECT action FROM public.activity_log WHERE company_id = $1", base["co"])}
    assert "sessions_end" in acoes


@pytest.mark.asyncio
async def test_demo_nao_encerra_sessoes(api, admin, base):  # noqa: F811
    sid = str(uuid.uuid4())
    await admin.execute("INSERT INTO auth.sessions (id, user_id, created_at, updated_at) VALUES ($1, $2, now(), now())", sid, base["pessoa"])
    h = _token_sessao(base["pessoa"], sid, email=settings.DEMO_EMAIL)
    r = await api.post(API + "/auth/sessions/end-others", headers=h)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_busca_tolera_erro_de_digitacao(api, admin, base):  # noqa: F811
    """B2.2.3: sem resultado exato, 'contrarto' acha 'Contrato' (avisando que é aproximado)."""
    pasta = await admin.fetchval("SELECT id FROM public.folders WHERE company_id = $1 LIMIT 1", base["co"])
    doc = str(await admin.fetchval(
        """
        INSERT INTO public.documents (company_id, folder_id, name, storage_path, mime_type, file_type, size_bytes, content_hash, uploaded_by)
        VALUES ($1, $2, 'Contrato de locação do galpão.pdf', $3, 'application/pdf', 'pdf', 10, $4, $5) RETURNING id
        """,
        base["co"], pasta, f"documents/{base['co']}/contrato.pdf", f"hash-contrato-{base['co']}", base["adm"],
    ))
    h = _token(base["pessoa"])
    r = await api.get(API + "/search", params={"q": "contrarto", "company_id": base["co"]}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["aproximado"] is True and [x["id"] for x in r.json()["results"]] == [doc]
    # Com resultado exato, a busca não é marcada como aproximada.
    r = await api.get(API + "/search", params={"q": "contrato", "company_id": base["co"]}, headers=h)
    assert r.json()["aproximado"] is False and doc in [x["id"] for x in r.json()["results"]]
    # Palavra curta e sem parentesco não traz nada.
    r = await api.get(API + "/search", params={"q": "xyzw", "company_id": base["co"]}, headers=h)
    assert r.json()["results"] == []
