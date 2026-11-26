import json
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.dependencies import get_app_role, get_current_user, get_db_admin
from app.seed.demo_data import DEMO_USER_USERNAME
from app.services.admin_service import AdminService
from app.services.companies_service import CompaniesService

router = APIRouter(prefix="/admin", tags=["admin"])

# Estas rotas usam a conexão administrativa, que passa por cima do RLS. Por
# isso a checagem de quem chama é feita aqui, rota a rota, e nunca pelo papel
# global "admin": até 25/11/2026 bastava esse papel (que a conta demo pública
# tinha) para listar todas as empresas e usuários e se conceder acesso em
# qualquer empresa do banco (achado A9-40). Agora:
#   - o que alcança o sistema inteiro (sem company_id) é só do Supremo;
#   - o que alcança uma empresa exige ser admin da empresa toda nela (ou Supremo).


async def _require_supremo(conn: asyncpg.Connection, claims: dict[str, Any]) -> None:
    if await get_app_role(conn, claims) != "supremo":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Só o administrador geral do sistema vê dados de todas as empresas.",
        )


async def _require_company_manager(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID) -> str:
    """Admin da empresa toda em company_id, ou Supremo. Devolve o papel global."""
    role = await get_app_role(conn, claims)
    if role == "supremo":
        return role
    if not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    return role


# ---------------------------------------------------------------------------
# GET /admin/users — usuários de uma empresa (admin dela) ou de todas (Supremo)
# ---------------------------------------------------------------------------

@router.get("/users")
async def list_users(
    company_id: UUID | None = Query(None),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Lista usuários. Com company_id, só os membros daquela empresa."""
    if company_id is None:
        await _require_supremo(admin_conn, claims)
        rows = await AdminService.list_all_users(admin_conn)
    else:
        await _require_company_manager(admin_conn, claims, company_id)
        rows = await AdminService.list_users_by_company(admin_conn, company_id)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /admin/permissions — concessões de uma empresa
# ---------------------------------------------------------------------------

@router.get("/permissions")
async def list_permissions(
    company_id: UUID = Query(...),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Lista as entradas de user_company_access da empresa."""
    await _require_company_manager(admin_conn, claims, company_id)
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
    """
    Insere ou atualiza permissão (ON CONFLICT atualiza o permission_level).
    Supremo concede a qualquer usuário. O admin da empresa toda só concede a
    quem já é membro dela: trazer um usuário de outra empresa é decisão do
    Supremo, que enxerga o sistema inteiro.
    """
    role = await _require_company_manager(admin_conn, claims, body.company_id)

    if body.permission_level not in ("visualizador", "operador", "admin"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="permission_level deve ser visualizador, operador ou admin.",
        )

    if role != "supremo" and not await CompaniesService.member_exists(admin_conn, body.user_id, body.company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuário não é membro desta empresa.")

    if body.folder_path is not None and not await AdminService.folder_path_in_company(
        admin_conn, body.company_id, body.folder_path
    ):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada nesta empresa.")

    row = await AdminService.upsert_permission(
        admin_conn,
        user_id=body.user_id, company_id=body.company_id,
        permission_level=body.permission_level, folder_path=body.folder_path,
        granted_by=claims["sub"],
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
    """Uso de armazenamento (soma de size_bytes) de uma empresa ou, para o Supremo, de todas."""
    if company_id is None:
        await _require_supremo(admin_conn, claims)
        rows = await AdminService.storage_usage_all(admin_conn)
    else:
        await _require_company_manager(admin_conn, claims, company_id)
        rows = await AdminService.storage_usage_by_company(admin_conn, company_id)
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

    Só a própria conta demo pode chamar isso: só libera se
    `username == 'demo'`, então nenhum cliente real consegue disparar isso
    contra os próprios dados nem por engano.
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
    if not await reset_demo_data(admin_conn):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A demonstração já está sendo restaurada. Aguarde alguns segundos e recarregue a página.",
        )


@router.get("/people")
async def list_all_people(
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """
    Visão do grupo (FA-A9-04): todas as pessoas de todas as empresas, com onde
    cada uma tem acesso, situação da conta, verificação em duas etapas e
    último acesso. Só o administrador geral.
    """
    await _require_supremo(admin_conn, claims)
    rows = await admin_conn.fetch(
        """
        SELECT u.id::text AS user_id, u.full_name, u.username, u.role, u.is_active, au.email::text AS email,
               au.last_sign_in_at,
               EXISTS (SELECT 1 FROM auth.mfa_factors mf WHERE mf.user_id = u.id AND mf.status = 'verified') AS mfa_enabled,
               COALESCE((
                 SELECT json_agg(json_build_object('company_id', x.company_id::text, 'company_name', c.name, 'role', x.permission_level)
                                 ORDER BY c.name)
                 FROM (
                   SELECT DISTINCT ON (company_id) company_id, permission_level
                   FROM (
                     SELECT company_id, permission_level FROM public.user_company_access WHERE user_id = u.id
                     UNION ALL
                     SELECT ga.company_id, ga.permission_level FROM public.group_access ga
                     JOIN public.group_member gm ON gm.group_id = ga.group_id WHERE gm.user_id = u.id
                   ) t
                   ORDER BY company_id, CASE permission_level WHEN 'admin' THEN 0 WHEN 'operador' THEN 1 ELSE 2 END
                 ) x JOIN public.companies c ON c.id = x.company_id
               ), '[]') AS companies
        FROM public.users u
        LEFT JOIN auth.users au ON au.id = u.id
        ORDER BY lower(u.full_name)
        """
    )
    out = []
    for r in rows:
        d = dict(r)
        d["companies"] = json.loads(d["companies"]) if isinstance(d["companies"], str) else d["companies"]
        out.append(d)
    return out
