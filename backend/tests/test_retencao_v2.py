"""
Retenção (achados A7-70, A7-80, A7-81, A7-82, A7-88, A7-90, A7-106, A7-107 e
A7-03 da avaliação de 25/11/2026).
"""
import datetime
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def empresa(admin: asyncpg.Connection):
    co, user = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Retenção V2')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user, f"{user[:8]}@test.local")
    await admin.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Admin Retenção', 'usuario')",
        user, f"ret_{user[:6]}",
    )
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", user, co,
    )
    raiz, fiscal = str(uuid.uuid4()), str(uuid.uuid4())
    lr = "r" + uuid.uuid4().hex[:10]
    lf = lr + ".f" + uuid.uuid4().hex[:10]
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, path, name, created_by) VALUES ($1, $2, $3::ltree, 'Arquivo', $4)",
        raiz, co, lr, user,
    )
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, parent_id, path, name, created_by) VALUES ($1, $2, $3, $4::ltree, 'Fiscal', $5)",
        fiscal, co, raiz, lf, user,
    )
    yield {"co": co, "user": user, "raiz": raiz, "fiscal": fiscal, "path_fiscal": lf}
    await admin.execute("SELECT set_config('docke.bypass_retencao', 'on', false)")
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.destruction_certificates WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    await admin.execute("SELECT set_config('docke.bypass_retencao', 'off', false)")
    await admin.execute("DELETE FROM public.users WHERE id = $1", user)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", user)


async def _doc(admin, e, folder, nome, created_at):
    doc = str(uuid.uuid4())
    await admin.execute(
        """
        INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                      storage_path, content_hash, ocr_status, uploaded_by, created_at)
        VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, 'x', $5, 'done', $6, $7)
        """,
        doc, e["co"], folder, nome, uuid.uuid4().hex * 2, e["user"], created_at,
    )
    return doc


async def _policy(api, h, co, **body):
    r = await api.post(API + f"/companies/{co}/retention/policies", json={"company_id": co, **body}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.mark.asyncio
async def test_prazo_mais_longo_prevalece_e_trava_continua_protegendo(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    curta = await _policy(api, h, co, name="Geral travada 12 meses", duration_months=12, locked=True)
    longa = await _policy(api, h, co, name="Fiscal 5 anos", duration_months=60, start_rule="ano_seguinte")
    assert (await api.post(API + f"/companies/{co}/retention/assignments", json={"company_id": co, "policy_id": curta["id"]}, headers=h)).status_code == 201
    assert (await api.post(API + f"/companies/{co}/retention/assignments",
                           json={"company_id": co, "policy_id": longa["id"], "folder_id": empresa["fiscal"]}, headers=h)).status_code == 201

    criado = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=10)
    doc = await _doc(admin, empresa, empresa["fiscal"], "NF do mês.pdf", criado)
    info = await admin.fetchrow("SELECT * FROM public.document_retention_info($1)", uuid.UUID(doc))
    # A guarda fiscal (5 anos a partir de 1º de janeiro do ano seguinte) vence a travada de 12 meses.
    assert info["policy_name"] == "Fiscal 5 anos"
    assert info["expires_at"] == datetime.date(criado.year + 6, 1, 1)
    # A trava de 12 meses ainda não acabou: a exclusão continua bloqueada.
    assert await admin.fetchval("SELECT public.document_deletion_block_reason($1)", uuid.UUID(doc)) == "retencao"

    r = await api.get(API + f"/documents/{doc}/retention/explain", headers=h)
    nomes = [(c["policy_name"], c["is_winner"]) for c in r.json()["candidates"]]
    assert nomes[0] == ("Fiscal 5 anos", True)


@pytest.mark.asyncio
async def test_politica_travada_so_aumenta_e_edicao_entra_na_trilha(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    p = await _policy(api, h, co, name="RH 10 anos", duration_months=120, locked=True)
    assert (await api.patch(API + f"/retention/policies/{p['id']}", json={"duration_months": 60}, headers=h)).status_code == 409
    assert (await api.patch(API + f"/retention/policies/{p['id']}", json={"locked": False}, headers=h)).status_code == 409
    r = await api.patch(API + f"/retention/policies/{p['id']}", json={"duration_months": 180, "notes": "Convenção coletiva"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["duration_months"] == 180
    acoes = await admin.fetch(
        "SELECT action, metadata->>'prazo_depois' AS depois FROM public.activity_log WHERE company_id = $1 AND item_id = $2 ORDER BY created_at",
        empresa["co"], uuid.UUID(p["id"]),
    )
    assert [a["action"] for a in acoes] == ["retention_policy_create", "retention_policy_update"]
    assert acoes[-1]["depois"] == "15 anos"


@pytest.mark.asyncio
async def test_bloqueio_judicial_com_processo_e_liberacao_com_motivo(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    r = await api.post(API + f"/companies/{co}/retention/holds", json={
        "company_id": co, "resource_type": "folder", "resource_id": str(uuid.uuid4()), "reason": "Fiscalização",
    }, headers=h)
    assert r.status_code == 404
    r = await api.post(API + f"/companies/{co}/retention/holds", json={
        "company_id": co, "resource_type": "folder", "resource_id": empresa["fiscal"], "reason": "Fiscalização estadual",
        "process_number": "0001234-56.2026.8.26.0100", "review_date": "2027-01-15",
    }, headers=h)
    assert r.status_code == 201, r.text
    hold = r.json()
    lista = (await api.get(API + f"/companies/{co}/retention/holds", headers=h)).json()
    item = next(x for x in lista if x["id"] == hold["id"])
    assert (item["resource_name"], item["resource_path"], item["process_number"]) == ("Fiscal", "Arquivo / Fiscal", "0001234-56.2026.8.26.0100")

    assert (await api.post(API + f"/retention/holds/{hold['id']}/release", params={"company_id": co}, json={"reason": "  "}, headers=h)).status_code == 422
    r = await api.post(API + f"/retention/holds/{hold['id']}/release", params={"company_id": co}, json={"reason": "Processo arquivado"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["release_reason"] == "Processo arquivado"
    acoes = [a["action"] for a in await admin.fetch(
        "SELECT action FROM public.activity_log WHERE company_id = $1 AND item_type = 'retention' AND item_id = $2 ORDER BY created_at",
        empresa["co"], uuid.UUID(hold["id"]),
    )]
    assert acoes == ["retention_hold_create", "retention_hold_release"]


@pytest.mark.asyncio
async def test_previa_mostra_data_nova_e_vencidos_e_decisao_em_lote(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    antigo = await _doc(admin, empresa, empresa["raiz"], "Recibo 2020.pdf", datetime.datetime(2020, 1, 5, tzinfo=datetime.timezone.utc))
    p = await _policy(api, h, co, name="Recibos 24 meses", duration_months=24)
    r = await api.get(API + f"/companies/{co}/retention/assignments/simulate", params={"policy_id": p["id"], "folder_id": empresa["raiz"]}, headers=h)
    assert r.status_code == 200, r.text
    sim = r.json()
    linha = next(x for x in sim["sample"] if x["document_id"] == antigo)
    assert linha["after_expires_at"] == "2022-01-05"
    assert sim["already_expired_count"] >= 1

    # Fila: dois itens decididos de uma vez; um id estranho desfaz tudo.
    d2 = await _doc(admin, empresa, empresa["raiz"], "Recibo 2019.pdf", datetime.datetime(2019, 1, 5, tzinfo=datetime.timezone.utc))
    ids = []
    for d in (antigo, d2):
        ids.append(str(await admin.fetchval(
            "INSERT INTO public.retention_review_queue (company_id, document_id, policy_id, policy_name_snapshot, computed_expires_at)"
            " VALUES ($1, $2, $3, 'Recibos 24 meses', '2022-01-05') RETURNING id",
            uuid.UUID(co), uuid.UUID(d), uuid.UUID(p["id"]),
        )))
    r = await api.post(API + f"/companies/{co}/retention/queue/decision-batch",
                       json={"ids": ids + [str(uuid.uuid4())], "status": "approved"}, headers=h)
    assert r.status_code == 404
    assert await admin.fetchval("SELECT count(*) FROM public.retention_review_queue WHERE id = ANY($1::uuid[]) AND status = 'pending'", ids) == 2
    r = await api.post(API + f"/companies/{co}/retention/queue/decision-batch",
                       json={"ids": ids, "status": "deferred", "deferred_until": "2030-01-01", "notes": "Auditoria em curso"}, headers=h)
    assert r.json() == {"updated": 2}

    r = await api.get(API + f"/companies/{co}/retention/summary", headers=h)
    assert r.status_code == 200 and r.json()["politicas"] >= 1


@pytest.mark.asyncio
async def test_tabela_de_temporalidade_pronta(api, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    cat = (await api.get(API + f"/companies/{co}/retention/catalog", headers=h)).json()
    assert any(c["key"] == "fiscal_5_anos" and c["prazo"] == "5 anos" for c in cat)
    r = await api.post(API + f"/companies/{co}/retention/catalog", json={"keys": ["fiscal_5_anos", "registro_empregados"]}, headers=h)
    assert r.json() == {"created": 2, "skipped": 0}
    r = await api.post(API + f"/companies/{co}/retention/catalog", json={"keys": ["fiscal_5_anos"]}, headers=h)
    assert r.json() == {"created": 0, "skipped": 1}
