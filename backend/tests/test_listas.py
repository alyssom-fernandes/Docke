"""
Busca e listas (achados A6-03, A6-04, A6-06, A6-12, A6-16, A6-17, A6-31 da
avaliação de 25/11/2026).
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
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Listas')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user, f"{user[:8]}@test.local")
    await admin.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Pessoa Listas', 'usuario')",
        user, f"lst_{user[:6]}",
    )
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", user, co,
    )
    raiz, sub = str(uuid.uuid4()), str(uuid.uuid4())
    lr = "l" + uuid.uuid4().hex[:10]
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, path, name, created_by) VALUES ($1, $2, $3::ltree, 'Fiscal', $4)",
        raiz, co, lr, user,
    )
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, parent_id, path, name, created_by) VALUES ($1, $2, $3, $4::ltree, 'Notas', $5)",
        sub, co, raiz, lr + ".n" + uuid.uuid4().hex[:8], user,
    )
    yield {"co": co, "user": user, "raiz": raiz, "sub": sub}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.shares WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    await admin.execute("DELETE FROM public.users WHERE id = $1", user)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", user)


async def _doc(admin, e, folder, nome, texto, created_at=None, ocr="done"):
    doc = str(uuid.uuid4())
    await admin.execute(
        """
        INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                      storage_path, content_hash, ocr_status, ocr_text, uploaded_by, created_at)
        VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, 'x', $5, $6, $7, $8, COALESCE($9, now()))
        """,
        doc, e["co"], folder, nome, uuid.uuid4().hex * 2, ocr, texto, e["user"], created_at,
    )
    return doc


@pytest.mark.asyncio
async def test_busca_acha_cnpj_com_ou_sem_pontuacao_e_filtra(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    a = await _doc(admin, empresa, empresa["sub"], "Contrato fornecedor.pdf", "CNPJ 12.345.678/0001-90 contratante",
                   datetime.datetime(2026, 2, 1, tzinfo=datetime.timezone.utc))
    b = await _doc(admin, empresa, empresa["raiz"], "Guia.pdf", "cnpj 12345678000190 guia de recolhimento",
                   datetime.datetime(2026, 6, 1, tzinfo=datetime.timezone.utc))
    await _doc(admin, empresa, empresa["raiz"], "Escaneado.pdf", None, ocr="failed")

    for termo in ("12345678000190", "12.345.678/0001-90"):
        r = await api.get(API + "/search", params={"q": termo, "company_id": co}, headers=h)
        assert r.status_code == 200, r.text
        assert {x["id"] for x in r.json()["results"]} == {a, b}, termo
    assert r.json()["sem_texto"] == 1

    # Pasta com subpastas, pasta exata, período e ordenação.
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "folder_id": empresa["raiz"]}, headers=h)
    assert {x["id"] for x in r.json()["results"]} == {a, b}
    assert next(x for x in r.json()["results"] if x["id"] == a)["folder_path_label"] == "Fiscal / Notas"
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "folder_id": empresa["raiz"], "subfolders": "false"}, headers=h)
    assert [x["id"] for x in r.json()["results"]] == [b]
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "date_from": "2026-05-01"}, headers=h)
    assert [x["id"] for x in r.json()["results"]] == [b]
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "sort": "antigos"}, headers=h)
    assert [x["id"] for x in r.json()["results"]] == [a, b]
    r = await api.get(API + "/search", params={"q": "12345678000190", "company_id": co, "page_size": 1, "page": 2, "sort": "antigos"}, headers=h)
    assert (r.json()["total"], [x["id"] for x in r.json()["results"]]) == (2, [b])


@pytest.mark.asyncio
async def test_lixeira_ancorados_e_links_dizem_onde_quando_e_quem(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    d = await _doc(admin, empresa, empresa["sub"], "Recibo.pdf", "recibo")
    assert (await api.post(API + "/favorites", json={"document_id": d}, headers=h)).status_code in (200, 201)
    favs = (await api.get(API + "/favorites", params={"company_id": co}, headers=h)).json()
    assert favs[0]["location"] == "Fiscal / Notas"

    r = await api.post(API + "/shares", json={"resource_type": "document", "resource_id": d, "always_latest": True}, headers=h)
    assert r.status_code == 201, r.text
    share_id = r.json()["id"]
    await admin.execute("INSERT INTO public.share_accesses (share_id, success, user_agent) VALUES ($1, true, 'Firefox')", uuid.UUID(share_id))
    lista = (await api.get(API + "/shares", params={"company_id": co}, headers=h)).json()
    assert lista[0]["created_by_name"] == "Pessoa Listas"
    acessos = (await api.get(API + f"/shares/{share_id}/accesses", headers=h)).json()
    assert [(x["success"], x["user_agent"]) for x in acessos] == [(True, "Firefox")]
    # Linha do tempo do documento: acessos de todos os links dele (A5-25).
    por_doc = (await api.get(API + "/shares/by-resource/accesses", params={"resource_type": "document", "resource_id": d}, headers=h)).json()
    assert [(x["share_id"], x["user_agent"]) for x in por_doc] == [(share_id, "Firefox")]

    # Revogar é reversível (B3.2.2): o mesmo link volta a valer.
    assert (await api.delete(API + f"/shares/{share_id}", headers=h)).status_code == 204
    r = await api.post(API + f"/shares/{share_id}/reactivate", headers=h)
    assert r.status_code == 200, r.text
    assert await admin.fetchval("SELECT revoked_at FROM public.shares WHERE id = $1", uuid.UUID(share_id)) is None
    acoes = [x["action"] for x in await admin.fetch("SELECT action FROM public.activity_log WHERE company_id = $1", uuid.UUID(co))]
    assert "share_revoke" in acoes and "share_reactivate" in acoes

    assert (await api.delete(API + f"/documents/{d}", headers=h)).status_code in (200, 204)
    itens = (await api.get(API + "/trash", params={"company_id": co}, headers=h)).json()
    item = next(x for x in (itens["documents"] if isinstance(itens, dict) else itens) if x["id"] == d)
    assert item["trash_expires_at"] is not None
    assert item["original_path"] == "Fiscal / Notas"
    assert item["deleted_by_name"] == "Pessoa Listas"


@pytest.mark.asyncio
async def test_notificacao_traz_pasta_do_documento_e_lixeira(api, admin, empresa):  # noqa: F811
    """A2-26: a notificação leva ao item (pasta do documento; lixeira se excluído)."""
    h, co = _token(empresa["user"]), empresa["co"]
    doc = await _doc(admin, empresa, empresa["sub"], "Aviso.pdf", "texto")
    for alvo, tipo in ((doc, "document"), (empresa["raiz"], "folder")):
        await admin.execute(
            "INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message) "
            "VALUES ($1, $2, 'version_added', $3, $4, 'teste')",
            empresa["user"], co, tipo, alvo,
        )
    try:
        r = await api.get(API + "/notifications", headers=h)
        assert r.status_code == 200, r.text
        por_id = {x["resource_id"]: x for x in r.json()["results"]}
        assert por_id[doc]["folder_id"] == empresa["sub"]
        assert por_id[doc]["company_id"] == co
        assert por_id[doc]["in_trash"] is False
        assert por_id[empresa["raiz"]]["folder_id"] is None
    finally:
        await admin.execute("DELETE FROM public.notifications WHERE user_id = $1", empresa["user"])


@pytest.mark.asyncio
async def test_busca_rapida_aceita_apostrofo_aspas_e_hifen(api, admin, empresa):  # noqa: F811
    """X3-06: termos com apóstrofo, aspas ou hífen solto não derrubam a busca rápida."""
    h, co = _token(empresa["user"]), empresa["co"]
    await _doc(admin, empresa, empresa["raiz"], "Conta d'água março.pdf", "conta de agua")
    for termo in ("d'água", '"', "-", "a-", "nf-e", "'", "conta d'"):
        r = await api.get(API + "/search/quick", params={"q": termo, "company_id": co}, headers=h)
        assert r.status_code == 200, (termo, r.text)
    r = await api.get(API + "/search/quick", params={"q": "d'água", "company_id": co}, headers=h)
    assert any("água" in x["name"] for x in r.json())


@pytest.mark.asyncio
async def test_verificar_integridade_resume_no_banco(api, admin, empresa):  # noqa: F811
    """X3-12: total e quebras calculados no banco; adulteração aparece."""
    h, co = _token(empresa["user"]), empresa["co"]
    ids = []
    for n in range(3):
        ids.append(await admin.fetchval(
            "INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)"
            " VALUES ($1, $2, 'view', 'document', $3, $4) RETURNING id",
            empresa["user"], co, uuid.uuid4(), f"Doc {n}",
        ))
    r = await api.get(API + "/activity/verify-integrity", params={"company_id": co}, headers=h)
    assert r.status_code == 200, r.text
    corpo = r.json()
    assert (corpo["intact"], corpo["broken_count"], corpo["first_broken"]) == (True, 0, None)
    assert corpo["total_events"] >= 3

    # Adulterar um evento direto no banco (como em test_audit_chain).
    await admin.execute("UPDATE public.activity_log SET item_name_snapshot = 'Adulterado' WHERE id = $1", ids[1])
    corpo = (await api.get(API + "/activity/verify-integrity", params={"company_id": co}, headers=h)).json()
    assert corpo["intact"] is False
    assert corpo["first_broken"]["event_id"] == str(ids[1])
    assert "adulterado" in corpo["first_broken"]["reason"].lower()


@pytest.mark.asyncio
async def test_busca_filtra_por_guarda(api, admin, empresa):  # noqa: F811
    """A7-108, B3.4.8: "sob bloqueio judicial" e "sem prazo de guarda" na busca."""
    h, co = _token(empresa["user"]), empresa["co"]
    preso = await _doc(admin, empresa, empresa["raiz"], "Contrato guarda preso.pdf", "contrato guarda teste")
    livre = await _doc(admin, empresa, empresa["raiz"], "Contrato guarda livre.pdf", "contrato guarda teste")
    hold = await admin.fetchval(
        "INSERT INTO public.legal_holds (company_id, resource_type, resource_id, reason, created_by)"
        " VALUES ($1, 'document', $2, 'Processo de teste', $3) RETURNING id",
        uuid.UUID(co), uuid.UUID(preso), uuid.UUID(empresa["user"]),
    )
    try:
        r = await api.get(API + "/search", params={"q": "guarda", "company_id": co, "guarda": "bloqueio"}, headers=h)
        assert r.status_code == 200, r.text
        assert [x["id"] for x in r.json()["results"]] == [preso]
        r = await api.get(API + "/search", params={"q": "guarda", "company_id": co, "guarda": "sem_prazo"}, headers=h)
        assert {x["id"] for x in r.json()["results"]} == {preso, livre}
        r = await api.get(API + "/search", params={"q": "guarda", "company_id": co, "guarda": "qualquer"}, headers=h)
        assert r.status_code == 422
        # Visão pronta (B4.1.4): sem termo, só o filtro.
        r = await api.get(API + "/search", params={"company_id": co, "guarda": "bloqueio"}, headers=h)
        assert r.status_code == 200, r.text
        assert [x["id"] for x in r.json()["results"]] == [preso]
        r = await api.get(API + "/search", params={"company_id": co}, headers=h)
        assert r.json()["total"] == 0
    finally:
        await admin.execute("UPDATE public.legal_holds SET released_at = now() WHERE id = $1", hold)
        await admin.execute("DELETE FROM public.legal_holds WHERE id = $1", hold)


@pytest.mark.asyncio
async def test_busca_por_competencia_e_filtros_de_texto_e_metadado(api, admin, empresa):  # noqa: F811
    """B2.2.1 (competência escrita de vários jeitos) e FA-A6-01 (texto lido e metadado)."""
    h, co = _token(empresa["user"]), empresa["co"]
    a = await _doc(admin, empresa, empresa["raiz"], "Guia FGTS.pdf", "Competência 03/2026 recolhimento")
    b = await _doc(admin, empresa, empresa["raiz"], "DAS.pdf", "Período de apuração: MARÇO DE 2026")
    c = await _doc(admin, empresa, empresa["raiz"], "Outra.pdf", "Competência 04/2026", ocr="failed")
    for termo in ("03/2026", "mar/2026", "março de 2026", "2026-03"):
        r = await api.get(API + "/search", params={"q": termo, "company_id": co}, headers=h)
        assert r.status_code == 200, (termo, r.text)
        ids = {x["id"] for x in r.json()["results"]}
        assert {a, b} <= ids and c not in ids, termo

    r = await api.get(API + "/search", params={"company_id": co, "ocr": "falhou"}, headers=h)
    assert c in [x["id"] for x in r.json()["results"]] and a not in [x["id"] for x in r.json()["results"]]

    campo = await admin.fetchval(
        "INSERT INTO public.custom_field (company_id, label, field_key, type) VALUES ($1, 'Banco', 'banco_busca', 'texto') RETURNING id", uuid.UUID(co))
    await admin.execute(
        "INSERT INTO public.document_field_value (document_id, company_id, custom_field_id, value_text) VALUES ($1, $2, $3, 'Itaú Unibanco')",
        uuid.UUID(a), uuid.UUID(co), campo)
    r = await api.get(API + "/search", params={"company_id": co, "campo": str(campo), "valor": "itau"}, headers=h)
    assert [x["id"] for x in r.json()["results"]] == [a]
    await admin.execute("DELETE FROM public.document_field_value WHERE custom_field_id = $1", campo)
    await admin.execute("DELETE FROM public.custom_field WHERE id = $1", campo)


@pytest.mark.asyncio
async def test_valor_vazio_apaga_o_metadado(api, admin, empresa):  # noqa: F811
    """B1.3.7: o desfazer do lote volta ao vazio; apagar fica na trilha."""
    h, co = _token(empresa["user"]), empresa["co"]
    doc = await _doc(admin, empresa, empresa["raiz"], "Recibo banco.pdf", "recibo")
    campo = await admin.fetchval(
        "INSERT INTO public.custom_field (company_id, label, field_key, type) VALUES ($1, 'Banco', 'banco_apagar', 'texto') RETURNING id", uuid.UUID(co))
    url = API + f"/documents/{doc}/field-values"
    assert (await api.put(url, json=[{"custom_field_id": str(campo), "value": "Itaú"}], params={"company_id": co}, headers=h)).status_code == 200
    r = await api.put(url, json=[{"custom_field_id": str(campo), "value": ""}], params={"company_id": co}, headers=h)
    assert r.status_code == 200, r.text
    assert await admin.fetchval("SELECT count(*) FROM public.document_field_value WHERE custom_field_id = $1", campo) == 0
    ev = await admin.fetchval(
        "SELECT metadata->>'old_value' FROM public.activity_log WHERE item_id = $1 AND action = 'update_metadata' AND metadata->>'new_value' IS NULL",
        uuid.UUID(doc))
    assert ev == "Itaú"
    await admin.execute("DELETE FROM public.custom_field WHERE id = $1", campo)


@pytest.mark.asyncio
async def test_tipos_de_campo_extras(api, admin, empresa):  # noqa: F811
    """B1.3.2: texto longo, data e hora, múltipla escolha e URL."""
    h, co = _token(empresa["user"]), empresa["co"]
    doc = await _doc(admin, empresa, empresa["raiz"], "Contrato extras.pdf", "contrato")
    ids = {}
    for tipo, cfg in (("url", {}), ("data_hora", {}), ("multipla", {"options": ["Itaú", "Caixa", "Bradesco"]}), ("texto_longo", {})):
        r = await api.post(API + "/custom-fields", json={"company_id": co, "label": f"Campo {tipo}", "type": tipo, "format_config": cfg}, headers=h)
        assert r.status_code in (200, 201), r.text
        ids[tipo] = r.json()["id"]
    url = API + f"/documents/{doc}/field-values"
    r = await api.put(url, params={"company_id": co}, headers=h, json=[
        {"custom_field_id": ids["url"], "value": "docke.com.br/contrato"},
        {"custom_field_id": ids["data_hora"], "value": "05/03/2026 14:30"},
        {"custom_field_id": ids["multipla"], "value": "Caixa; Itaú"},
        {"custom_field_id": ids["texto_longo"], "value": "Observação longa\ncom duas linhas"},
    ])
    assert r.status_code == 200, r.text
    vals = {x["custom_field_id"]: x["value_text"] for x in (await api.get(url, headers=h)).json()}
    assert vals[ids["url"]] == "https://docke.com.br/contrato"
    assert vals[ids["multipla"]] == "Itaú; Caixa"
    r = await api.put(url, params={"company_id": co}, headers=h, json=[{"custom_field_id": ids["multipla"], "value": "Nubank"}])
    assert r.status_code == 400
    await admin.execute("DELETE FROM public.document_field_value WHERE document_id = $1", uuid.UUID(doc))
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", uuid.UUID(co))
    for i in ids.values():
        await admin.execute("DELETE FROM public.custom_field WHERE id = $1", uuid.UUID(i))
