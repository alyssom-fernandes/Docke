"""Modelos de estrutura, documento-modelo e pacote de configuração (B1.5.4, B1.5.5, B1.5.6, B1.5.8)."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, outra, adm, func = (str(uuid.uuid4()) for _ in range(4))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Modelo'), ($2, 'Outra Modelo')", co, outra)
    for uid, nome in ((adm, "Admin Modelo"), (func, "Func Modelo")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"m_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $3, 'admin', NULL), ($2, $3, 'operador', NULL), ($1, $4, 'admin', NULL)",
        adm, func, co, outra)
    # Admissão > (Documentos pessoais, Exames), com um campo "CPF" em Documentos pessoais.
    adm_id = str(await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Admissão', 'adm') RETURNING id", co))
    await admin.execute("INSERT INTO public.folders (company_id, parent_id, name, path, sensitivity) VALUES ($1, $2, 'Documentos pessoais', 'adm.doc', 'pessoal')", co, adm_id)
    await admin.execute("INSERT INTO public.folders (company_id, parent_id, name, path) VALUES ($1, $2, 'Exames', 'adm.exa')", co, adm_id)
    campo = await admin.fetchval("INSERT INTO public.custom_field (company_id, label, field_key, type) VALUES ($1, 'CPF', 'cpf_colab', 'cpf') RETURNING id", co)
    await admin.execute("INSERT INTO public.folder_field (company_id, folder_path, custom_field_id, required, default_value) VALUES ($1, 'adm.doc', $2, true, NULL)", co, campo)
    # Pasta já existente com "Exames" dentro: o modelo aplicado nela não pode apagar nada.
    joao = str(await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'João', 'joao') RETURNING id", co))
    await admin.execute("INSERT INTO public.folders (company_id, parent_id, name, path) VALUES ($1, $2, 'Exames', 'joao.exa')", co, joao)
    await admin.execute("INSERT INTO public.folders (company_id, parent_id, name, path) VALUES ($1, $2, 'Outros', 'joao.out')", co, joao)
    yield {"co": co, "outra": outra, "adm": adm, "func": func, "admissao": adm_id, "joao": joao}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = ANY($1::uuid[])", [co, outra])
    await admin.execute("DELETE FROM public.companies WHERE id = ANY($1::uuid[])", [co, outra])
    for uid in (adm, func):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


async def _filhos(admin, co, pai):
    return sorted(r["name"] for r in await admin.fetch(
        "SELECT name FROM public.folders WHERE company_id = $1 AND parent_id = $2 AND deleted_at IS NULL", uuid.UUID(co), uuid.UUID(pai)))


@pytest.mark.asyncio
async def test_modelo_de_estrutura_salvar_aplicar_e_versionar(api, admin, cenario):  # noqa: F811
    base = API + f"/companies/{cenario['co']}/structure-templates"
    corpo = {"name": "Admissão de colaborador", "source_folder_id": cenario["admissao"]}
    assert (await api.post(base, json=corpo, headers=_token(cenario["func"]))).status_code == 403
    r = await api.post(base, json=corpo, headers=_token(cenario["adm"]))
    assert r.status_code == 201, r.text
    modelo = r.json()
    assert modelo["folders"] == 3 and modelo["fields"] == 1 and modelo["version"] == 1
    assert (await api.post(base, json=corpo, headers=_token(cenario["adm"]))).status_code == 409

    # Mesclar na pasta "João": cria só o que falta, mantém "Outros" e não duplica "Exames".
    url = API + f"/structure-templates/{modelo['id']}/apply"
    previa = await api.post(url, json={"target_folder_id": cenario["joao"], "conflito": "mesclar", "dry_run": True}, headers=_token(cenario["adm"]))
    assert previa.status_code == 200, previa.text
    assert previa.json()["criadas"] == ["Documentos pessoais"] and await _filhos(admin, cenario["co"], cenario["joao"]) == ["Exames", "Outros"]
    r = await api.post(url, json={"target_folder_id": cenario["joao"], "conflito": "mesclar"}, headers=_token(cenario["adm"]))
    assert r.status_code == 200, r.text
    assert await _filhos(admin, cenario["co"], cenario["joao"]) == ["Documentos pessoais", "Exames", "Outros"]
    nova = await admin.fetchrow(
        "SELECT path::text, sensitivity FROM public.folders WHERE parent_id = $1 AND name = 'Documentos pessoais'", uuid.UUID(cenario["joao"]))
    assert nova["sensitivity"] == "pessoal"
    assert await admin.fetchval(
        "SELECT required FROM public.folder_field WHERE company_id = $1 AND folder_path = $2::ltree", uuid.UUID(cenario["co"]), nova["path"]) is True

    # Criar no topo com nome repetido: "renomear" cria "Admissão (1)"; "pular" não cria nada.
    r = await api.post(url, json={"target_parent_id": None, "conflito": "renomear"}, headers=_token(cenario["adm"]))
    assert r.json()["criadas"][0] == "Admissão (1)"
    r = await api.post(url, json={"conflito": "pular"}, headers=_token(cenario["adm"]))
    assert r.json()["criadas"] == [] and r.json()["puladas"] == ["Admissão"]

    # Regravar a partir de outra pasta cria a versão 2 e guarda a 1; restaurar volta a árvore antiga como versão 3.
    r = await api.put(API + f"/structure-templates/{modelo['id']}", json={"source_folder_id": cenario["joao"]}, headers=_token(cenario["adm"]))
    assert r.status_code == 200 and r.json()["version"] == 2
    det = (await api.get(API + f"/structure-templates/{modelo['id']}", headers=_token(cenario["adm"]))).json()
    assert [v["version"] for v in det["versions"]] == [1]
    r = await api.post(API + f"/structure-templates/{modelo['id']}/restore/1", headers=_token(cenario["adm"]))
    assert r.json()["version"] == 3 and r.json()["folders"] == 3

    # Operador não aplica modelo.
    assert (await api.post(url, json={"target_folder_id": cenario["joao"]}, headers=_token(cenario["func"]))).status_code == 403


@pytest.mark.asyncio
async def test_pacote_de_configuracao_exporta_e_importa(api, admin, cenario):  # noqa: F811
    await api.post(API + f"/companies/{cenario['co']}/structure-templates",
                   json={"name": "Pacote", "source_folder_id": cenario["admissao"]}, headers=_token(cenario["adm"]))
    r = await api.get(API + f"/companies/{cenario['co']}/config-package", headers=_token(cenario["adm"]))
    assert r.status_code == 200, r.text
    pacote = r.json()
    assert pacote["formato"] == "docke-configuracao" and any(c["field_key"] == "cpf_colab" for c in pacote["campos"])
    assert {p["name"] for p in pacote["pastas"]} >= {"Admissão", "João"}
    assert (await api.get(API + f"/companies/{cenario['co']}/config-package", headers=_token(cenario["func"]))).status_code == 403

    url = API + f"/companies/{cenario['outra']}/config-package"
    previa = await api.post(url, json={"pacote": pacote, "incluir_pastas": True, "dry_run": True}, headers=_token(cenario["adm"]))
    assert previa.status_code == 200, previa.text
    assert previa.json()["campos_criados"] >= 1 and previa.json()["pastas"]["criadas"] >= 3
    assert await admin.fetchval("SELECT count(*) FROM public.folders WHERE company_id = $1", uuid.UUID(cenario["outra"])) == 0

    r = await api.post(url, json={"pacote": pacote, "incluir_pastas": True}, headers=_token(cenario["adm"]))
    assert r.status_code == 200, r.text
    assert await admin.fetchval("SELECT count(*) FROM public.structure_templates WHERE company_id = $1", uuid.UUID(cenario["outra"])) >= 1
    assert await admin.fetchval("SELECT count(*) FROM public.folders WHERE company_id = $1 AND name = 'Documentos pessoais'", uuid.UUID(cenario["outra"])) >= 1
    # Importar de novo não duplica nada.
    r2 = (await api.post(url, json={"pacote": pacote, "incluir_pastas": True}, headers=_token(cenario["adm"]))).json()
    assert r2["campos_criados"] == 0 and r2["modelos_criados"] == 0 and r2["pastas"]["criadas"] == 0
    ruim = await api.post(url, json={"pacote": {"formato": "outro"}}, headers=_token(cenario["adm"]))
    assert ruim.status_code == 422


@pytest.mark.asyncio
async def test_documento_modelo_nasce_com_metadados(api, admin, cenario):  # noqa: F811
    co = uuid.UUID(cenario["co"])
    doc = await admin.fetchval(
        """
        INSERT INTO public.documents (folder_id, company_id, name, mime_type, file_type, size_bytes, storage_path, content_hash, uploaded_by)
        VALUES ($1, $2, 'Contrato padrão.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', 10, 'x/modelo.docx', 'abc', $3)
        RETURNING id
        """,
        uuid.UUID(cenario["admissao"]), co, uuid.UUID(cenario["adm"]))
    campo = await admin.fetchval("SELECT id FROM public.custom_field WHERE company_id = $1 AND field_key = 'cpf_colab'", co)
    await admin.execute("INSERT INTO public.document_field_value (company_id, document_id, custom_field_id, value_text) VALUES ($1, $2, $3, '000.000.000-00')", co, doc, campo)

    assert (await api.put(API + f"/documents/{doc}/template", json={"is_template": True}, headers=_token(cenario["func"]))).status_code == 403
    assert (await api.put(API + f"/documents/{doc}/template", json={"is_template": True}, headers=_token(cenario["adm"]))).status_code == 200
    lista = (await api.get(API + f"/companies/{cenario['co']}/document-templates", headers=_token(cenario["func"]))).json()
    assert lista[0]["name"] == "Contrato padrão.docx" and lista[0]["fields"][0]["value"] == "000.000.000-00"

    from unittest.mock import patch
    with patch("app.services.storage_service.copy_object"):
        r = await api.post(API + f"/document-templates/{doc}/new", json={"folder_id": cenario["joao"], "name": "Contrato João"}, headers=_token(cenario["func"]))
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "Contrato João.docx" and r.json()["fields_copied"] == 1
    assert await admin.fetchval("SELECT value_text FROM public.document_field_value WHERE document_id = $1::uuid", r.json()["id"]) == "000.000.000-00"
