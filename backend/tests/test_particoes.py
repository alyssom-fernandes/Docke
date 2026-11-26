"""Partições futuras da trilha (X3-13)."""
import pytest


@pytest.mark.asyncio
async def test_particoes_da_trilha_existem_para_os_proximos_meses(admin):
    await admin.fetchval("SELECT public.ensure_activity_log_partitions(30)")
    faltando = await admin.fetchval(
        """
        SELECT count(*) FROM generate_series(date_trunc('month', now()), date_trunc('month', now()) + interval '30 months', interval '1 month') m
        WHERE to_regclass('public.activity_log_' || to_char(m, 'YYYY_MM')) IS NULL
        """
    )
    assert faltando == 0
    # Idempotente: rodar de novo não cria nada.
    assert await admin.fetchval("SELECT public.ensure_activity_log_partitions(30)") == 0
