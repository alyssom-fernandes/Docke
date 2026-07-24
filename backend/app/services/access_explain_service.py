"""
AccessExplainService — Fase 9.3: "Explain Access". Espelha em SQL a mesma
lógica de public.user_has_access() (Fase 9.1/9.2), mas em vez de devolver só
o vencedor, devolve TODOS os candidatos (diretos + via grupo) que cobrem o
alvo, na mesma ordem de resolução (especificidade DESC, direto > grupo em
empate) — pra a UI poder mostrar a cadeia de motivos e marcar quem venceu.
"""
from typing import Any
from uuid import UUID

import asyncpg


class AccessExplainService:
    @staticmethod
    async def get_folder_path(admin_conn: asyncpg.Connection, folder_id: UUID, company_id: UUID) -> str | None:
        return await admin_conn.fetchval(
            "SELECT path FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
            folder_id, company_id,
        )

    @staticmethod
    async def explain(
        admin_conn: asyncpg.Connection, *, user_id: UUID, company_id: UUID, target_path: str | None,
    ) -> dict[str, Any]:
        rows = await admin_conn.fetch(
            """
            SELECT
              'direto' AS source,
              NULL::text AS group_name,
              uca.permission_level,
              uca.folder_path::text AS folder_path,
              f.name AS folder_name,
              CASE WHEN uca.folder_path IS NULL THEN 0 ELSE nlevel(uca.folder_path) END AS specificity,
              0 AS source_rank
            FROM public.user_company_access uca
            LEFT JOIN public.folders f ON f.path = uca.folder_path AND f.company_id = uca.company_id
            WHERE uca.user_id = $1 AND uca.company_id = $2
              AND (uca.folder_path IS NULL OR ($3::ltree IS NOT NULL AND uca.folder_path @> $3::ltree))

            UNION ALL

            SELECT
              'grupo' AS source,
              g.name AS group_name,
              ga.permission_level,
              ga.folder_path::text AS folder_path,
              f.name AS folder_name,
              CASE WHEN ga.folder_path IS NULL THEN 0 ELSE nlevel(ga.folder_path) END AS specificity,
              1 AS source_rank
            FROM public.group_access ga
            JOIN public."group" g ON g.id = ga.group_id
            JOIN public.group_member gm ON gm.group_id = ga.group_id AND gm.user_id = $1
            LEFT JOIN public.folders f ON f.path = ga.folder_path AND f.company_id = ga.company_id
            WHERE ga.company_id = $2
              AND (ga.folder_path IS NULL OR ($3::ltree IS NOT NULL AND ga.folder_path @> $3::ltree))

            ORDER BY specificity DESC, source_rank ASC
            """,
            user_id, company_id, target_path,
        )
        candidates = [dict(r) for r in rows]
        for i, c in enumerate(candidates):
            c["is_winner"] = i == 0
        return {
            "resolved": candidates[0]["permission_level"] if candidates else None,
            "candidates": candidates,
        }
