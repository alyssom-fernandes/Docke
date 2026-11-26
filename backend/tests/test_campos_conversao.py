"""
Trocar o tipo de um campo convertendo valores (B1.3.10), aplicar o valor
padrão aos documentos existentes (FA-A8-09) e prévia de impacto ao excluir
grupo (B3.1.5).
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, adm, func = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Campos')", co)
    for uid, nome in ((adm, "Admin Campos"), (func, "Func Campos")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"c_{uid[:6]}", nome)
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", adm, co)
    pasta = await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Notas', 'notas') RETURNING id", co)
    sub = await admin.fetchval("INSERT INTO public.folders (company_id, name, path) VALUES ($1, 'Antigas', 'notas.antigas') RETURNING id", co)
    docs = []
    for i, f in enumerate((pasta, pasta, pasta, sub)):
        docs.append(await admin.fetchval(
            """
            INSERT INTO public.documents (company_id, folder_id, name, storage_path, mime_type, file_type, size_bytes, content_hash, uploaded_by)
            VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, $5, $6) RETURNING id
            """, co, f, f"doc{i}.pdf", f"x/{co}/{i}", f"h-{co}-{i}", adm))
    campo = await admin.fetchval(
        "INSERT INTO public.custom_field (company_id, label, field_key, type) VALUES ($1, 'Valor', 'valor', 'texto') RETURNING id", co)
    for d, v in ((docs[0], "1.234,50"), (docs[1], "abc")):
        await admin.execute(
            "INSERT INTO public.document_field_value (document_id, company_id, custom_field_id, value_text) VALUES ($1, $2, $3, $4)",
            d, co, campo, v)
    yield {"co": co, "adm": adm, "func": func, "campo": str(campo), "pasta": pasta, "sub": sub, "docs": docs}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.documents WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (adm, func):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_trocar_tipo_com_previa(api, admin, cenario):  # noqa: F811
    h = _token(cenario["adm"])
    url = API + f"/custom-fields/{cenario['campo']}/change-type"
    r = await api.post(url, json={"new_type": "numero"}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["convertidos"] == 1 and r.json()["perdidos"] == 1 and r.json()["aplicado"] is False
    assert await admin.fetchval("SELECT type FROM public.custom_field WHERE id = $1", uuid.UUID(cenario["campo"])) == "texto"
    r = await api.post(url, json={"new_type": "numero", "aplicar": True}, headers=h)
    assert r.status_code == 200 and r.json()["aplicado"] is True
    vals = await admin.fetch("SELECT value_text, value_number FROM public.document_field_value WHERE custom_field_id = $1", uuid.UUID(cenario["campo"]))
    assert [(v["value_text"], float(v["value_number"])) for v in vals] == [("1234.50", 1234.5)]


@pytest.mark.asyncio
async def test_aplicar_padrao_aos_existentes(api, admin, cenario):  # noqa: F811
    h = _token(cenario["adm"])
    campo = await admin.fetchval(
        "INSERT INTO public.custom_field (company_id, label, field_key, type) VALUES ($1, 'Setor', 'setor_x', 'texto') RETURNING id", cenario["co"])
    regra = await admin.fetchval(
        "INSERT INTO public.folder_field (company_id, folder_path, custom_field_id, default_value) VALUES ($1, 'notas', $2, 'Fiscal') RETURNING id",
        cenario["co"], campo)
    # A subpasta tem regra própria: fica de fora.
    await admin.execute(
        "INSERT INTO public.folder_field (company_id, folder_path, custom_field_id, default_value) VALUES ($1, 'notas.antigas', $2, 'Arquivo')",
        cenario["co"], campo)
    await admin.execute(
        "INSERT INTO public.document_field_value (document_id, company_id, custom_field_id, value_text) VALUES ($1, $2, $3, 'Outro')",
        cenario["docs"][0], cenario["co"], campo)
    url = API + f"/folder-fields/{regra}/apply-default"
    r = await api.post(url, json={"modo": "vazios"}, headers=h)
    assert r.status_code == 200, r.text
    assert (r.json()["documentos"], r.json()["vazios"], r.json()["diferentes"], r.json()["vao_mudar"]) == (3, 2, 1, 2)
    r = await api.post(url, json={"modo": "vazios", "aplicar": True}, headers=h)
    assert r.json()["aplicado"] is True
    vals = sorted(v["value_text"] for v in await admin.fetch("SELECT value_text FROM public.document_field_value WHERE custom_field_id = $1", campo))
    assert vals == ["Fiscal", "Fiscal", "Outro"]


@pytest.mark.asyncio
async def test_impacto_de_excluir_grupo(api, admin, cenario):  # noqa: F811
    co = cenario["co"]
    grupo = await admin.fetchval("INSERT INTO public.\"group\" (company_id, name) VALUES ($1, 'Fiscal') RETURNING id", co)
    await admin.execute("INSERT INTO public.group_member (group_id, user_id) VALUES ($1, $2), ($1, $3)", grupo, cenario["func"], cenario["adm"])
    await admin.execute("INSERT INTO public.group_access (group_id, company_id, permission_level) VALUES ($1, $2, 'visualizador')", grupo, co)
    r = await api.get(API + f"/companies/{co}/groups/{grupo}/impact", headers=_token(cenario["adm"]))
    assert r.status_code == 200, r.text
    # O admin tem acesso direto; o funcionário só tinha o do grupo.
    assert r.json() == {"membros": 2, "ficam_sem_acesso": ["Func Campos"]}
