"""
AuthService — queries de identidade do usuário autenticado (RLS via auth.uid()).
NUNCA lida com o fluxo de login/senha do Supabase Auth em si (isso é chamado
direto via httpx no router, não há "banco" envolvido nessa parte).
"""
import asyncpg


class AuthService:
    @staticmethod
    async def get_current_user_row(conn: asyncpg.Connection) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT
              auth.uid()::text  AS uid_from_rls,
              u.id::text        AS user_id,
              u.username,
              u.full_name,
              u.role,
              u.is_active,
              auth.email()::text AS email
            FROM public.users u
            WHERE u.id = auth.uid()
            """
        )

    @staticmethod
    async def get_current_email(conn: asyncpg.Connection) -> str | None:
        return await conn.fetchval("SELECT auth.email()")

    @staticmethod
    async def update_own_profile(conn: asyncpg.Connection, *, full_name: str) -> asyncpg.Record | None:
        """Fase 10.3: RLS policy users_update_self já restringe a linha do próprio
        usuário (id = auth.uid()) — não precisa de WHERE explícito aqui."""
        return await conn.fetchrow(
            """
            UPDATE public.users SET full_name = $1
            WHERE id = auth.uid()
            RETURNING id::text AS user_id, username, full_name, role, is_active
            """,
            full_name,
        )
