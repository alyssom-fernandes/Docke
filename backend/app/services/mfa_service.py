"""
Verificação em duas etapas (TOTP do Supabase Auth) — decisão do dono em 26/11/2026.

Quem tem um fator verificado precisa de sessão aal2 (código conferido) em toda
rota fora de /auth. Quem a política da empresa obriga e ainda não cadastrou o
app autenticador só alcança /auth até cadastrar. O administrador geral sempre
precisa. A conta de demonstração fica de fora: é compartilhada por visitantes.
"""
from typing import Any

import asyncpg

from app.config import settings

# Rotas liberadas antes do código: entrar, renovar, sair, cadastrar/conferir o
# fator e saber quem sou (o app precisa disso para mostrar a tela do código).
_LIVRES = ("/api/v1/auth/",)

_SQL_ESTADO = """
SELECT
  EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = $1 AND f.status = 'verified') AS cadastrado,
  (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = $1 AND u.role = 'supremo')
    OR EXISTS (
      SELECT 1
      FROM (
        SELECT company_id, folder_path, permission_level FROM public.user_company_access WHERE user_id = $1
        UNION ALL
        SELECT ga.company_id, ga.folder_path, ga.permission_level
        FROM public.group_access ga JOIN public.group_member gm ON gm.group_id = ga.group_id
        WHERE gm.user_id = $1
      ) a
      JOIN public.companies c ON c.id = a.company_id
      WHERE c.mfa_policy = 'todos'
         OR (c.mfa_policy IN ('admins', 'admins_sensiveis') AND a.permission_level = 'admin')
         OR (c.mfa_policy = 'admins_sensiveis' AND EXISTS (
               SELECT 1 FROM public.folders f
               WHERE f.company_id = a.company_id AND f.deleted_at IS NULL
                 AND f.sensitivity IN ('pessoal', 'sensivel')
                 AND (a.folder_path IS NULL OR f.path <@ a.folder_path OR f.path @> a.folder_path)))
    )
  ) AS exigido
"""


def is_demo(claims: dict[str, Any]) -> bool:
    return str(claims.get("email") or "").lower().strip() == settings.DEMO_EMAIL.lower()


async def estado(conn: asyncpg.Connection, user_id: str) -> tuple[bool, bool]:
    """(tem fator verificado, a política obriga). Precisa de conexão sem RLS (lê auth.mfa_factors)."""
    row = await conn.fetchrow(_SQL_ESTADO, user_id)
    return bool(row["cadastrado"]), bool(row["exigido"])


def pendencia(claims: dict[str, Any], cadastrado: bool, exigido: bool) -> str | None:
    """'verificar' (tem fator, falta o código nesta sessão), 'cadastrar' (obrigado, sem fator) ou None."""
    if claims.get("aal") == "aal2" or is_demo(claims):
        return None
    if cadastrado:
        return "verificar"
    if exigido:
        return "cadastrar"
    return None


def rota_livre(path: str) -> bool:
    return path.startswith(_LIVRES)
