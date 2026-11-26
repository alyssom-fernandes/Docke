"""
Início (achados A3-01, A3-05, A3-11, A3-12, A3-20, A3-25 e A3-33 da avaliação
de 25/11/2026): "para hoje" por empresa e do grupo, contadores com
comparação, gráfico por pasta que soma as subpastas, e quem abriu o quê.
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def grupo(admin: asyncpg.Connection):
    co1, co2, outra, user = (str(uuid.uuid4()) for _ in range(4))
    for co, nome in ((co1, "Posto Início"), (co2, "Hotel Início"), (outra, "Empresa Alheia")):
        await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, $2)", co, nome)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user, f"{user[:8]}@test.local")
    await admin.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Gestora Início', 'usuario')",
        user, f"ini_{user[:6]}",
    )
    for co in (co1, co2):
        await admin.execute(
            "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')",
            user, co,
        )
    yield {"co1": co1, "co2": co2, "outra": outra, "user": user}
    for co in (co1, co2, outra):
        await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
        await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
        await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    await admin.execute("DELETE FROM public.users WHERE id = $1", user)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", user)


async def _doc(admin, co, folder, user, nome="Nota.txt", ocr="done"):
    doc = str(uuid.uuid4())
    await admin.execute(
        """
        INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                      storage_path, content_hash, ocr_status, uploaded_by)
        VALUES ($1, $2, $3, $4, 'text/plain', 'txt', 10, $5, $6, $7, $8)
        """,
        doc, co, folder, nome, f"{co}/{doc}.txt", uuid.uuid4().hex * 2, ocr, user,
    )
    return doc


@pytest.mark.asyncio
async def test_para_hoje_resume_o_que_precisa_de_acao(api, admin, grupo):  # noqa: F811
    h = _token(grupo["user"])
    tpl = await admin.fetchval(
        "INSERT INTO public.obligation_templates (company_id, name, frequency, criticality)"
        " VALUES ($1, 'Livro de caixa', 'mensal', 'alta') RETURNING id",
        grupo["co1"],
    )
    await admin.execute(
        "INSERT INTO public.obligation_instances (template_id, company_id, period, due_date, owner_id)"
        " VALUES ($1, $2, '2026-10', CURRENT_DATE - 3, $3), ($1, $2, '2026-11', CURRENT_DATE + 2, NULL),"
        "        ($1, $2, '2026-12', CURRENT_DATE + 30, NULL)",
        tpl, grupo["co1"], grupo["user"],
    )
    pasta = (await api.post(API + "/folders", json={"name": "Fiscal", "company_id": grupo["co1"]}, headers=h)).json()
    await _doc(admin, grupo["co1"], pasta["id"], grupo["user"], "Escaneado.pdf", ocr="failed")

    r = await api.get(API + f"/today/company/{grupo['co1']}", headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["resumo"]["obrigacoes_vencidas"] == 1
    assert body["resumo"]["obrigacoes_semana"] == 1
    assert body["resumo"]["texto_com_falha"] == 1
    assert body["modelos_obrigacao"] == 1
    atrasada = body["obrigacoes"][0]
    assert (atrasada["period"], atrasada["dias_atraso"], atrasada["responsavel"]) == ("2026-10", 3, "Gestora Início")
    assert len(body["obrigacoes"]) == 2  # a de daqui a 30 dias não entra
    assert body["texto_com_falha"][0]["name"] == "Escaneado.pdf"

    # Visão do grupo: as duas empresas dela, nenhuma alheia.
    r = await api.get(API + "/today/group", headers=h)
    assert r.status_code == 200, r.text
    por_empresa = {g["company_id"]: g for g in r.json()}
    assert set(por_empresa) == {grupo["co1"], grupo["co2"]}
    assert por_empresa[grupo["co1"]]["total"] == 3
    assert por_empresa[grupo["co2"]]["total"] == 0

    r = await api.get(API + f"/today/company/{grupo['outra']}", headers=h)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_grafico_por_pasta_soma_subpastas_e_contadores_tem_comparacao(api, admin, grupo):  # noqa: F811
    h = _token(grupo["user"])
    co = grupo["co2"]
    rh = (await api.post(API + "/folders", json={"name": "RH", "company_id": co}, headers=h)).json()
    sub = (await api.post(API + "/folders", json={"name": "Admissões", "company_id": co, "parent_id": rh["id"]}, headers=h)).json()
    await _doc(admin, co, sub["id"], grupo["user"], "Ficha.txt")
    await _doc(admin, co, sub["id"], grupo["user"], "Contrato.txt")
    await _doc(admin, co, rh["id"], grupo["user"], "Política.txt")

    r = await api.get(API + f"/companies/{co}/stats/charts", params={"only": "folders"}, headers=h)
    assert r.status_code == 200, r.text
    assert "daily_uploads" not in r.json()
    barras = {b["name"]: b for b in r.json()["by_folder"]}
    assert barras["RH"]["document_count"] == 3
    assert barras["RH"]["has_children"] is True

    r = await api.get(API + f"/companies/{co}/stats/charts", params={"only": "folders", "folder_id": rh["id"]}, headers=h)
    barras = {b["name"]: b["document_count"] for b in r.json()["by_folder"]}
    assert barras == {"Admissões": 2, "Direto nesta pasta": 1}

    r = await api.get(API + f"/companies/{co}/stats", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["documents_today"] == 3
    assert r.json()["previous_uploads"] == 0


@pytest.mark.asyncio
async def test_abrir_documento_entra_na_trilha_e_nos_abertos_por_mim(api, admin, grupo):  # noqa: F811
    h = _token(grupo["user"])
    co = grupo["co1"]
    pasta = (await api.post(API + "/folders", json={"name": "Contratos", "company_id": co}, headers=h)).json()
    doc = await _doc(admin, co, pasta["id"], grupo["user"], "Aluguel.txt")

    for _ in range(3):
        r = await api.get(API + f"/documents/{doc}/preview-url", headers=h)
        assert r.status_code == 200, r.text
    vistas = await admin.fetchval(
        "SELECT count(*) FROM public.activity_log WHERE item_id = $1 AND action = 'view'", doc,
    )
    assert vistas == 1  # três aberturas seguidas contam uma vez

    r = await api.get(API + "/documents/recent", params={"company_id": co, "mine": "true"}, headers=h)
    assert r.status_code == 200, r.text
    assert [d["id"] for d in r.json()] == [doc]
    assert r.json()[0]["folder_name"] == "Contratos"

    r = await api.get(API + "/activity", params={"company_id": co, "sem_acessos": "true"}, headers=h)
    assert all(e["action"] not in ("view", "download") for e in r.json()["results"])
