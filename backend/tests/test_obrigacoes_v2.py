"""
Obrigações que andam sozinhas (achados A7-03, A7-07, A7-08, A7-09, A7-27,
A7-36, A7-37, A7-47, A7-53, A7-62 da avaliação de 25/11/2026).
"""
import datetime
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def grupo(admin: asyncpg.Connection):
    co1, co2, gestora, operador, estranho = (str(uuid.uuid4()) for _ in range(5))
    for co, nome in ((co1, "Posto Obrigações"), (co2, "Hotel Obrigações")):
        await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, $2)", co, nome)
    for uid, nome in ((gestora, "Gestora Obrig"), (operador, "Operador Obrig"), (estranho, "Estranho Obrig")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute(
            "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')",
            uid, f"ob_{uid[:6]}", nome,
        )
    for co in (co1, co2):
        await admin.execute(
            "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')",
            gestora, co,
        )
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'operador')",
        operador, co1,
    )
    yield {"co1": co1, "co2": co2, "gestora": gestora, "operador": operador, "estranho": estranho}
    for co in (co1, co2):
        await admin.execute("DELETE FROM public.notifications WHERE company_id = $1", co)
        await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
        await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
        await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (gestora, operador, estranho):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


async def _doc(admin, co, user, nome="Guia.pdf"):
    folder = str(uuid.uuid4())
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, path, name, created_by) VALUES ($1, $2, $3::ltree, 'Fiscal', $4)",
        folder, co, "f" + uuid.uuid4().hex[:12], user,
    )
    doc = str(uuid.uuid4())
    await admin.execute(
        """
        INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                      storage_path, content_hash, ocr_status, uploaded_by)
        VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, 'x', $5, 'done', $6)
        """,
        doc, co, folder, nome, uuid.uuid4().hex * 2, user,
    )
    return doc


@pytest.mark.asyncio
async def test_modelos_prontos_criam_obrigacoes_e_nao_duplicam(api, grupo):  # noqa: F811
    h = _token(grupo["gestora"])
    r = await api.get(API + f"/companies/{grupo['co1']}/obligations/catalog", headers=h)
    assert r.status_code == 200, r.text
    assert {s["id"] for s in r.json()["segmentos"]} == {"perfil", "geral", "posto", "restaurante", "hotel"}

    r = await api.post(API + f"/companies/{grupo['co1']}/obligations/catalog",
                       json={"keys": ["fgts_digital", "cnd_federal", "posto_anp"]}, headers=h)
    assert r.status_code == 201, r.text
    assert r.json()["created"] == 3
    assert r.json()["generated"] >= 3  # FGTS do mês + "Vigente" das duas sem calendário

    r = await api.post(API + f"/companies/{grupo['co1']}/obligations/catalog", json={"keys": ["fgts_digital"]}, headers=h)
    assert r.json() == {"created": 0, "skipped": 1, "generated": 0}

    # Operador não configura (só cuida das competências).
    r = await api.post(API + f"/companies/{grupo['co1']}/obligations/catalog",
                       json={"keys": ["crf_fgts"]}, headers=_token(grupo["operador"]))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_recorrencia_mensal_gera_a_competencia_sozinha(api, admin, grupo):  # noqa: F811
    h = _token(grupo["gestora"])
    r = await api.post(API + f"/companies/{grupo['co2']}/obligations/templates", json={
        "company_id": grupo["co2"], "name": "Taxa do condomínio", "frequency": "mensal", "due_day": 10,
        "default_owner_id": grupo["gestora"],
    }, headers=h)
    assert r.status_code == 201, r.text
    assert r.json()["generated"] >= 1
    hoje = datetime.date.today()
    comp = hoje.strftime("%Y-%m")
    row = await admin.fetchrow(
        "SELECT due_date, owner_id::text FROM public.obligation_instances WHERE template_id = $1 AND period = $2",
        uuid.UUID(r.json()["id"]), comp,
    )
    assert row is not None
    proximo = (hoje.replace(day=28) + datetime.timedelta(days=4)).replace(day=10)
    assert row["due_date"] == proximo
    assert row["owner_id"] == grupo["gestora"]

    # Rodar de novo não duplica.
    r = await api.post(API + f"/companies/{grupo['co2']}/obligations/generate", headers=h)
    assert r.json() == {"generated": 0}

    # Anual sem mês de vencimento é recusado; competência mensal em texto livre também.
    r = await api.post(API + f"/companies/{grupo['co2']}/obligations/templates", json={
        "company_id": grupo["co2"], "name": "Anual sem mês", "frequency": "anual", "due_day": 31,
    }, headers=h)
    assert r.status_code == 422
    modelos = (await api.get(API + f"/companies/{grupo['co2']}/obligations/templates", headers=h)).json()
    tid = next(m["id"] for m in modelos if m["name"] == "Taxa do condomínio")
    r = await api.post(API + f"/companies/{grupo['co2']}/obligations/instances", json={
        "template_id": tid, "period": "qualquer coisa", "due_date": hoje.isoformat(),
    }, headers=h)
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_documento_vai_para_conferencia_e_aprovacao_fica_na_trilha(api, admin, grupo):  # noqa: F811
    hg, ho = _token(grupo["gestora"]), _token(grupo["operador"])
    co = grupo["co1"]
    t = (await api.post(API + f"/companies/{co}/obligations/templates", json={
        "company_id": co, "name": "Licença ambiental", "frequency": "unica",
    }, headers=hg)).json()
    inst = (await api.post(API + f"/companies/{co}/obligations/instances", json={
        "template_id": t["id"], "period": "Vigente", "due_date": datetime.date.today().isoformat(),
    }, headers=ho)).json()
    doc = await _doc(admin, co, grupo["operador"], "Licença LO.pdf")

    r = await api.post(API + f"/obligations/instances/{inst['id']}/documents",
                       json={"document_id": doc, "valid_until": (datetime.date.today() - datetime.timedelta(days=1)).isoformat()},
                       headers=ho)
    assert r.status_code == 201, r.text
    assert r.json()["instance"]["effective_status"] == "reviewing"
    aviso = await admin.fetchval(
        "SELECT count(*) FROM public.notifications WHERE type = 'obligation_review' AND resource_id = $1 AND user_id = $2",
        uuid.UUID(inst["id"]), uuid.UUID(grupo["gestora"]),
    )
    assert aviso == 1

    # Operador não aprova; devolver exige motivo; aprovar registra quem.
    assert (await api.post(API + f"/obligations/instances/{inst['id']}/review", json={"decision": "approve"}, headers=ho)).status_code == 403
    assert (await api.post(API + f"/obligations/instances/{inst['id']}/review", json={"decision": "return"}, headers=hg)).status_code == 422
    r = await api.post(API + f"/obligations/instances/{inst['id']}/review", json={"decision": "approve"}, headers=hg)
    assert r.status_code == 200, r.text
    # A validade impressa (ontem) já passou: aprovada, mas expirada.
    assert r.json()["effective_status"] == "expired"
    assert r.json()["reviewer_name"] == "Gestora Obrig"

    detalhe = (await api.get(API + f"/obligations/instances/{inst['id']}", headers=hg)).json()
    assert [d["document_name"] for d in detalhe["documents"]] == ["Licença LO.pdf"]
    acoes = [h["action"] for h in detalhe["history"]]
    assert "obligation_link" in acoes and "obligation_approve" in acoes and "obligation_create" in acoes

    r = await api.get(API + f"/documents/{doc}/obligations", headers=hg)
    assert [o["template_name"] for o in r.json()] == ["Licença ambiental"]


@pytest.mark.asyncio
async def test_ciclo_indireto_e_modelo_arquivado(api, grupo):  # noqa: F811
    h = _token(grupo["gestora"])
    co = grupo["co2"]
    ids = []
    for nome in ("Passo A", "Passo B", "Passo C"):
        ids.append((await api.post(API + f"/companies/{co}/obligations/templates",
                                   json={"company_id": co, "name": nome, "frequency": "evento"}, headers=h)).json()["id"])
    a, b, c = ids
    for x, y in ((a, b), (b, c)):
        r = await api.post(API + f"/companies/{co}/obligations/dependencies", json={"template_id": x, "depends_on_template_id": y}, headers=h)
        assert r.status_code == 201, r.text
    r = await api.post(API + f"/companies/{co}/obligations/dependencies", json={"template_id": c, "depends_on_template_id": a}, headers=h)
    assert r.status_code == 409
    assert "ciclo" in r.json()["detail"]

    inst = await api.post(API + f"/companies/{co}/obligations/instances",
                          json={"template_id": c, "period": "Obra 1", "due_date": datetime.date.today().isoformat()}, headers=h)
    assert inst.status_code == 201, inst.text
    assert (await api.post(API + f"/obligations/templates/{c}/archive", headers=h)).status_code == 204
    lista = (await api.get(API + f"/companies/{co}/obligations/instances", headers=h)).json()
    assert inst.json()["id"] not in [i["id"] for i in lista]


@pytest.mark.asyncio
async def test_responsavel_minhas_e_visao_do_grupo(api, grupo):  # noqa: F811
    hg = _token(grupo["gestora"])
    co = grupo["co1"]
    t = (await api.post(API + f"/companies/{co}/obligations/templates",
                        json={"company_id": co, "name": "Alvará", "frequency": "unica"}, headers=hg)).json()
    inst = (await api.post(API + f"/companies/{co}/obligations/instances", json={
        "template_id": t["id"], "period": "2026", "due_date": (datetime.date.today() - datetime.timedelta(days=2)).isoformat(),
    }, headers=hg)).json()

    r = await api.patch(API + f"/obligations/instances/{inst['id']}", json={"owner_id": grupo["estranho"]}, headers=hg)
    assert r.status_code == 422
    r = await api.patch(API + f"/obligations/instances/{inst['id']}", json={"owner_id": grupo["operador"], "notes": "Pedir ao despachante"}, headers=hg)
    assert r.status_code == 200, r.text
    assert (r.json()["owner_name"], r.json()["notes"]) == ("Operador Obrig", "Pedir ao despachante")

    minhas = (await api.get(API + f"/companies/{co}/obligations/instances", params={"mine": "true"},
                            headers=_token(grupo["operador"]))).json()
    assert inst["id"] in [i["id"] for i in minhas]

    g = (await api.get(API + "/obligations/group", headers=hg)).json()
    assert {e["company_id"] for e in g["empresas"]} >= {co}
    linha = next(i for i in g["instancias"] if i["id"] == inst["id"])
    assert (linha["effective_status"], linha["company_name"]) == ("overdue", "Posto Obrigações")

    # Dispensar pede motivo e entra na trilha.
    r = await api.patch(API + f"/obligations/instances/{inst['id']}/status", json={"status": "dispensado"}, headers=hg)
    assert r.status_code == 400
    r = await api.patch(API + f"/obligations/instances/{inst['id']}/status",
                        json={"status": "dispensado", "dispensa_motivo": "Unidade fechada"}, headers=hg)
    assert r.status_code == 200, r.text
    hist = (await api.get(API + f"/obligations/instances/{inst['id']}/history", headers=hg)).json()
    assert any(h["action"] == "obligation_dispense" and h["metadata"]["motivo"] == "Unidade fechada" for h in hist)

@pytest.mark.asyncio
async def test_catalogo_recomenda_pelo_perfil_fiscal(api, grupo):  # noqa: F811
    h = _token(grupo["gestora"])
    co = grupo["co2"]
    r = await api.get(API + f"/companies/{co}/obligations/catalog", headers=h)
    assert set(r.json()["perfil_incompleto"]) == {"regime_tributario", "faixa_funcionarios", "tipo_juridico", "cnae_principal"}

    r = await api.put(API + f"/companies/{co}/fiscal-profile", headers=h, json={
        "regime_tributario": "lucro_presumido", "faixa_funcionarios": "11_a_50", "uf": "BA",
        "tipo_juridico": "ltda", "cnae_principal": "4731-8/00",
    })
    assert r.status_code == 200, r.text
    assert r.json()["cnae_principal"] == "4731800"

    r = await api.put(API + f"/companies/{co}/fiscal-profile", headers=h, json={"cnae_principal": "47318"})
    assert r.status_code == 422

    itens = {i["key"]: i for i in (await api.get(API + f"/companies/{co}/obligations/catalog", headers=h)).json()["itens"]}
    assert itens["posto_anp"]["situacao"] == "recomendado" and "perfil" in itens["posto_anp"]["segmentos"]
    assert itens["efd_icms_ipi"]["situacao"] == "recomendado"
    assert itens["das_simples"]["situacao"] == "nao_se_aplica" and "perfil" not in itens["das_simples"]["segmentos"]
    assert itens["hotel_cadastur"]["situacao"] == "nao_se_aplica"
    assert "Lucro Presumido" in itens["ecf"]["motivos"]

    # Os campos da avaliação não vão para o modelo criado.
    r = await api.post(API + f"/companies/{co}/obligations/catalog", json={"keys": ["efd_contribuicoes"]}, headers=h)
    assert r.status_code == 201, r.text
