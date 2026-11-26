"""
Alcance das rotas administrativas (achado A9-40 da avaliação de 25/11/2026).

As rotas /admin/* usam a conexão administrativa, que passa por cima do RLS.
Até a correção, bastava o papel GLOBAL 'admin' (que a conta demo pública tinha)
para listar todas as empresas e usuários e se conceder acesso em qualquer
empresa do banco. Agora o que alcança o sistema inteiro é só do Supremo, e o
que alcança uma empresa exige ser admin da empresa toda nela. Criar empresa
também passou a ser só do Supremo (A1-22).

Os testes chamam a API de verdade (httpx + ASGI), com tokens HS256 assinados
com o JWT_SECRET local, e gravam dados reais que são apagados no fim (as rotas
pegam conexões próprias do pool, então não dá para usar uma transação revertida).
"""
import os
import uuid

import asyncpg
import httpx
import pytest
import pytest_asyncio
from jose import jwt

from app import dependencies as deps
from app.config import settings
from app.main import app

API = "/api/v1"
DB_URL = os.environ["DATABASE_URL"].replace("postgresql+asyncpg://", "postgresql://")


def _token(user_id: str, aal: str = "aal2") -> dict[str, str]:
    claims = {"sub": user_id, "role": "authenticated", "aud": "authenticated", "aal": aal}
    return {"Authorization": f"Bearer {jwt.encode(claims, settings.JWT_SECRET, algorithm='HS256')}"}


@pytest_asyncio.fixture(loop_scope="session")
async def api():
    """Cliente HTTP da API com o pool do app apontado para o banco local."""
    pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=5)
    previous = deps._pool
    deps._pool = pool
    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
    finally:
        deps._pool = previous
        await pool.close()


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    """
    Empresas A e B. Usuários:
    - supremo: papel global supremo;
    - admin_a: admin da empresa toda em A (papel global 'usuario', o normal);
    - legado: papel global 'admin' (como a conta demo tinha), admin só de A;
    - membro_a: visualizador em A;
    - de_fora: admin de B.
    """
    co_a, co_b = str(uuid.uuid4()), str(uuid.uuid4())
    ids = {k: str(uuid.uuid4()) for k in ("supremo", "admin_a", "legado", "membro_a", "de_fora")}
    papel_global = {"supremo": "supremo", "admin_a": "usuario", "legado": "admin", "membro_a": "usuario", "de_fora": "usuario"}

    await admin.execute(
        "INSERT INTO public.companies (id, name) VALUES ($1, 'Escopo Admin A'), ($2, 'Escopo Admin B')", co_a, co_b
    )
    for nome, uid in ids.items():
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute(
            "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, $4)",
            uid, f"{nome}_{uid[:6]}", f"Teste {nome}", papel_global[nome],
        )
    for uid, co, nivel in (
        (ids["admin_a"], co_a, "admin"),
        (ids["legado"], co_a, "admin"),
        (ids["membro_a"], co_a, "visualizador"),
        (ids["de_fora"], co_b, "admin"),
    ):
        await admin.execute(
            "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, $3)",
            uid, co, nivel,
        )

    yield {"co_a": co_a, "co_b": co_b, **ids}

    todos = list(ids.values())
    # Inclui a empresa que o Supremo cria no teste, se ele falhar antes de apagá-la.
    empresas = [co_a, co_b] + [
        str(r["company_id"]) for r in await admin.fetch(
            "SELECT company_id FROM public.user_company_access WHERE user_id = ANY($1::uuid[])", todos
        )
    ]
    await admin.execute("DELETE FROM public.user_company_access WHERE user_id = ANY($1::uuid[])", todos)
    await admin.execute("DELETE FROM public.companies WHERE id = ANY($1::uuid[])", list(set(empresas)))
    await admin.execute("DELETE FROM public.users WHERE id = ANY($1::uuid[])", todos)
    await admin.execute("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", todos)


@pytest.mark.asyncio
async def test_rotas_globais_so_para_o_supremo(api, cenario):
    for quem in ("admin_a", "legado"):
        for rota in ("/admin/users", "/admin/storage-usage"):
            r = await api.get(API + rota, headers=_token(cenario[quem]))
            assert r.status_code == 403, (quem, rota, r.text)

    r = await api.get(API + "/admin/storage-usage", headers=_token(cenario["supremo"]))
    assert r.status_code == 200
    empresas = {row["company_id"] for row in r.json()}
    assert {cenario["co_a"], cenario["co_b"]} <= empresas

    r = await api.get(API + "/admin/users", headers=_token(cenario["supremo"]))
    assert r.status_code == 200
    assert cenario["de_fora"] in {row["id"] for row in r.json()}


@pytest.mark.asyncio
async def test_rotas_da_empresa_so_para_o_admin_dela(api, cenario):
    r = await api.get(API + "/admin/users", params={"company_id": cenario["co_a"]}, headers=_token(cenario["admin_a"]))
    assert r.status_code == 200
    assert cenario["membro_a"] in {row["id"] for row in r.json()}

    for quem in ("admin_a", "legado", "membro_a"):
        for rota in ("/admin/users", "/admin/permissions", "/admin/storage-usage"):
            r = await api.get(API + rota, params={"company_id": cenario["co_b"]}, headers=_token(cenario[quem]))
            assert r.status_code == 403, (quem, rota, r.text)

    # Visualizador da própria empresa também não lista concessões.
    r = await api.get(API + "/admin/permissions", params={"company_id": cenario["co_a"]}, headers=_token(cenario["membro_a"]))
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_ninguem_se_concede_acesso_em_outra_empresa(api, admin, cenario):
    for quem in ("admin_a", "legado"):
        r = await api.post(
            API + "/admin/permissions",
            json={"user_id": cenario[quem], "company_id": cenario["co_b"], "permission_level": "admin"},
            headers=_token(cenario[quem]),
        )
        assert r.status_code == 403, (quem, r.text)
        assert not await admin.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)",
            cenario[quem], cenario["co_b"],
        )


@pytest.mark.asyncio
async def test_admin_da_empresa_concede_so_a_membros_dela(api, admin, cenario):
    # Membro de A: a concessão da empresa toda é atualizada (ON CONFLICT do índice parcial).
    r = await api.post(
        API + "/admin/permissions",
        json={"user_id": cenario["membro_a"], "company_id": cenario["co_a"], "permission_level": "operador"},
        headers=_token(cenario["admin_a"]),
    )
    assert r.status_code == 201, r.text
    nivel = await admin.fetchval(
        "SELECT permission_level FROM public.user_company_access WHERE user_id = $1 AND company_id = $2 AND folder_path IS NULL",
        cenario["membro_a"], cenario["co_a"],
    )
    assert nivel == "operador"

    # Usuário de outra empresa: trazer para A é decisão do Supremo.
    r = await api.post(
        API + "/admin/permissions",
        json={"user_id": cenario["de_fora"], "company_id": cenario["co_a"], "permission_level": "visualizador"},
        headers=_token(cenario["admin_a"]),
    )
    assert r.status_code == 404, r.text

    # Pasta de outra empresa (ou inexistente) não vale.
    r = await api.post(
        API + "/admin/permissions",
        json={"user_id": cenario["membro_a"], "company_id": cenario["co_a"], "permission_level": "visualizador",
              "folder_path": "pasta_que_nao_existe"},
        headers=_token(cenario["admin_a"]),
    )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_criar_empresa_so_o_supremo(api, admin, cenario):
    for quem in ("admin_a", "legado", "membro_a"):
        r = await api.post(API + "/companies", json={"name": f"Empresa de {quem}"}, headers=_token(cenario[quem]))
        assert r.status_code == 403, (quem, r.text)

    r = await api.post(API + "/companies", json={"name": "Empresa do Supremo (teste)"}, headers=_token(cenario["supremo"]))
    assert r.status_code == 201, r.text
    await admin.execute("DELETE FROM public.companies WHERE id = $1", r.json()["id"])


@pytest.mark.asyncio
async def test_reset_da_demo_nao_roda_em_paralelo(admin_pool, monkeypatch):
    """Com o lock tomado por outra sessão, o reset desiste sem tocar em nada."""
    from app.seed import demo_reset_service

    monkeypatch.setattr(demo_reset_service, "DEMO_USER_PASSWORD", "senha-de-teste")
    chamou = []

    async def _nao_deveria_rodar(_conn):
        chamou.append(True)

    monkeypatch.setattr(demo_reset_service, "_reset_locked", _nao_deveria_rodar)

    async with admin_pool.acquire() as dono_do_lock, admin_pool.acquire() as outra:
        await dono_do_lock.execute("SELECT pg_advisory_lock($1)", demo_reset_service._RESET_LOCK_KEY)
        try:
            assert await demo_reset_service.reset_demo_data(outra) is False
        finally:
            await dono_do_lock.execute("SELECT pg_advisory_unlock($1)", demo_reset_service._RESET_LOCK_KEY)
        assert chamou == []

        # Lock livre: roda e devolve o lock no fim.
        assert await demo_reset_service.reset_demo_data(outra) is True
        assert chamou == [True]
        assert await dono_do_lock.fetchval("SELECT pg_try_advisory_lock($1)", demo_reset_service._RESET_LOCK_KEY)
        await dono_do_lock.execute("SELECT pg_advisory_unlock($1)", demo_reset_service._RESET_LOCK_KEY)


@pytest.mark.asyncio
async def test_seed_deixa_a_conta_demo_com_papel_usuario(admin_pool, monkeypatch):
    """Mesmo que a conta demo esteja com papel global 'admin', o seed volta para 'usuario'."""
    from app.seed import demo_data

    monkeypatch.setattr(demo_data.storage_service, "put_object_bytes", lambda *a, **k: None)
    demo_id, op_id, vis_id = (str(uuid.uuid4()) for _ in range(3))
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            for uid in (demo_id, op_id, vis_id):
                await conn.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
            await conn.execute(
                "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Demo antiga', 'admin')",
                demo_id, f"demo_antiga_{demo_id[:6]}",
            )
            extra = {email: uid for (email, *_), uid in zip(demo_data.EXTRA_USERS, (op_id, vis_id))}
            # O seed usa username fixo ('demo'); se a base de teste já tiver um, ele sai antes.
            await conn.execute(
                "DELETE FROM public.users WHERE username = ANY($1::text[]) AND id <> ALL($2::uuid[])",
                [demo_data.DEMO_USER_USERNAME] + [u for _e, u, _n, _p in demo_data.EXTRA_USERS],
                [demo_id, op_id, vis_id],
            )
            await demo_data._build_demo_data(conn, demo_id, extra)
            assert await conn.fetchval("SELECT role FROM public.users WHERE id = $1", demo_id) == "usuario"
            niveis = await conn.fetch(
                "SELECT permission_level FROM public.user_company_access WHERE user_id = $1", demo_id
            )
            assert [r["permission_level"] for r in niveis] == ["admin"] * 3
        finally:
            await tr.rollback()
