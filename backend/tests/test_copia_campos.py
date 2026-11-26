"""Copiar campos de metadados com prévia, escolha e relatório (A8-28)."""
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


async def _campo(admin, co, user, label, key, path=None):
    fid = await admin.fetchval(
        """
        INSERT INTO public.custom_field (company_id, label, field_key, type, format_config, created_by)
        VALUES ($1, $2, $3, 'texto', '{}'::jsonb, $4) RETURNING id::text
        """,
        uuid.UUID(co), label, key, uuid.UUID(user),
    )
    await admin.execute(
        """
        INSERT INTO public.folder_field (company_id, folder_path, custom_field_id, mode, required, display_order, created_by)
        VALUES ($1, $2::ltree, $3::uuid, 'apply', true, 0, $4)
        """,
        uuid.UUID(co), path, fid, uuid.UUID(user),
    )
    return fid


@pytest.mark.asyncio
async def test_copia_campos_com_previa_escolha_e_pastas_de_mesmo_nome(api, admin, empresa):  # noqa: F811
    h, co, user = _token(empresa["user"]), empresa["co"], empresa["user"]
    # Empresa B com a mesma estrutura de nomes (Fiscal / Notas), mas outros caminhos.
    co_b = str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa B Cópia')", co_b)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", user, co_b,
    )
    rb = "b" + uuid.uuid4().hex[:10]
    fiscal_b, notas_b = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, path, name, created_by) VALUES ($1, $2, $3::ltree, 'Fiscal', $4)",
        fiscal_b, co_b, rb, user,
    )
    notas_b_path = rb + ".n" + uuid.uuid4().hex[:8]
    await admin.execute(
        "INSERT INTO public.folders (id, company_id, parent_id, path, name, created_by) VALUES ($1, $2, $3, $4::ltree, 'Notas', $5)",
        notas_b, co_b, fiscal_b, notas_b_path, user,
    )
    try:
        sub_path = await admin.fetchval("SELECT path::text FROM public.folders WHERE id = $1", uuid.UUID(empresa["sub"]))
        cnpj = await _campo(admin, co, user, "CNPJ do fornecedor", "cnpj_fornecedor", sub_path)
        await _campo(admin, co, user, "Banco", "banco")  # empresa toda
        # B já tem "banco": não duplica.
        await admin.execute(
            "INSERT INTO public.custom_field (company_id, label, field_key, type, format_config, created_by) VALUES ($1, 'Banco', 'banco', 'texto', '{}'::jsonb, $2)",
            uuid.UUID(co_b), uuid.UUID(user),
        )

        r = await api.post(API + "/custom-fields/copy/preview", json={"source_company_id": co, "target_company_id": co_b}, headers=h)
        assert r.status_code == 200, r.text
        prev = {c["label"]: c for c in r.json()}
        assert prev["CNPJ do fornecedor"]["existe"] is False and prev["CNPJ do fornecedor"]["aplicacoes_com_pasta"] == 1
        assert prev["Banco"]["existe"] is True

        r = await api.post(API + "/custom-fields/copy-selected",
                           json={"source_company_id": co, "target_company_id": co_b, "field_ids": [cnpj], "include_tree": True},
                           headers=h)
        assert r.status_code == 200, r.text
        rel = r.json()
        assert rel == {"criados": ["CNPJ do fornecedor"], "existentes": [], "aplicacoes_copiadas": 1, "aplicacoes_sem_pasta": 0}
        assert await admin.fetchval(
            """
            SELECT count(*) FROM public.folder_field ff JOIN public.custom_field cf ON cf.id = ff.custom_field_id
            WHERE ff.company_id = $1 AND ff.folder_path = $2::ltree AND cf.field_key = 'cnpj_fornecedor'
            """,
            uuid.UUID(co_b), notas_b_path,
        ) == 1

        # Regras de uma pasta para outra na mesma empresa.
        r = await api.post(API + "/folder-fields/copy",
                           json={"company_id": co, "source_folder_id": empresa["sub"], "target_folder_id": empresa["raiz"]}, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["regras_copiadas"] == 1
        r = await api.post(API + "/folder-fields/copy",
                           json={"company_id": co, "source_folder_id": empresa["sub"], "target_folder_id": empresa["sub"]}, headers=h)
        assert r.status_code == 422
    finally:
        await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", uuid.UUID(co_b))
        await admin.execute("DELETE FROM public.companies WHERE id = $1", uuid.UUID(co_b))
