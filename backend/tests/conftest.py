"""
Fixtures compartilhadas para os testes de integração do Docke.

Requerem o Supabase local em execução (supabase start) e variáveis de ambiente
configuradas em backend/.env (DATABASE_URL, SUPABASE_SERVICE_ROLE_KEY, etc.).

Cada teste recebe conexões reais ao banco (asyncpg) e opera com usuários fictícios
cujos JWTs são forjados para simular diferentes papéis (viewer/editor/manager)
dentro de empresas distintas — garantindo isolamento RLS real.
"""
import asyncio
import os
import uuid
from typing import AsyncGenerator

import asyncpg
import pytest
import pytest_asyncio
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

DB_URL: str = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")
SERVICE_ROLE_KEY: str = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")


# ─── Pool helpers ─────────────────────────────────────────────────────────────

@pytest_asyncio.fixture(scope="session")
async def admin_pool() -> AsyncGenerator[asyncpg.Pool, None]:
    """Pool service_role — bypassa RLS."""
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=3)
    yield pool
    await pool.close()


@pytest_asyncio.fixture(loop_scope="session")
async def admin(admin_pool: asyncpg.Pool) -> asyncpg.Connection:
    async with admin_pool.acquire() as conn:
        yield conn


async def _make_auth_conn(pool: asyncpg.Pool, user_id: str, role: str = "authenticated") -> asyncpg.Connection:
    """Abre conexão com claims JWT simulados — RLS ativo."""
    import json
    claims = json.dumps({"sub": user_id, "role": role})
    conn = await pool.acquire()
    await conn.execute("BEGIN")
    await conn.execute(f"SET LOCAL role TO {role}")
    await conn.execute(
        "SELECT set_config('request.jwt.claims', $1, true)", claims
    )
    return conn


@pytest_asyncio.fixture(loop_scope="session")
async def rls_pool() -> AsyncGenerator[asyncpg.Pool, None]:
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=5)
    yield pool
    await pool.close()


# ─── Seed helpers ─────────────────────────────────────────────────────────────

@pytest_asyncio.fixture(loop_scope="session")
async def two_companies(admin: asyncpg.Connection):
    """Cria 2 empresas, 2 usuários (um por empresa), retorna IDs."""
    co_a = str(uuid.uuid4())
    co_b = str(uuid.uuid4())
    user_a = str(uuid.uuid4())
    user_b = str(uuid.uuid4())

    await admin.execute(
        "INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa A'), ($2, 'Empresa B')",
        co_a, co_b,
    )
    await admin.execute(
        "INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)",
        user_a, f"{user_a[:8]}@test.local",
        user_b, f"{user_b[:8]}@test.local",
    )
    await admin.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'User A', 'usuario'), ($3, $4, 'User B', 'usuario')",
        user_a, f"user_a_{user_a[:6]}",
        user_b, f"user_b_{user_b[:6]}",
    )
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin'), ($3, $4, 'admin')",
        user_a, co_a,
        user_b, co_b,
    )

    yield {"co_a": co_a, "co_b": co_b, "user_a": user_a, "user_b": user_b}

    # Cleanup
    await admin.execute("DELETE FROM public.user_company_access WHERE company_id IN ($1, $2)", co_a, co_b)
    await admin.execute("DELETE FROM public.users WHERE id IN ($1, $2)", user_a, user_b)
    await admin.execute("DELETE FROM auth.users WHERE id IN ($1, $2)", user_a, user_b)
    await admin.execute("DELETE FROM public.companies WHERE id IN ($1, $2)", co_a, co_b)
