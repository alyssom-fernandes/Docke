from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.dependencies import get_app_role, get_current_user, get_db_admin
from app.seed.demo_data import DEMO_USER_USERNAME
from app.services.admin_service import AdminService

router = APIRouter(prefix="/admin", tags=["admin"])


async def _require_manager(conn: asyncpg.Connection, claims: dict[str, Any]) -> None:
    """
    Raises 403 se o usuário não tiver papel de aplicação admin/supremo.
    Corrigido: antes checava claims["role"] (sempre "authenticated" no JWT do
    Supabase — nunca batia, bloqueando 100% dos usuários). Agora consulta
    public.users.role via get_app_role().
    """
    role = await get_app_role(conn, claims)
    if role not in ("admin", "supremo"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Acesso restrito a administradores.")


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
    await _require_manager(admin_conn, claims)
    rows = (
        await AdminService.list_users_by_company(admin_conn, company_id)
        if company_id
        else await AdminService.list_all_users(admin_conn)
    )
    return [dict(r) for r in rows]


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
    await _require_manager(admin_conn, claims)
    rows = await AdminService.list_permissions(admin_conn, company_id)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# POST /admin/permissions — concede ou atualiza permissão
# ---------------------------------------------------------------------------

class PermissionUpsert(BaseModel):
    user_id: UUID
    company_id: UUID
    permission_level: str  # visualizador | operador | admin
    folder_path: str | None = None


@router.post("/permissions", status_code=status.HTTP_201_CREATED)
async def upsert_permission(
    body: PermissionUpsert,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Insere ou atualiza permissão. ON CONFLICT atualiza o permission_level."""
    await _require_manager(admin_conn, claims)

    if body.permission_level not in ("visualizador", "operador", "admin"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="permission_level deve ser visualizador, operador ou admin.",
        )

    row = await AdminService.upsert_permission(
        admin_conn,
        user_id=body.user_id, company_id=body.company_id,
        permission_level=body.permission_level, folder_path=body.folder_path,
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
    await _require_manager(admin_conn, claims)
    rows = (
        await AdminService.storage_usage_by_company(admin_conn, company_id)
        if company_id
        else await AdminService.storage_usage_all(admin_conn)
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# POST /admin/demo/reset — restaura as 3 empresas demo ao estado padrão
# ---------------------------------------------------------------------------

@router.post("/demo/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_demo(
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """
    Apaga tudo que foi adicionado nas 3 empresas demo (documentos, pastas,
    usuários extras, favoritos, links) e recria os dados padrão do zero.

    Só a própria conta demo pode chamar isso — não é `_require_manager`
    (admin/supremo de qualquer empresa real), é uma checagem própria e mais
    estreita: só libera se `username == 'demo'`, então nenhum cliente real
    consegue disparar isso contra os próprios dados nem por engano.
    """
    username = await admin_conn.fetchval(
        "SELECT username FROM public.users WHERE id = $1", claims.get("sub")
    )
    if username != DEMO_USER_USERNAME:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Reset de dados só está disponível para a conta demo.",
        )

    from app.seed.demo_reset_service import reset_demo_data
    await reset_demo_data(admin_conn)
