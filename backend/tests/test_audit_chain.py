"""
Trilha de auditoria encadeada (activity_log + activity_log_verify_chain).

Tudo roda numa transação revertida no fim — o trigger de hash, a tabela de
elos (activity_log_chain) e os eventos somem junto, sem sujar o banco local.
UPDATE/DELETE direto como superusuário simula exatamente quem a cadeia deve
pegar: alguém com acesso ao banco mexendo no histórico por fora da API.
"""
import json
import uuid

import asyncpg
import pytest


async def _setup_company(conn: asyncpg.Connection) -> tuple[str, str]:
    company_id = str(uuid.uuid4())
    user_id = str(uuid.uuid4())
    await conn.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Trilha')", company_id)
    await conn.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user_id, f"{user_id[:8]}@test.local")
    await conn.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Usuário Trilha', 'usuario')",
        user_id, f"trilha_{user_id[:6]}",
    )
    return company_id, user_id


async def _log(conn: asyncpg.Connection, company_id: str, user_id: str, name: str, hours_ago: int) -> str:
    """Grava um evento com created_at explícito (como o seed da demo faz)."""
    return str(await conn.fetchval(
        """
        INSERT INTO public.activity_log
          (user_id, company_id, action, item_type, item_id, item_name_snapshot, created_at)
        VALUES ($1::uuid, $2::uuid, 'upload', 'document', $3::uuid, $4, now() - make_interval(hours => $5))
        RETURNING id
        """,
        user_id, company_id, str(uuid.uuid4()), name, hours_ago,
    ))


async def _verify(conn: asyncpg.Connection, company_id: str) -> dict[str, tuple[bool, str | None]]:
    rows = await conn.fetch("SELECT event_id, ok, reason FROM public.activity_log_verify_chain($1)", company_id)
    return {str(r["event_id"]): (r["ok"], r["reason"]) for r in rows}


async def _three_events_out_of_time_order(conn):
    """3 eventos gravados na ordem e1 → e2 → e3, mas com horários fora dessa
    ordem (e2 é o mais antigo) — o caso do seed/reset da demo."""
    company_id, user_id = await _setup_company(conn)
    e1 = await _log(conn, company_id, user_id, "NF-e_1.xml", hours_ago=1)
    e2 = await _log(conn, company_id, user_id, "Holerite_1.pdf", hours_ago=3)
    e3 = await _log(conn, company_id, user_id, "Contrato_1.pdf", hours_ago=2)
    return company_id, e1, e2, e3


@pytest.mark.asyncio
async def test_chain_valid_when_time_order_differs_from_insert_order(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            company_id, e1, e2, e3 = await _three_events_out_of_time_order(conn)
            result = await _verify(conn, company_id)
            assert set(result) == {e1, e2, e3}
            assert all(ok for ok, _ in result.values()), result
        finally:
            await tr.rollback()


@pytest.mark.asyncio
async def test_chain_detects_tampered_event(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            company_id, e1, e2, e3 = await _three_events_out_of_time_order(conn)
            await conn.execute(
                "UPDATE public.activity_log SET item_name_snapshot = 'Holerite_adulterado.pdf' WHERE id = $1", e2
            )
            result = await _verify(conn, company_id)
            assert result[e2][0] is False
            assert result[e2][1].startswith("Evento adulterado")
            assert result[e1] == (True, None)
            assert result[e3] == (True, None)
        finally:
            await tr.rollback()


@pytest.mark.asyncio
async def test_chain_detects_deleted_event(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            company_id, e1, e2, e3 = await _three_events_out_of_time_order(conn)
            await conn.execute("DELETE FROM public.activity_log WHERE id = $1", e2)
            result = await _verify(conn, company_id)
            assert e2 not in result
            assert result[e1] == (True, None)
            assert result[e3][0] is False
            assert result[e3][1].startswith("Cadeia quebrada")
            assert "None" not in result  # o fim (e3) continua lá: não é truncamento
        finally:
            await tr.rollback()


@pytest.mark.asyncio
async def test_chain_detects_truncated_end(admin_pool):
    """Apagar o evento mais recente deixa os outros alcançáveis e válidos; só a
    comparação com activity_log_chain.last_hash pega o truncamento."""
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            company_id, e1, e2, e3 = await _three_events_out_of_time_order(conn)
            await conn.execute("DELETE FROM public.activity_log WHERE id = $1", e3)  # e3 foi o último gravado
            rows = await conn.fetch(
                "SELECT event_id, ok, reason FROM public.activity_log_verify_chain($1)", company_id
            )
            truncated = [r for r in rows if r["event_id"] is None]
            assert len(truncated) == 1
            assert truncated[0]["ok"] is False
            assert truncated[0]["reason"].startswith("Cadeia truncada")
            assert {str(r["event_id"]): r["ok"] for r in rows if r["event_id"]} == {e1: True, e2: True}
        finally:
            await tr.rollback()


@pytest.mark.asyncio
async def test_verify_chain_requires_company_access(admin_pool):
    """A função é SECURITY DEFINER (ignora o RLS), então ela mesma confere se
    quem chama tem acesso à empresa. Um admin global de fora recebe 42501."""
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            company_id, e1, _e2, _e3 = await _three_events_out_of_time_order(conn)
            insider = str(await conn.fetchval("SELECT user_id FROM public.activity_log WHERE id = $1", e1))
            outsider = str(uuid.uuid4())
            await conn.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", outsider, f"{outsider[:8]}@test.local")
            await conn.execute(
                "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Admin de Fora', 'admin')",
                outsider, f"fora_{outsider[:6]}",
            )
            await conn.execute(
                "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')",
                insider, company_id,
            )

            await conn.execute("SET LOCAL role TO authenticated")
            await conn.execute(
                "SELECT set_config('request.jwt.claims', $1, true)", json.dumps({"sub": insider, "role": "authenticated"})
            )
            assert len(await conn.fetch("SELECT * FROM public.activity_log_verify_chain($1)", company_id)) == 3

            await conn.execute(
                "SELECT set_config('request.jwt.claims', $1, true)", json.dumps({"sub": outsider, "role": "authenticated"})
            )
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                async with conn.transaction():
                    await conn.fetch("SELECT * FROM public.activity_log_verify_chain($1)", company_id)
        finally:
            await tr.rollback()
