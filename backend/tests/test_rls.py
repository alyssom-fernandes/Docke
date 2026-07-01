"""
M4.11 — T1: RLS isolamento entre empresas.

Verifica que user_a não vê dados da Empresa B e vice-versa,
usando conexões autenticadas com claims JWT reais.
"""
import json
import uuid

import asyncpg
import pytest
import pytest_asyncio


async def _rls_conn(pool: asyncpg.Pool, user_id: str) -> asyncpg.Connection:
    claims = json.dumps({"sub": user_id, "role": "authenticated"})
    conn = await pool.acquire()
    await conn.execute("BEGIN")
    await conn.execute("SET LOCAL role TO authenticated")
    await conn.execute("SELECT set_config('request.jwt.claims', $1, true)", claims)
    return conn


@pytest.mark.asyncio
async def test_rls_company_isolation(admin, rls_pool, two_companies):
    """user_a vê apenas dados da Empresa A; user_b vê apenas dados da Empresa B."""
    co_a = two_companies["co_a"]
    co_b = two_companies["co_b"]
    user_a = two_companies["user_a"]
    user_b = two_companies["user_b"]

    # Insere uma pasta em cada empresa (via admin — service_role)
    folder_a = str(uuid.uuid4())
    folder_b = str(uuid.uuid4())
    await admin.execute(
        "INSERT INTO public.folders (id, name, company_id, path) VALUES ($1, 'Pasta A', $2, $3::ltree)",
        folder_a, co_a, f"f{folder_a.replace('-', '')}"
    )
    await admin.execute(
        "INSERT INTO public.folders (id, name, company_id, path) VALUES ($1, 'Pasta B', $2, $3::ltree)",
        folder_b, co_b, f"f{folder_b.replace('-', '')}"
    )

    conn_a = await _rls_conn(rls_pool, user_a)
    conn_b = await _rls_conn(rls_pool, user_b)

    try:
        # user_a vê pasta_a, não vê pasta_b
        rows_a = await conn_a.fetch("SELECT id FROM public.folders WHERE company_id = $1", co_a)
        rows_a_ids = [str(r["id"]) for r in rows_a]
        assert folder_a in rows_a_ids, "user_a deve ver pasta da Empresa A"

        rows_b_from_a = await conn_a.fetch("SELECT id FROM public.folders WHERE company_id = $1", co_b)
        assert len(rows_b_from_a) == 0, "user_a NÃO deve ver pastas da Empresa B"

        # user_b vê pasta_b, não vê pasta_a
        rows_b = await conn_b.fetch("SELECT id FROM public.folders WHERE company_id = $1", co_b)
        rows_b_ids = [str(r["id"]) for r in rows_b]
        assert folder_b in rows_b_ids, "user_b deve ver pasta da Empresa B"

        rows_a_from_b = await conn_b.fetch("SELECT id FROM public.folders WHERE company_id = $1", co_a)
        assert len(rows_a_from_b) == 0, "user_b NÃO deve ver pastas da Empresa A"

    finally:
        await conn_a.execute("ROLLBACK")
        await conn_b.execute("ROLLBACK")
        await rls_pool.release(conn_a)
        await rls_pool.release(conn_b)
        # cleanup folders
        await admin.execute("DELETE FROM public.folders WHERE id IN ($1, $2)", folder_a, folder_b)
