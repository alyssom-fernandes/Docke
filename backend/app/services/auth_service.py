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
