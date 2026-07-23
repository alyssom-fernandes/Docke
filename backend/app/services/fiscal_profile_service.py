"""
Fase 4.2/4.3 (parte 2) — Perfil fiscal da empresa.

Alimenta o motor de regras condicionais de `obligations_service.py`
(NOT_APPLICABLE_LATERAL_SQL). Todos os campos são opcionais — ver comentário
da migration 20260723000025 pra o raciocínio de "sem dado, nada é escondido".
"""
from uuid import UUID

import asyncpg

VALID_REGIMES = ("simples_nacional", "lucro_presumido", "lucro_real")
VALID_FAIXAS = ("nenhum", "1_a_10", "11_a_50", "51_a_200", "201_mais")
VALID_TIPOS_JURIDICOS = ("mei", "ltda", "sa", "eireli", "outro")


class FiscalProfileService:
    @staticmethod
    async def get(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT * FROM public.company_fiscal_profile WHERE company_id = $1", company_id,
        )

    @staticmethod
    async def upsert(
        conn: asyncpg.Connection, company_id: UUID, *,
        regime_tributario: str | None, faixa_funcionarios: str | None,
        uf: str | None, tipo_juridico: str | None, updated_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.company_fiscal_profile (company_id, regime_tributario, faixa_funcionarios, uf, tipo_juridico, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (company_id) DO UPDATE SET
              regime_tributario = EXCLUDED.regime_tributario,
              faixa_funcionarios = EXCLUDED.faixa_funcionarios,
              uf = EXCLUDED.uf,
              tipo_juridico = EXCLUDED.tipo_juridico,
              updated_by = EXCLUDED.updated_by
            RETURNING *
            """,
            company_id, regime_tributario, faixa_funcionarios, uf, tipo_juridico, updated_by,
        )
