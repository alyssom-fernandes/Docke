"""
CompaniesService — CRUD de empresas, membros/concessões de acesso, retenção.
Conexões admin usadas aqui são deliberadas: criação de empresa e criação de
usuário (chamada ao Supabase Auth) precisam ocorrer antes de qualquer
contexto RLS do novo recurso existir; gestão de acesso de outros usuários
nunca pode depender da sessão RLS do próprio ator.
"""
import json
from typing import Any
from uuid import UUID

import asyncpg


class CompaniesService:
    @staticmethod
    async def user_manages_company(conn: asyncpg.Connection, user_id: str, company_id: UUID) -> bool:
        return bool(await conn.fetchval(
            """
            SELECT EXISTS (
              SELECT 1 FROM public.user_company_access
              WHERE user_id = $1 AND company_id = $2
                AND permission_level = 'admin' AND folder_path IS NULL
            )
            """,
            user_id, company_id,
        ))

    @staticmethod
    async def scoped_admin_folder_path(conn: asyncpg.Connection, user_id: str, company_id: UUID) -> str | None:
        """
        Fase 9.5: o folder_path de uma concessão 'admin' escopada a subpasta
        (folder_path IS NOT NULL) do usuário nesta empresa, se houver — usado
        por _can_manage_scope para liberar gerenciamento de usuários dentro
        do próprio escopo de um admin de subpasta (nunca da empresa toda,
        que já é coberta por user_manages_company).
        """
        return await conn.fetchval(
            """
            SELECT folder_path FROM public.user_company_access
            WHERE user_id = $1 AND company_id = $2
              AND permission_level = 'admin' AND folder_path IS NOT NULL
            ORDER BY nlevel(folder_path) ASC
            LIMIT 1
            """,
            user_id, company_id,
        )

    @staticmethod
    async def list_companies(conn: asyncpg.Connection) -> list[asyncpg.Record]:
        """Empresas às quais o usuário tem QUALQUER acesso — inclusive só uma
        concessão escopada por pasta (folder_path IS NOT NULL). Filtrar por
        folder_path IS NULL aqui (como em user_manages_company, que é sobre
        administrar a empresa, não sobre enxergá-la) deixava usuários com
        acesso restrito a uma pasta sem nenhuma empresa na lista — travados
        no onboarding de "criar organização" mesmo já tendo acesso concedido."""
        return await conn.fetch(
            """
            SELECT id, name, created_at, permission_level FROM (
              SELECT DISTINCT ON (c.id)
                c.id::text AS id, c.name, c.created_at, uca.permission_level
              FROM public.companies c
              JOIN public.user_company_access uca
                ON uca.company_id = c.id
               AND uca.user_id    = auth.uid()
              ORDER BY c.id,
                CASE uca.permission_level
                  WHEN 'admin' THEN 3 WHEN 'operador' THEN 2 ELSE 1
                END DESC,
                uca.folder_path NULLS FIRST
            ) sub
            ORDER BY name
            """
        )

    @staticmethod
    async def list_organizations_all(admin_conn: asyncpg.Connection) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              c.id::text, c.name, c.cnpj, c.logo_key, c.is_active, c.created_at,
              (SELECT COUNT(*) FROM public.documents d WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS document_count,
              (SELECT COUNT(*) FROM public.user_company_access uca WHERE uca.company_id = c.id AND uca.folder_path IS NULL) AS user_count
            FROM public.companies c
            ORDER BY c.name
            """
        )

    @staticmethod
    async def list_organizations_managed_by(admin_conn: asyncpg.Connection, user_id: str) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            SELECT
              c.id::text, c.name, c.cnpj, c.logo_key, c.is_active, c.created_at,
              (SELECT COUNT(*) FROM public.documents d WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS document_count,
              (SELECT COUNT(*) FROM public.user_company_access uca WHERE uca.company_id = c.id AND uca.folder_path IS NULL) AS user_count
            FROM public.companies c
            JOIN public.user_company_access mine
              ON mine.company_id = c.id AND mine.user_id = $1
             AND mine.permission_level = 'admin' AND mine.folder_path IS NULL
            ORDER BY c.name
            """,
            user_id,
        )

    @staticmethod
    async def get_company(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT c.id::text, c.name, c.created_at FROM public.companies c WHERE c.id = $1",
            company_id,
        )

    @staticmethod
    async def create_company(admin_conn: asyncpg.Connection, *, name: str, user_id: str) -> asyncpg.Record:
        async with admin_conn.transaction():
            company = await admin_conn.fetchrow(
                "INSERT INTO public.companies (name) VALUES ($1) RETURNING id::text, name, created_at",
                name,
            )
            await admin_conn.execute(
                """
                INSERT INTO public.user_company_access
                  (user_id, company_id, folder_path, permission_level, granted_by)
                VALUES ($1, $2::uuid, NULL, 'admin', $1)
                """,
                user_id, company["id"],
            )
        return company

    @staticmethod
    async def list_members(conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              uca.id::text AS access_id,
              uca.user_id::text,
              uca.permission_level AS role,
              u.full_name,
              u.username,
              uca.created_at,
              f.id::text AS folder_id,
              f.name AS folder_name
            FROM public.user_company_access uca
            JOIN public.users u ON u.id = uca.user_id
            LEFT JOIN public.folders f ON f.path = uca.folder_path AND f.company_id = uca.company_id
            WHERE uca.company_id = $1
            ORDER BY u.full_name, f.name NULLS FIRST
            """,
            company_id,
        )

    @staticmethod
    async def is_member(conn: asyncpg.Connection, user_id: str, company_id: UUID) -> bool:
        return bool(await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)",
            user_id, company_id,
        ))

    @staticmethod
    async def has_unscoped_access(conn: asyncpg.Connection, user_id: str, company_id: UUID) -> bool:
        """
        True se o usuário tem alguma concessão folder_path IS NULL (empresa
        toda) — usado pra decidir se os agregados do dashboard podem vir da
        materialized view (que não tem RLS e enxerga TUDO da empresa) ou
        precisam ser calculados ao vivo, restritos ao que o operador
        escopado por pasta realmente pode ver (Fase 3.8).
        """
        return bool(await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2 AND folder_path IS NULL)",
            user_id, company_id,
        ))

    @staticmethod
    async def get_stats(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        """
        Fase 3.1: total_documents/total_folders/recent_uploads vêm da
        materialized view (mv_company_stats), não de COUNT(*) direto —
        `refreshed_at` deixa explícito pro frontend há quanto tempo esse
        número é verdade (Fase 3.3, "atualizado há X").

        total_favorites continua ao vivo: é por usuário (auth.uid()), não
        da empresa — materializar por empresa estaria errado.

        CUIDADO: materialized view não tem RLS — enxerga a empresa inteira
        sem respeitar concessão restrita a pasta. Só chamar isto depois de
        confirmar has_unscoped_access(); caso contrário usar get_stats_live().
        """
        return await conn.fetchrow(
            """
            SELECT
              mv.total_documents, mv.total_folders, mv.recent_uploads, mv.documents_today,
              csr.refreshed_at,
              (SELECT COUNT(*) FROM public.favorites fav
               JOIN public.documents d ON d.id = fav.document_id
               WHERE d.company_id = $1 AND fav.user_id = auth.uid()) AS total_favorites
            FROM public.mv_company_stats mv
            LEFT JOIN public.company_stats_refresh csr ON csr.company_id = mv.company_id
            WHERE mv.company_id = $1
            """,
            company_id,
        )

    @staticmethod
    async def get_stats_live(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record:
        """
        Fase 3.8: caminho pra quem só tem concessão restrita a pasta — usa
        `conn` (role authenticated, RLS ativa), então os COUNT(*) abaixo já
        saem naturalmente limitados ao que o usuário pode ver. Mais lento que
        a materialized view, mas é exatamente por isso que ela não pode ser
        usada aqui: um número rápido e errado é pior que um número lento e
        certo numa tela de auditoria/conformidade.
        """
        return await conn.fetchrow(
            """
            SELECT
              (SELECT COUNT(*) FROM public.documents d
               WHERE d.company_id = $1 AND d.deleted_at IS NULL) AS total_documents,
              (SELECT COUNT(*) FROM public.folders f
               WHERE f.company_id = $1 AND f.deleted_at IS NULL) AS total_folders,
              (SELECT COUNT(*) FROM public.favorites fav
               JOIN public.documents d ON d.id = fav.document_id
               WHERE d.company_id = $1 AND fav.user_id = auth.uid()) AS total_favorites,
              (SELECT COUNT(*) FROM public.documents d
               WHERE d.company_id = $1 AND d.deleted_at IS NULL
                 AND d.created_at >= now() - interval '7 days') AS recent_uploads,
              (SELECT COUNT(*) FROM public.documents d
               WHERE d.company_id = $1 AND d.deleted_at IS NULL
                 AND d.created_at >= now() - interval '1 day') AS documents_today,
              now() AS refreshed_at
            """,
            company_id,
        )

    @staticmethod
    async def stats_context(conn: asyncpg.Connection, company_id: UUID) -> dict[str, int]:
        """
        Contexto dos contadores, ao vivo e pela conexão do usuário (RLS):
        envios desde a meia-noite de Brasília (não "últimas 24 h", achado
        A3-12) e os 7 dias anteriores à última semana, para comparar (A3-11).
        """
        row = await conn.fetchrow(
            """
            SELECT
              (SELECT count(*) FROM public.documents d
                WHERE d.company_id = $1 AND d.deleted_at IS NULL
                  AND d.created_at >= (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
                                       AT TIME ZONE 'America/Sao_Paulo')) AS documents_today,
              (SELECT count(*) FROM public.documents d
                WHERE d.company_id = $1 AND d.deleted_at IS NULL
                  AND d.created_at >= now() - interval '14 days'
                  AND d.created_at <  now() - interval '7 days') AS previous_uploads
            """,
            company_id,
        )
        return {k: int(v or 0) for k, v in dict(row).items()}

    @staticmethod
    async def refresh_stats(conn: asyncpg.Connection) -> None:
        await conn.execute("SELECT public.refresh_company_stats()")

    @staticmethod
    async def get_dashboard_charts(
        conn: asyncpg.Connection,
        company_id: UUID,
        days: int = 14,
        folder_id: UUID | None = None,
        only: str | None = None,
    ) -> dict[str, Any]:
        """
        Fase 3.2/3.4: dados dos dois gráficos do dashboard — sempre ao vivo
        via `conn` (RLS ativa), nunca da materialized view, porque aqui a
        quebra por pasta É o dado sensível (Fase 3.8 se aplica com força
        total: um operador só pode ver a contagem das pastas que ele
        acessa, nunca a lista completa de pastas da empresa).

        Fase 3.7: `days` é o filtro GLOBAL do período (aplica só aos dois
        gráficos — os stat cards no topo continuam vindo da materialized
        view, que só guarda o agregado fixo de 7 dias; misturar os dois
        quebraria o propósito da Fase 3.1 de nunca contar ao vivo a cada
        carregamento). `folder_id` é o filtro PRÓPRIO do gráfico "Documentos
        por pasta" — deixa o usuário descer um nível na árvore sem afetar
        o gráfico de uploads ao lado, exatamente a distinção "filtro global
        vs filtro por widget" que a pesquisa pediu.
        """
        out: dict[str, Any] = {}
        if only in (None, "daily"):
            out["daily_uploads"] = await CompaniesService._daily_uploads(conn, company_id, days)
        if only in (None, "folders"):
            out["by_folder"] = await CompaniesService._by_folder(conn, company_id, folder_id)
        return out

    @staticmethod
    async def _daily_uploads(conn: asyncpg.Connection, company_id: UUID, days: int) -> list[dict[str, Any]]:
        # Dia no fuso de Brasília, não UTC: um envio às 22h de segunda não
        # pode aparecer na terça (achado A3-12).
        daily = await conn.fetch(
            """
            SELECT d::date AS day, coalesce(cnt, 0) AS count
            FROM generate_series(
                   (now() AT TIME ZONE 'America/Sao_Paulo')::date - ($2::int - 1),
                   (now() AT TIME ZONE 'America/Sao_Paulo')::date, interval '1 day') AS d
            LEFT JOIN (
              SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS day, count(*) AS cnt
              FROM public.documents
              WHERE company_id = $1 AND deleted_at IS NULL
                AND created_at >= now() - ($2::int + 1) * interval '1 day'
              GROUP BY 1
            ) x ON x.day = d::date
            ORDER BY d
            """,
            company_id, days,
        )
        return [{"date": r["day"].isoformat(), "count": r["count"]} for r in daily]

    @staticmethod
    async def _by_folder(conn: asyncpg.Connection, company_id: UUID, folder_id: UUID | None) -> list[dict[str, Any]]:
        rows = await conn.fetch(
            """
            SELECT f.id::text, f.name,
                   (SELECT count(*) FROM public.documents d
                      JOIN public.folders df ON df.id = d.folder_id AND df.deleted_at IS NULL
                     WHERE df.path <@ f.path AND d.deleted_at IS NULL) AS document_count,
                   EXISTS (SELECT 1 FROM public.folders s
                            WHERE s.parent_id = f.id AND s.deleted_at IS NULL) AS has_children
            FROM public.folders f
            WHERE f.company_id = $1 AND f.deleted_at IS NULL
              AND f.parent_id IS NOT DISTINCT FROM $2::uuid
            ORDER BY document_count DESC, f.name
            """,
            company_id, folder_id,
        )
        items = [dict(r) for r in rows if r["document_count"] > 0]
        top, rest = items[:6], items[6:]
        if rest:
            top.append({
                "id": None, "name": f"Outras {len(rest)} pastas", "kind": "outras",
                "document_count": sum(r["document_count"] for r in rest), "has_children": False,
            })
        if folder_id is not None:
            direct = await conn.fetchval(
                "SELECT count(*) FROM public.documents WHERE folder_id = $1 AND deleted_at IS NULL", folder_id,
            )
            if direct:
                top.append({
                    "id": str(folder_id), "name": "Direto nesta pasta", "kind": "direto",
                    "document_count": direct, "has_children": False,
                })
        return top

    @staticmethod
    async def update_company(
        admin_conn: asyncpg.Connection, *, company_id: UUID, name: str | None,
        cnpj_provided: bool, cnpj: str | None, is_active: bool | None, logo_key: str | None,
    ) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            """
            UPDATE public.companies
            SET name      = COALESCE($2, name),
                cnpj      = CASE WHEN $3::boolean THEN $4 ELSE cnpj END,
                is_active = COALESCE($5, is_active),
                logo_key  = COALESCE($6, logo_key)
            WHERE id = $1
            RETURNING id::text, name, cnpj, logo_key, is_active, created_at
            """,
            company_id, name, cnpj_provided, cnpj, is_active, logo_key,
        )

    @staticmethod
    async def get_logo_key(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT logo_key FROM public.companies WHERE id = $1", company_id)

    @staticmethod
    async def username_exists(admin_conn: asyncpg.Connection, username: str) -> bool:
        return bool(await admin_conn.fetchval("SELECT id FROM public.users WHERE username = $1", username))

    @staticmethod
    async def get_folder_path(admin_conn: asyncpg.Connection, folder_id: UUID, company_id: UUID) -> str | None:
        return await admin_conn.fetchval(
            "SELECT path FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
            folder_id, company_id,
        )

    @staticmethod
    async def insert_user(admin_conn: asyncpg.Connection, *, user_id: str, username: str, full_name: str) -> None:
        await admin_conn.execute(
            "INSERT INTO public.users (id, username, full_name, role) VALUES ($1::uuid, $2, $3, 'usuario')",
            user_id, username, full_name,
        )

    @staticmethod
    async def insert_access_grant(
        admin_conn: asyncpg.Connection, *, user_id: UUID | str, company_id: UUID,
        permission_level: str, folder_path: str | None, granted_by: str,
    ) -> asyncpg.Record:
        return await admin_conn.fetchrow(
            """
            INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path, granted_by)
            VALUES ($1::uuid, $2, $3, $4::ltree, $5::uuid)
            RETURNING id::text, user_id::text, company_id::text, permission_level, created_at
            """,
            user_id, company_id, permission_level, folder_path, granted_by,
        )

    @staticmethod
    async def member_exists(admin_conn: asyncpg.Connection, member_id: UUID, company_id: UUID) -> bool:
        return bool(await admin_conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)",
            member_id, company_id,
        ))

    @staticmethod
    async def get_access_grant(admin_conn: asyncpg.Connection, access_id: UUID, company_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT user_id, folder_path FROM public.user_company_access WHERE id = $1 AND company_id = $2",
            access_id, company_id,
        )

    @staticmethod
    async def count_grants_for_user(admin_conn: asyncpg.Connection, user_id, company_id: UUID) -> int:
        return await admin_conn.fetchval(
            "SELECT count(*) FROM public.user_company_access WHERE user_id = $1 AND company_id = $2",
            user_id, company_id,
        )

    @staticmethod
    async def delete_access_grant(admin_conn: asyncpg.Connection, access_id: UUID) -> None:
        await admin_conn.execute("DELETE FROM public.user_company_access WHERE id = $1", access_id)

    @staticmethod
    async def list_people(admin_conn: asyncpg.Connection, company_id: UUID) -> list[dict[str, Any]]:
        """
        Pessoas da empresa com tudo que define o que cada uma vê (A9-18):
        concessões diretas, acessos recebidos por grupo, se a conta está
        ativa e o último acesso. Quem só tem acesso por grupo também aparece.
        """
        rows = await admin_conn.fetch(
            """
            WITH quem AS (
              SELECT user_id FROM public.user_company_access WHERE company_id = $1
              UNION
              SELECT gm.user_id FROM public.group_member gm
              JOIN public."group" g ON g.id = gm.group_id
              JOIN public.group_access ga ON ga.group_id = g.id AND ga.company_id = $1
              WHERE g.company_id = $1
            )
            SELECT u.id::text AS user_id, u.username, u.full_name, u.is_active, u.role,
                   u.must_change_password, au.email::text AS email, au.last_sign_in_at,
                   COALESCE((
                     SELECT json_agg(json_build_object(
                       'access_id', a.id::text, 'role', a.permission_level, 'folder_id', f.id::text,
                       'folder_name', f.name, 'created_at', a.created_at) ORDER BY a.folder_path NULLS FIRST)
                     FROM public.user_company_access a
                     LEFT JOIN public.folders f ON f.company_id = a.company_id AND f.path = a.folder_path AND f.deleted_at IS NULL
                     WHERE a.user_id = u.id AND a.company_id = $1
                   ), '[]') AS grants,
                   COALESCE((
                     SELECT json_agg(json_build_object(
                       'group_id', g.id::text, 'group_name', g.name, 'role', ga.permission_level,
                       'folder_id', f.id::text, 'folder_name', f.name))
                     FROM public.group_member gm
                     JOIN public."group" g ON g.id = gm.group_id AND g.company_id = $1
                     JOIN public.group_access ga ON ga.group_id = g.id AND ga.company_id = $1
                     LEFT JOIN public.folders f ON f.company_id = ga.company_id AND f.path = ga.folder_path AND f.deleted_at IS NULL
                     WHERE gm.user_id = u.id
                   ), '[]') AS via_groups,
                   (SELECT count(DISTINCT c.company_id) FROM (
                      SELECT company_id FROM public.user_company_access WHERE user_id = u.id
                      UNION SELECT ga.company_id FROM public.group_member gm
                            JOIN public.group_access ga ON ga.group_id = gm.group_id WHERE gm.user_id = u.id
                   ) c) AS company_count
            FROM quem q
            JOIN public.users u ON u.id = q.user_id
            LEFT JOIN auth.users au ON au.id = u.id
            ORDER BY u.is_active DESC, lower(u.full_name)
            """,
            company_id,
        )
        out = []
        for r in rows:
            d = dict(r)
            for k in ("grants", "via_groups"):
                if isinstance(d[k], str):
                    d[k] = json.loads(d[k])
            out.append(d)
        return out

    @staticmethod
    async def manages_all_companies_of(admin_conn: asyncpg.Connection, actor_id: str, target_id: UUID) -> bool:
        """
        Desativar a conta ou trocar a senha valem para TODAS as empresas da
        pessoa: só quem administra todas elas pode (ou o supremo, checado fora).
        """
        return bool(await admin_conn.fetchval(
            """
            SELECT NOT EXISTS (
              SELECT c.company_id FROM (
                SELECT company_id FROM public.user_company_access WHERE user_id = $2
                UNION SELECT ga.company_id FROM public.group_member gm
                      JOIN public.group_access ga ON ga.group_id = gm.group_id WHERE gm.user_id = $2
              ) c
              WHERE NOT EXISTS (
                SELECT 1 FROM public.user_company_access a
                WHERE a.user_id = $1::uuid AND a.company_id = c.company_id
                  AND a.permission_level = 'admin' AND a.folder_path IS NULL
              )
            )
            """,
            actor_id, target_id,
        ))

    @staticmethod
    async def has_group_access(admin_conn: asyncpg.Connection, user_id, company_id: UUID) -> bool:
        return bool(await admin_conn.fetchval(
            """
            SELECT EXISTS (SELECT 1 FROM public.group_member gm
                           JOIN public.group_access ga ON ga.group_id = gm.group_id
                           WHERE gm.user_id = $1 AND ga.company_id = $2)
            """,
            user_id, company_id,
        ))

    @staticmethod
    async def company_admin_count(admin_conn: asyncpg.Connection, company_id: UUID) -> int:
        return int(await admin_conn.fetchval(
            """
            SELECT count(DISTINCT a.user_id) FROM public.user_company_access a
            JOIN public.users u ON u.id = a.user_id AND u.is_active
            WHERE a.company_id = $1 AND a.permission_level = 'admin' AND a.folder_path IS NULL
            """,
            company_id,
        ) or 0)

    @staticmethod
    async def log_access(
        admin_conn: asyncpg.Connection, *, actor_id: str, company_id: UUID | str, action: str, target_id: UUID | str,
        target_name: str, metadata: dict[str, Any] | None = None,
    ) -> None:
        """Mudanças de acesso entram na trilha (X2-13, A8-T2)."""
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
            VALUES ($1::uuid, $2::uuid, $3, 'access', $4::uuid, $5, 'access', $6::jsonb)
            """,
            actor_id, str(company_id), action, str(target_id), target_name, json.dumps(metadata or {}, default=str),
        )

    @staticmethod
    async def delete_member(admin_conn: asyncpg.Connection, member_id: UUID, company_id: UUID) -> None:
        await admin_conn.execute(
            "DELETE FROM public.user_company_access WHERE user_id = $1 AND company_id = $2",
            member_id, company_id,
        )

    @staticmethod
    async def get_retention(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT retention_days FROM public.companies WHERE id = $1", company_id)

    @staticmethod
    async def update_retention(
        admin_conn: asyncpg.Connection, *, company_id: UUID, retention_days: int, carencia_dias: int,
    ) -> None:
        async with admin_conn.transaction():
            await admin_conn.execute(
                "UPDATE public.companies SET retention_days = $2 WHERE id = $1",
                company_id, retention_days,
            )
            await admin_conn.execute(
                """
                UPDATE public.documents
                SET trash_expires_at = deleted_at + ($2 * interval '1 day')
                WHERE company_id = $1 AND deleted_at IS NOT NULL
                  AND deleted_at > now() - ($3 * interval '1 day')
                """,
                company_id, retention_days, carencia_dias,
            )
            await admin_conn.execute(
                """
                UPDATE public.folders
                SET trash_expires_at = deleted_at + ($2 * interval '1 day')
                WHERE company_id = $1 AND deleted_at IS NOT NULL
                  AND deleted_at > now() - ($3 * interval '1 day')
                """,
                company_id, retention_days, carencia_dias,
            )
