from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin

router = APIRouter(prefix="/admin", tags=["admin"])


def _require_manager(claims: dict[str, Any]) -> dict[str, Any]:
    """Raises 403 if the caller does not have the 'manager' system role."""
    if claims.get("role") not in ("manager", "admin"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Acesso restrito a gerentes.")
    return claims


# ---------------------------------------------------------------------------
# GET /admin/users — lista todos os usuários do sistema
# ---------------------------------------------------------------------------

@router.get("/users")
async def list_users(
    company_id: UUID | None = Query(None),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Lista usuários. Se company_id fornecido, filtra pelos membros daquela empresa."""
    _require_manager(claims)

    if company_id:
        rows = await admin_conn.fetch(
            """
            SELECT
              u.id::text,
              u.username,
              u.full_name,
              uca.permission_level AS role,
              uca.company_id::text,
              u.created_at
            FROM public.users u
            JOIN public.user_company_access uca ON uca.user_id = u.id
            WHERE uca.company_id = $1
            ORDER BY u.full_name
            """,
            company_id,
        )
    else:
        rows = await admin_conn.fetch(
            """
            SELECT id::text, username, full_name, role, created_at
            FROM public.users
            ORDER BY full_name
            """
        )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# POST /admin/users — cria novo usuário (sistema)
# ---------------------------------------------------------------------------

class UserCreate(BaseModel):
    username: str
    full_name: str
    email: str
    role: str = "viewer"


@router.post("/users", status_code=status.HTTP_201_CREATED)
async def create_user(
    body: UserCreate,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Cria usuário diretamente na tabela users (sem Supabase Auth — apenas para testes/seed)."""
    _require_manager(claims)

    existing = await admin_conn.fetchval(
        "SELECT id FROM public.users WHERE username = $1", body.username
    )
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username já existe.")

    row = await admin_conn.fetchrow(
        """
        INSERT INTO public.users (username, full_name, role)
        VALUES ($1, $2, $3)
        RETURNING id::text, username, full_name, role, created_at
        """,
        body.username,
        body.full_name,
        body.role,
    )
    return dict(row)


# ---------------------------------------------------------------------------
# GET /admin/permissions — lista permissões de uma empresa
# ---------------------------------------------------------------------------

@router.get("/permissions")
async def list_permissions(
    company_id: UUID = Query(...),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Lista todas as entradas de user_company_access para a empresa."""
    _require_manager(claims)

    rows = await admin_conn.fetch(
        """
        SELECT
          uca.id::text,
          uca.user_id::text,
          u.username,
          u.full_name,
          uca.company_id::text,
          uca.permission_level,
          uca.folder_path::text,
          uca.created_at
        FROM public.user_company_access uca
        JOIN public.users u ON u.id = uca.user_id
        WHERE uca.company_id = $1
        ORDER BY u.full_name, uca.folder_path
        """,
        company_id,
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# POST /admin/permissions — concede ou atualiza permissão
# ---------------------------------------------------------------------------

class PermissionUpsert(BaseModel):
    user_id: UUID
    company_id: UUID
    permission_level: str  # viewer | editor | manager
    folder_path: str | None = None


@router.post("/permissions", status_code=status.HTTP_201_CREATED)
async def upsert_permission(
    body: PermissionUpsert,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Insere ou atualiza permissão. ON CONFLICT atualiza o permission_level."""
    _require_manager(claims)

    if body.permission_level not in ("viewer", "editor", "manager"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="permission_level deve ser viewer, editor ou manager.",
        )

    row = await admin_conn.fetchrow(
        """
        INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path)
        VALUES ($1, $2, $3, $4::ltree)
        ON CONFLICT (user_id, company_id, folder_path)
        DO UPDATE SET permission_level = EXCLUDED.permission_level
        RETURNING id::text, user_id::text, company_id::text, permission_level, folder_path::text, created_at
        """,
        body.user_id,
        body.company_id,
        body.permission_level,
        body.folder_path,
    )
    return dict(row)


# ---------------------------------------------------------------------------
# GET /admin/storage-usage — uso de armazenamento por empresa
# ---------------------------------------------------------------------------

@router.get("/storage-usage")
async def storage_usage(
    company_id: UUID | None = Query(None),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Retorna uso de armazenamento (soma de size_bytes) por empresa."""
    _require_manager(claims)

    if company_id:
        rows = await admin_conn.fetch(
            """
            SELECT
              c.id::text AS company_id,
              c.name AS company_name,
              COUNT(d.id) AS document_count,
              COALESCE(SUM(d.size_bytes), 0) AS total_bytes
            FROM public.companies c
            LEFT JOIN public.documents d ON d.company_id = c.id AND d.deleted_at IS NULL
            WHERE c.id = $1
            GROUP BY c.id, c.name
            """,
            company_id,
        )
    else:
        rows = await admin_conn.fetch(
            """
            SELECT
              c.id::text AS company_id,
              c.name AS company_name,
              COUNT(d.id) AS document_count,
              COALESCE(SUM(d.size_bytes), 0) AS total_bytes
            FROM public.companies c
            LEFT JOIN public.documents d ON d.company_id = c.id AND d.deleted_at IS NULL
            GROUP BY c.id, c.name
            ORDER BY total_bytes DESC
            """
        )
    return [dict(r) for r in rows]
