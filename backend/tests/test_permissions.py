"""
M4.11 — T2: Resolução de permissão por especificidade (R5).

Verifica que `user_has_access` retorna o nível de acesso do caminho
mais específico (nlevel mais alto) quando há múltiplos grants sobrepostos.
"""
import uuid

import asyncpg
import pytest


@pytest.mark.asyncio
async def test_permission_specificity(admin, two_companies):
    """
    user_a tem:
      - viewer na raiz da Empresa A (folder_path IS NULL)
      - editor na pasta /docs
      - manager na pasta /docs/fiscal

    Espera-se que:
      - user_has_access(user_a, /docs/fiscal/nf.pdf, co_a) → 'manager'
      - user_has_access(user_a, /docs/contratos, co_a)    → 'editor'
      - user_has_access(user_a, /outros, co_a)             → 'viewer'
    """
    co_a = two_companies["co_a"]
    user_a = two_companies["user_a"]

    # Cria pastas com paths ltree
    f_docs = str(uuid.uuid4())
    f_fiscal = str(uuid.uuid4())
    path_docs = f"fdocs{f_docs.replace('-','')[:12]}"
    path_fiscal = f"{path_docs}.ffiscal{f_fiscal.replace('-','')[:8]}"

    await admin.execute(
        "INSERT INTO public.folders (id, name, company_id, path) VALUES ($1, 'Docs', $2, $3::ltree), ($4, 'Fiscal', $2, $5::ltree)",
        f_docs, co_a, path_docs, f_fiscal, path_fiscal,
    )

    # Configura grants por especificidade
    # (remove o grant geral de manager criado no fixture, substitui por viewer)
    await admin.execute(
        "UPDATE public.user_company_access SET permission_level = 'viewer', folder_path = NULL WHERE user_id = $1 AND company_id = $2",
        user_a, co_a,
    )
    # Grant editor em /docs
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, folder_path, permission_level) VALUES ($1, $2, $3::ltree, 'editor')",
        user_a, co_a, path_docs,
    )
    # Grant manager em /docs/fiscal
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, folder_path, permission_level) VALUES ($1, $2, $3::ltree, 'manager')",
        user_a, co_a, path_fiscal,
    )

    path_nf = f"{path_fiscal}.nf001"
    path_contratos = f"{path_docs}.contratos"
    path_outros = "outros001"

    result_manager = await admin.fetchval(
        "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
        user_a, path_nf, co_a,
    )
    result_editor = await admin.fetchval(
        "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
        user_a, path_contratos, co_a,
    )
    result_viewer = await admin.fetchval(
        "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
        user_a, path_outros, co_a,
    )

    assert result_manager == "manager", f"Esperado 'manager', recebeu: {result_manager}"
    assert result_editor == "editor", f"Esperado 'editor', recebeu: {result_editor}"
    assert result_viewer == "viewer", f"Esperado 'viewer', recebeu: {result_viewer}"

    # Cleanup
    await admin.execute(
        "DELETE FROM public.user_company_access WHERE user_id = $1 AND folder_path IS NOT NULL",
        user_a,
    )
    await admin.execute(
        "UPDATE public.user_company_access SET permission_level = 'manager' WHERE user_id = $1 AND company_id = $2",
        user_a, co_a,
    )
    await admin.execute("DELETE FROM public.folders WHERE id IN ($1, $2)", f_docs, f_fiscal)
