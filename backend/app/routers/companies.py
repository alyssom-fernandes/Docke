from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin

router = APIRouter(prefix="/companies", tags=["companies"])


class CompanyCreate(BaseModel):
    name: str


@router.get("")
async def list_companies(
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Lista as empresas às quais o usuário autenticado tem acesso.
    RLS filtra automaticamente — retorna apenas as empresas do usuário.
    """
    rows = await conn.fetch(
        """
        SELECT
          c.id::text,
          c.name,
          c.created_at,
          uca.permission_level
        FROM public.companies c
        JOIN public.user_company_access uca
          ON uca.company_id = c.id
         AND uca.user_id    = auth.uid()
         AND uca.folder_path IS NULL
        ORDER BY c.name
        """
    )
    return [dict(r) for r in rows]


@router.get("/{company_id}")
async def get_company(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Retorna os dados de uma empresa (apenas se o usuário tiver acesso)."""
    row = await conn.fetchrow(
        """
        SELECT c.id::text, c.name, c.created_at
        FROM public.companies c
        WHERE c.id = $1
        """,
        company_id,
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Empresa não encontrada.",
        )
    return dict(row)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_company(
    body: CompanyCreate,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Cria uma nova empresa e concede acesso 'admin' ao criador.
    Usa get_db_admin (service role) pois INSERT em companies requer permissão
    administrativa — authenticated não tem INSERT direto em companies.
    """
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido.")

    async with admin_conn.transaction():
        company = await admin_conn.fetchrow(
            "INSERT INTO public.companies (name) VALUES ($1) RETURNING id::text, name, created_at",
            body.name,
        )
        # Concede acesso manager ao criador automaticamente (nível máximo em user_company_access)
        await admin_conn.execute(
            """
            INSERT INTO public.user_company_access
              (user_id, company_id, folder_path, permission_level, granted_by)
            VALUES ($1, $2::uuid, NULL, 'manager', $1)
            """,
            user_id,
            company["id"],
        )

    return dict(company)


# ---------------------------------------------------------------------------
# GET /companies/{company_id}/stats — contadores da empresa
# ---------------------------------------------------------------------------

@router.get("/{company_id}/members")
async def company_members(
    company_id: UUID,  # noqa
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Retorna lista de membros da empresa."""
    rows = await conn.fetch(
        """
        SELECT
          uca.user_id::text,
          uca.permission_level AS role,
          u.full_name,
          u.username,
          uca.created_at
        FROM public.user_company_access uca
        JOIN public.users u ON u.id = uca.user_id
        WHERE uca.company_id = $1
        ORDER BY u.full_name
        """,
        company_id,
    )
    return [dict(r) for r in rows]


@router.get("/{company_id}/stats")
async def company_stats(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Retorna contadores de documentos, pastas, favoritos e uploads recentes da empresa."""
    row = await conn.fetchrow(
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
             AND d.created_at >= now() - interval '7 days') AS recent_uploads
        """,
        company_id,
    )
    return dict(row)

