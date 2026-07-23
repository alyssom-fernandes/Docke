from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import httpx

from app.config import settings
from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services import rate_limit, storage_service
from app.services.companies_service import CompaniesService

router = APIRouter(prefix="/companies", tags=["companies"])


class CompanyCreate(BaseModel):
    name: str


class CompanyUpdate(BaseModel):
    name: str | None = None
    cnpj: str | None = None
    is_active: bool | None = None
    logo_key: str | None = None


async def _can_manage_company(conn: asyncpg.Connection, user_id: str, company_id: UUID, role: str) -> bool:
    """
    supremo (papel GLOBAL) administra qualquer empresa.
    Qualquer outro usuário administra uma empresa se tiver permission_level='admin'
    NAQUELA empresa especificamente (user_company_access) — isso é independente do
    papel global (public.users.role), que normalmente é 'usuario' para admins de
    empresa criados via ADR-033. Checar o papel global aqui bloquearia todo admin
    de empresa comum de gerenciar a própria empresa — bug já cometido uma vez
    (mesma classe do bug corrigido em _require_manager).
    """
    if role == "supremo":
        return True
    return await CompaniesService.user_manages_company(conn, user_id, company_id)


@router.get("")
async def list_companies(
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Lista as empresas às quais o usuário autenticado tem acesso.
    RLS filtra automaticamente — retorna apenas as empresas do usuário.
    """
    rows = await CompaniesService.list_companies(conn)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# ADR-014 — Gerenciamento de Organizações/Empresas
# DEVE vir antes de /{company_id} — senão "organizations" é capturado como
# se fosse um UUID de company_id (bug de ordenação de rotas do FastAPI).
# ---------------------------------------------------------------------------

@router.get("/organizations")
async def list_organizations(
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """
    Lista empresas para a tela de gerenciamento (ADR-014).
    supremo (papel global): todas as empresas do sistema (ativas e inativas).
    Qualquer outro usuário: apenas as empresas onde tem permission_level='admin'
    (checagem por empresa, não pelo papel global — ver nota em _can_manage_company).
    Sem empresas administradas = lista vazia, não 403 (mesmo padrão de GET /companies).
    """
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)

    rows = (
        await CompaniesService.list_organizations_all(admin_conn)
        if role == "supremo"
        else await CompaniesService.list_organizations_managed_by(admin_conn, user_id)
    )
    return [dict(r) for r in rows]


@router.get("/{company_id}")
async def get_company(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Retorna os dados de uma empresa (apenas se o usuário tiver acesso)."""
    row = await CompaniesService.get_company(conn, company_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
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

    company = await CompaniesService.create_company(admin_conn, name=body.name, user_id=user_id)
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
    """
    Retorna lista de concessões de acesso da empresa (uma linha por concessão —
    um mesmo usuário pode ter múltiplas linhas, cada uma escopada a uma pasta
    diferente, ou uma única linha com folder_id nulo = acesso à empresa toda).
    """
    rows = await CompaniesService.list_members(conn, company_id)
    return [dict(r) for r in rows]


@router.get("/{company_id}/stats")
async def company_stats(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Contadores de documentos, pastas, favoritos e uploads recentes da
    empresa. total_documents/total_folders/recent_uploads vêm de uma
    materialized view (Fase 3.1) — como ela não tem RLS (limitação do
    Postgres para materialized views), a checagem de membro é manual aqui.
    """
    if not await CompaniesService.is_member(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem acesso a esta empresa.")
    if await CompaniesService.has_unscoped_access(conn, claims["sub"], company_id):
        row = await CompaniesService.get_stats(conn, company_id)
        if row is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    else:
        # Fase 3.8: concessão restrita a pasta não pode ver o agregado da
        # empresa inteira que a materialized view carrega — cai pro cálculo
        # ao vivo, que respeita RLS.
        row = await CompaniesService.get_stats_live(conn, company_id)
    return dict(row)


@router.post("/{company_id}/stats/refresh")
async def refresh_company_stats(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Fase 3.3: atualização manual sob demanda, com cooldown de 15s por
    empresa (não por usuário — se alguém já atualizou há 5s, o dado já
    está fresco pra todo mundo, não faz sentido cada usuário ter seu
    próprio cooldown).
    """
    if not await CompaniesService.is_member(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem acesso a esta empresa.")
    if not rate_limit.check_and_record(f"stats-refresh:{company_id}", max_count=1, window_seconds=15):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Aguarde alguns segundos antes de atualizar de novo.")
    await CompaniesService.refresh_stats(conn)
    if await CompaniesService.has_unscoped_access(conn, claims["sub"], company_id):
        row = await CompaniesService.get_stats(conn, company_id)
    else:
        row = await CompaniesService.get_stats_live(conn, company_id)
    return dict(row)


@router.get("/{company_id}/stats/charts")
async def company_stats_charts(
    company_id: UUID,
    days: int = Query(14, description="Janela do gráfico de uploads — filtro global do dashboard."),
    folder_id: UUID | None = Query(None, description="Filtro próprio do gráfico de pastas — desce um nível na árvore."),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Fase 3.2/3.4/3.7: série diária de uploads + documentos por pasta, pra
    dashboard. Sempre calculado ao vivo via RLS — nunca da materialized
    view (aqui a quebra por pasta é o dado sensível).
    """
    if days not in (7, 14, 30, 90):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="days precisa ser 7, 14, 30 ou 90.")
    if not await CompaniesService.is_member(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem acesso a esta empresa.")
    return await CompaniesService.get_dashboard_charts(conn, company_id, days=days, folder_id=folder_id)


@router.patch("/{company_id}")
async def update_company(
    company_id: UUID,
    body: CompanyUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Atualiza dados de uma empresa (ADR-014).
    supremo: qualquer campo, qualquer empresa (inclusive is_active — desativar/reativar).
    admin: apenas name/cnpj/logo_key de empresas que administra — não pode desativar.
    """
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")

    if body.is_active is not None and role != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas supremo pode ativar/desativar empresas.")

    if body.cnpj is not None:
        digits = "".join(ch for ch in body.cnpj if ch.isdigit())
        if digits and len(digits) != 14:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="CNPJ deve ter 14 dígitos.")
        body.cnpj = digits or None

    row = await CompaniesService.update_company(
        admin_conn,
        company_id=company_id, name=body.name,
        cnpj_provided="cnpj" in body.model_fields_set, cnpj=body.cnpj,
        is_active=body.is_active, logo_key=body.logo_key,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    return dict(row)


class LogoUploadRequest(BaseModel):
    content_type: str


@router.post("/{company_id}/logo-upload-url")
async def get_logo_upload_url(
    company_id: UUID,
    body: LogoUploadRequest,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Gera URL pré-assinada para upload do logo da empresa (ADR-014)."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")

    ext_map = {"image/png": "png", "image/jpeg": "jpg", "image/svg+xml": "svg", "image/webp": "webp"}
    ext = ext_map.get(body.content_type)
    if ext is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Formato de imagem não suportado.")

    key = f"company-logos/{company_id}.{ext}"
    upload_url, expires_at = storage_service.generate_upload_url(key=key, content_type=body.content_type)
    return {"upload_url": upload_url, "logo_key": key, "expires_at": expires_at.isoformat()}


@router.get("/{company_id}/logo-url")
async def get_logo_url(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Resolve o logo_key salvo em uma URL de visualização pré-assinada (5min)."""
    row = await CompaniesService.get_logo_key(conn, company_id)
    if row is None or row["logo_key"] is None:
        return {"logo_url": None}
    ext = row["logo_key"].rsplit(".", 1)[-1].lower()
    content_type = {"png": "image/png", "jpg": "image/jpeg", "svg": "image/svg+xml", "webp": "image/webp"}.get(ext, "application/octet-stream")
    url, expires_at = storage_service.generate_preview_url(key=row["logo_key"], content_type=content_type)
    return {"logo_url": url, "expires_at": expires_at.isoformat()}


# ---------------------------------------------------------------------------
# ADR-033 — Criação direta de usuário (substitui convite por e-mail do ADR-015)
# Admin/supremo define username, nome, e-mail (usado só como credencial de
# login no Supabase Auth — nenhum e-mail de convite é disparado) e senha
# inicial. O usuário troca a senha depois em Configurações → Segurança.
# ---------------------------------------------------------------------------

class MemberCreate(BaseModel):
    email: str
    password: str
    username: str
    full_name: str
    permission_level: str = "visualizador"  # visualizador | operador | admin
    folder_id: UUID | None = None  # None = acesso à empresa toda


@router.post("/{company_id}/members", status_code=status.HTTP_201_CREATED)
async def create_member(
    company_id: UUID,
    body: MemberCreate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Cria um usuário diretamente (ADR-033) e concede acesso à empresa.
    Sem fluxo de convite/e-mail — a conta já nasce pronta para login.
    """
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    if body.permission_level not in ("visualizador", "operador", "admin"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="permission_level inválido.")
    if len(body.password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A senha deve ter no mínimo 8 caracteres.")

    if await CompaniesService.username_exists(admin_conn, body.username):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username já existe.")

    folder_path = None
    if body.folder_id is not None:
        folder_path = await CompaniesService.get_folder_path(admin_conn, body.folder_id, company_id)
        if folder_path is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada nesta empresa.")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.SUPABASE_URL}/auth/v1/admin/users",
            headers={
                "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
            },
            json={"email": body.email, "password": body.password, "email_confirm": True},
            timeout=10.0,
        )
    if resp.status_code not in (200, 201):
        detail = resp.json().get("msg") or "Não foi possível criar a conta com este e-mail."
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)
    new_user_id = resp.json().get("id")

    # Os dois inserts (public.users + concessão de acesso) precisam ser
    # atômicos entre si — sem isso, uma falha no segundo deixa um usuário
    # órfão no banco (sem nenhum acesso) e ninguém consegue recriar a conta
    # com o mesmo e-mail (já existe no Supabase Auth). Se algo falhar aqui,
    # também desfazemos a conta recém-criada no Supabase Auth (compensação),
    # já que não há transação cross-sistema entre a API HTTP e o Postgres.
    try:
        async with admin_conn.transaction():
            await CompaniesService.insert_user(admin_conn, user_id=new_user_id, username=body.username, full_name=body.full_name)
            row = await CompaniesService.insert_access_grant(
                admin_conn,
                user_id=new_user_id, company_id=company_id,
                permission_level=body.permission_level, folder_path=folder_path, granted_by=user_id,
            )
    except Exception:
        async with httpx.AsyncClient() as client:
            try:
                await client.delete(
                    f"{settings.SUPABASE_URL}/auth/v1/admin/users/{new_user_id}",
                    headers={
                        "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                        "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
                    },
                    timeout=10.0,
                )
            except Exception:
                pass  # melhor esforço — se falhar, sobra uma conta Auth sem uso, não um usuário travado
        raise

    return dict(row) | {"username": body.username, "full_name": body.full_name}


class AccessGrantCreate(BaseModel):
    permission_level: str
    folder_id: UUID | None = None  # None = acesso à empresa toda


@router.post("/{company_id}/members/{member_id}/access", status_code=status.HTTP_201_CREATED)
async def add_access_grant(
    company_id: UUID,
    member_id: UUID,
    body: AccessGrantCreate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Adiciona uma concessão de acesso extra a um usuário que já tem conta na
    empresa — permite que um mesmo usuário tenha papéis diferentes em pastas
    diferentes (ex: 'operador' na pasta RH + 'visualizador' na pasta Fiscal).
    """
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    if body.permission_level not in ("visualizador", "operador", "admin"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="permission_level inválido.")

    if not await CompaniesService.member_exists(admin_conn, member_id, company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuário não é membro desta empresa.")

    folder_path = None
    if body.folder_id is not None:
        folder_path = await CompaniesService.get_folder_path(admin_conn, body.folder_id, company_id)
        if folder_path is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada nesta empresa.")

    row = await CompaniesService.insert_access_grant(
        admin_conn,
        user_id=member_id, company_id=company_id,
        permission_level=body.permission_level, folder_path=folder_path, granted_by=user_id,
    )
    return dict(row)


@router.delete("/{company_id}/access/{access_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_access_grant(
    company_id: UUID,
    access_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """Remove uma concessão específica (não necessariamente todas as do usuário)."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")

    grant = await CompaniesService.get_access_grant(admin_conn, access_id, company_id)
    if grant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Concessão não encontrada.")

    remaining = await CompaniesService.count_grants_for_user(admin_conn, grant["user_id"], company_id)
    if remaining <= 1:
        if str(grant["user_id"]) == str(user_id):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Você não pode remover seu último acesso a esta empresa.")
        # Remover a última concessão de outro usuário o deixaria sem nenhum
        # acesso e sem aparecer mais na listagem de membros (sem forma de
        # reconceder pela tela) — force usar "remover membro" nesse caso.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Esta é a última concessão deste usuário. Para removê-lo por completo, use \"Remover membro\" em vez de remover a concessão.",
        )

    await CompaniesService.delete_access_grant(admin_conn, access_id)


@router.delete("/{company_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    company_id: UUID,
    member_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """Remove o acesso de um usuário à empresa (todas as entradas de user_company_access)."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    if str(member_id) == str(user_id):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Você não pode remover o próprio acesso.")

    await CompaniesService.delete_member(admin_conn, member_id, company_id)


# ---------------------------------------------------------------------------
# ADR-025/030 — Retenção de lixeira configurável (matriz ADR-036: só supremo)
# ---------------------------------------------------------------------------

class RetentionUpdate(BaseModel):
    retention_days: int


@router.get("/{company_id}/retention")
async def get_retention(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    row = await CompaniesService.get_retention(conn, company_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    return dict(row)


@router.patch("/{company_id}/retention")
async def update_retention(
    company_id: UUID,
    body: RetentionUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Muda o limite de retenção da lixeira. Só supremo (matriz ADR-036).

    ADR-030 — fórmula de carência ao mudar a configuração:
      carência_dias = min(nova_retenção, 7)
      Itens na lixeira há MAIS tempo que a carência mantêm a regra ANTIGA
      (trash_expires_at intocado). Itens há MENOS tempo passam a valer a
      regra NOVA imediatamente (trash_expires_at recalculado a partir de
      deleted_at + nova_retenção).
    """
    role = await get_app_role(conn, claims)
    if role != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas supremo pode configurar retenção.")
    if body.retention_days <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="retention_days deve ser positivo.")

    carencia_dias = min(body.retention_days, 7)
    await CompaniesService.update_retention(
        admin_conn, company_id=company_id, retention_days=body.retention_days, carencia_dias=carencia_dias,
    )
    return {"retention_days": body.retention_days, "carencia_dias": carencia_dias}
