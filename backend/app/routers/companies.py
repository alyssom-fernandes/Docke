from datetime import date
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

import httpx

from app.config import settings
from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services import features_service, rate_limit, storage_service
from app.services.access_explain_service import AccessExplainService
from app.services.companies_service import CompaniesService
from app.services.groups_service import GroupsService

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


async def _can_manage_scope(conn: asyncpg.Connection, user_id: str, company_id: UUID, role: str, target_path: str | None) -> bool:
    """
    Fase 9.5 — corrige uma divergência conhecida: até aqui, gerenciar usuários
    (criar membro, conceder/remover acesso) exigia admin da EMPRESA TODA
    (folder_path IS NULL) — um admin escopado a uma subpasta (ex: "Admin da
    pasta Fiscal") não conseguia gerenciar acesso nem dentro do próprio
    escopo. Agora: admin da empresa toda (ou supremo) continua podendo
    gerenciar qualquer escopo; admin de subpasta só pode gerenciar acesso
    DENTRO da própria subpasta (target_path precisa ser ela mesma ou uma
    descendente) — nunca concede acesso à empresa toda (target_path=None)
    nem a um escopo fora do seu próprio.
    Usado só para as ações de "gerenciar usuários" (membro/concessão) —
    ações de empresa (configurações, retenção, grupos) continuam exigindo
    _can_manage_company (admin da empresa toda), sem mudança de escopo.
    """
    if await _can_manage_company(conn, user_id, company_id, role):
        return True
    admin_path = await CompaniesService.scoped_admin_folder_path(conn, user_id, company_id)
    if admin_path is None or target_path is None:
        return False
    return target_path == admin_path or target_path.startswith(admin_path + ".")


def _cnpj_ok(d: str) -> bool:
    """Dígitos verificadores do CNPJ (A9-10)."""
    if len(d) != 14 or d == d[0] * 14:
        return False

    def calc(n: int) -> int:
        pesos = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] if n == 12 else [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        r = sum(int(d[i]) * pesos[i] for i in range(n)) % 11
        return 0 if r < 2 else 11 - r

    return calc(12) == int(d[12]) and calc(13) == int(d[13])


@router.get("")
async def list_companies(
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Lista as empresas às quais o usuário autenticado tem acesso.
    RLS filtra automaticamente — retorna apenas as empresas do usuário.
    """
    rows = await CompaniesService.list_companies(conn)
    out = []
    for r in rows:
        d = dict(r)
        # Recursos já resolvidos (padrão + o que foi mudado): a tela se adapta sem outra chamada.
        d["features"] = features_service.merge(d.pop("features", None), d.pop("lgpd_channel_enabled", None))
        out.append(d)
    return out


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

    Só o Supremo cria empresas (achado A1-22): antes qualquer usuário logado,
    inclusive a conta demo pública, criava empresas no banco de produção.
    """
    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token inválido.")
    if await get_app_role(admin_conn, claims) != "supremo":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Só o administrador geral do sistema cria empresas.",
        )
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Informe o nome da empresa.")

    company = await CompaniesService.create_company(admin_conn, name=name, user_id=user_id)
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
        if row is not None and _stats_stale(row["refreshed_at"]) and rate_limit.check_and_record(
            "stats-auto-refresh", max_count=1, window_seconds=60,
        ):
            await CompaniesService.refresh_stats(conn)
            row = await CompaniesService.get_stats(conn, company_id)
        if row is None:
            # Empresa ainda fora da materialized view (criada depois do último
            # refresh): calcula ao vivo em vez de devolver 404 — o membro já
            # foi confirmado acima, então a empresa existe.
            row = await CompaniesService.get_stats_live(conn, company_id)
    else:
        # Fase 3.8: concessão restrita a pasta não pode ver o agregado da
        # empresa inteira que a materialized view carrega — cai pro cálculo
        # ao vivo, que respeita RLS.
        row = await CompaniesService.get_stats_live(conn, company_id)
    return {**dict(row), **await CompaniesService.stats_context(conn, company_id)}


def _stats_stale(refreshed_at: Any) -> bool:
    from datetime import datetime, timedelta, timezone
    return refreshed_at is None or datetime.now(timezone.utc) - refreshed_at > timedelta(minutes=15)


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
        if row is None:
            row = await CompaniesService.get_stats_live(conn, company_id)
    else:
        row = await CompaniesService.get_stats_live(conn, company_id)
    return {**dict(row), **await CompaniesService.stats_context(conn, company_id)}


@router.get("/{company_id}/stats/charts")
async def company_stats_charts(
    company_id: UUID,
    days: int = Query(14, description="Janela do gráfico de uploads — filtro global do dashboard."),
    folder_id: UUID | None = Query(None, description="Filtro próprio do gráfico de pastas — desce um nível na árvore."),
    only: str | None = Query(None, pattern="^(daily|folders)$", description="Só um dos dois gráficos."),
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
    return await CompaniesService.get_dashboard_charts(conn, company_id, days=days, folder_id=folder_id, only=only)


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
        if digits and (len(digits) != 14 or not _cnpj_ok(digits)):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="CNPJ inválido: confira os dígitos.")
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
    expires_on: date | None = None  # acesso temporário (B3.1.8): vale até o fim deste dia


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
    # A9-42 (decisão do dono, 26/11/2026): só o administrador geral cria contas.
    # O admin da empresa continua ajustando os acessos de quem já tem conta.
    if role != "supremo":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Só o administrador geral cria contas. Peça a ele a conta nova; depois você ajusta os acessos aqui.",
        )
    if body.permission_level not in ("visualizador", "operador", "admin"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="permission_level inválido.")
    _validar_prazo(body.expires_on)
    if len(body.password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A senha deve ter no mínimo 8 caracteres.")

    folder_path = None
    if body.folder_id is not None:
        folder_path = await CompaniesService.get_folder_path(admin_conn, body.folder_id, company_id)
        if folder_path is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada nesta empresa.")

    # Fase 9.5: admin de subpasta pode criar membro escopado à própria
    # subpasta (ou descendente); só admin da empresa toda pode conceder
    # acesso à empresa inteira (folder_id=None) ou fora do próprio escopo.
    if not await _can_manage_scope(conn, user_id, company_id, role, folder_path):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra este escopo.")

    if await CompaniesService.username_exists(admin_conn, body.username):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username já existe.")

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
            await _gravar_prazo(admin_conn, row["id"], body.expires_on)
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
    expires_on: date | None = None  # acesso temporário (B3.1.8): vale até o fim deste dia


def _validar_prazo(d: date | None) -> None:
    if d is not None and d < date.today():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O prazo do acesso não pode estar no passado.")


async def _gravar_prazo(admin_conn: asyncpg.Connection, access_id: Any, d: date | None) -> None:
    if d is None:
        return
    from app.services.access_expiry import fim_do_dia

    await admin_conn.execute("UPDATE public.user_company_access SET expires_at = $2 WHERE id = $1", access_id, fim_do_dia(d))


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
    if body.permission_level not in ("visualizador", "operador", "admin"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="permission_level inválido.")

    if not await CompaniesService.member_exists(admin_conn, member_id, company_id):
        # A9-27: o administrador geral (dono das contas, A9-42) põe uma conta
        # ativa em outra empresa do grupo já com o acesso; o admin da empresa
        # só ajusta quem já é dela.
        ativo = role == "supremo" and await admin_conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.users WHERE id = $1 AND is_active IS NOT FALSE)", member_id,
        )
        if not ativo:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuário não é membro desta empresa.")

    folder_path = None
    if body.folder_id is not None:
        folder_path = await CompaniesService.get_folder_path(admin_conn, body.folder_id, company_id)
        if folder_path is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada nesta empresa.")

    # Fase 9.5: mesmo escopo de create_member — admin de subpasta gerencia
    # concessões só dentro da própria subpasta.
    if not await _can_manage_scope(conn, user_id, company_id, role, folder_path):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra este escopo.")

    try:
        async with admin_conn.transaction():
            _validar_prazo(body.expires_on)
            row = await CompaniesService.insert_access_grant(
                admin_conn,
                user_id=member_id, company_id=company_id,
                permission_level=body.permission_level, folder_path=folder_path, granted_by=user_id,
            )
            await _gravar_prazo(admin_conn, row["id"], body.expires_on)
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A pessoa já tem acesso neste lugar. Para mudar o que ela pode fazer, troque o papel da concessão existente.",
        )
    nome = await admin_conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", member_id)
    await CompaniesService.log_access(admin_conn, actor_id=user_id, company_id=company_id, action="access_grant",
                                      target_id=member_id, target_name=nome or "pessoa",
                                      metadata={"papel": body.permission_level, "onde": await _scope_label(admin_conn, company_id, folder_path),
                                                "ate": body.expires_on.isoformat() if body.expires_on else None})
    return dict(row) | {"expires_on": body.expires_on}


async def _scope_label(admin_conn: asyncpg.Connection, company_id: UUID, folder_path: str | None) -> str:
    if not folder_path:
        return "Empresa toda"
    return await admin_conn.fetchval(
        """
        SELECT string_agg(anc.name, ' / ' ORDER BY nlevel(anc.path)) FROM public.folders anc
        WHERE anc.company_id = $1 AND anc.path @> $2::ltree
        """,
        company_id, folder_path,
    ) or "pasta"


class AccessGrantUpdate(BaseModel):
    permission_level: str


@router.patch("/{company_id}/access/{access_id}")
async def update_access_grant(
    company_id: UUID,
    access_id: UUID,
    body: AccessGrantUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Troca o papel de uma concessão no mesmo lugar (A9-17)."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if body.permission_level not in ("visualizador", "operador", "admin"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Papel inválido.")
    grant = await admin_conn.fetchrow(
        "SELECT id, user_id, folder_path::text, permission_level FROM public.user_company_access WHERE id = $1 AND company_id = $2",
        access_id, company_id,
    )
    if grant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Concessão não encontrada.")
    if not await _can_manage_scope(conn, user_id, company_id, role, grant["folder_path"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra este escopo.")
    if grant["permission_level"] == body.permission_level:
        return {"id": str(access_id), "permission_level": body.permission_level}
    if (
        grant["permission_level"] == "admin" and grant["folder_path"] is None
        and await CompaniesService.company_admin_count(admin_conn, company_id) <= 1
    ):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Esta é a única pessoa que administra a empresa. Dê o papel de admin a outra antes.")
    await admin_conn.execute("UPDATE public.user_company_access SET permission_level = $2 WHERE id = $1", access_id, body.permission_level)
    nome = await admin_conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", grant["user_id"])
    await CompaniesService.log_access(admin_conn, actor_id=user_id, company_id=company_id, action="access_role_change",
                                      target_id=grant["user_id"], target_name=nome or "pessoa",
                                      metadata={"de": grant["permission_level"], "para": body.permission_level,
                                                "onde": await _scope_label(admin_conn, company_id, grant["folder_path"])})
    return {"id": str(access_id), "permission_level": body.permission_level}


@router.get("/{company_id}/people")
async def list_people(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Pessoas com concessões diretas e por grupo, estado da conta e último acesso (A9-18). Só quem administra a empresa."""
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, claims["sub"], company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    return await CompaniesService.list_people(admin_conn, company_id)


async def _require_account_control(conn, admin_conn, actor_id: str, company_id: UUID, role: str, target_id: UUID) -> str:
    """Valida quem pode desativar/trocar senha de alguém e devolve o nome da pessoa."""
    if not await _can_manage_company(conn, actor_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    if str(target_id) == str(actor_id):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Use Ajustes → Segurança para a sua própria conta.")
    target = await admin_conn.fetchrow("SELECT full_name, role FROM public.users WHERE id = $1", target_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pessoa não encontrada.")
    if target["role"] == "supremo" and role != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador geral altera a conta de outro administrador geral.")
    if role != "supremo" and not await CompaniesService.manages_all_companies_of(admin_conn, actor_id, target_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Esta pessoa também acessa empresas que você não administra. Remova o acesso dela a esta empresa ou peça ao administrador geral.",
        )
    return target["full_name"]


@router.post("/{company_id}/members/{member_id}/deactivate")
async def deactivate_member(
    company_id: UUID,
    member_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Desativa a conta sem apagar nada (A9-16): a pessoa não entra mais e as
    sessões abertas param na próxima chamada (a API recusa conta inativa).
    O histórico e os documentos dela continuam.
    """
    role = await get_app_role(conn, claims)
    nome = await _require_account_control(conn, admin_conn, claims["sub"], company_id, role, member_id)
    # A API recusa conta inativa em toda chamada e na renovação do token:
    # as sessões abertas param na próxima ação da pessoa.
    await admin_conn.execute("UPDATE public.users SET is_active = false WHERE id = $1", member_id)
    # Encerra também as sessões abertas: o corte vale na hora (FA-A9-10).
    await admin_conn.execute("DELETE FROM auth.sessions WHERE user_id = $1", member_id)
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="account_deactivate",
                                      target_id=member_id, target_name=nome)
    return {"user_id": str(member_id), "is_active": False}


@router.post("/{company_id}/members/{member_id}/activate")
async def activate_member(
    company_id: UUID,
    member_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = await get_app_role(conn, claims)
    nome = await _require_account_control(conn, admin_conn, claims["sub"], company_id, role, member_id)
    await admin_conn.execute("UPDATE public.users SET is_active = true WHERE id = $1", member_id)
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="account_activate",
                                      target_id=member_id, target_name=nome)
    return {"user_id": str(member_id), "is_active": True}


@router.post("/{company_id}/members/{member_id}/reset-password")
async def reset_member_password(
    company_id: UUID,
    member_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Senha provisória (A9-16): gerada aqui, mostrada uma vez ao admin para
    entregar à pessoa, que troca no primeiro acesso. Não depende de e-mail.
    """
    import secrets as _secrets

    role = await get_app_role(conn, claims)
    nome = await _require_account_control(conn, admin_conn, claims["sub"], company_id, role, member_id)
    email = await admin_conn.fetchval("SELECT email FROM auth.users WHERE id = $1", member_id)
    if email and email.lower() == settings.DEMO_EMAIL.lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="A conta de demonstração não troca de senha por aqui.")
    alfabeto = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    provisoria = "-".join("".join(_secrets.choice(alfabeto) for _ in range(4)) for _ in range(3))
    async with httpx.AsyncClient() as client:
        resp = await client.put(
            f"{settings.SUPABASE_URL}/auth/v1/admin/users/{member_id}",
            headers={
                "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
            },
            json={"password": provisoria},
            timeout=10.0,
        )
    if resp.status_code not in (200, 201):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Não foi possível trocar a senha agora. Tente de novo.")
    await admin_conn.execute("UPDATE public.users SET must_change_password = true WHERE id = $1", member_id)
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="account_password_reset",
                                      target_id=member_id, target_name=nome)
    return {"temporary_password": provisoria}


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

    grant = await CompaniesService.get_access_grant(admin_conn, access_id, company_id)
    if grant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Concessão não encontrada.")

    # Fase 9.5: admin de subpasta só remove concessões dentro do próprio escopo.
    if not await _can_manage_scope(conn, user_id, company_id, role, grant["folder_path"]):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra este escopo.")

    remaining = await CompaniesService.count_grants_for_user(admin_conn, grant["user_id"], company_id)
    # Quem também recebe acesso por grupo pode ficar sem concessão direta (A9-37).
    if remaining <= 1 and not await CompaniesService.has_group_access(admin_conn, grant["user_id"], company_id):
        if str(grant["user_id"]) == str(user_id):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Você não pode remover seu último acesso a esta empresa.")
        # Remover a última concessão de outro usuário o deixaria sem nenhum
        # acesso e sem aparecer mais na listagem de membros (sem forma de
        # reconceder pela tela) — force usar "remover membro" nesse caso.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Esta é a última concessão deste usuário. Para removê-lo por completo, use \"Remover membro\" em vez de remover a concessão.",
        )

    detalhe = await admin_conn.fetchrow(
        "SELECT permission_level, folder_path::text FROM public.user_company_access WHERE id = $1", access_id,
    )
    await CompaniesService.delete_access_grant(admin_conn, access_id)
    nome = await admin_conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", grant["user_id"])
    await CompaniesService.log_access(admin_conn, actor_id=user_id, company_id=company_id, action="access_revoke",
                                      target_id=grant["user_id"], target_name=nome or "pessoa",
                                      metadata={"papel": detalhe["permission_level"] if detalhe else None,
                                                "onde": await _scope_label(admin_conn, company_id, detalhe["folder_path"] if detalhe else None)})


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

    nome = await admin_conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", member_id)
    await CompaniesService.delete_member(admin_conn, member_id, company_id)
    # Sai também dos grupos desta empresa: senão continuaria vendo pelo grupo.
    await admin_conn.execute(
        """
        DELETE FROM public.group_member gm USING public."group" g
        WHERE gm.group_id = g.id AND g.company_id = $2 AND gm.user_id = $1
        """,
        member_id, company_id,
    )
    await CompaniesService.log_access(admin_conn, actor_id=user_id, company_id=company_id, action="member_remove",
                                      target_id=member_id, target_name=nome or "pessoa")


# ---------------------------------------------------------------------------
# Fase 9.2 — Grupos (atribuição de acesso por grupo, além da concessão direta)
# ---------------------------------------------------------------------------

class GroupCreate(BaseModel):
    name: str


@router.get("/{company_id}/groups")
async def list_groups(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await GroupsService.list_groups(conn, company_id)
    return [dict(r) for r in rows]


@router.get("/{company_id}/groups/{group_id}")
async def get_group(
    company_id: UUID,
    group_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    detail = await GroupsService.get_group_detail(conn, group_id, company_id)
    if detail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grupo não encontrado.")
    return detail


@router.post("/{company_id}/groups", status_code=status.HTTP_201_CREATED)
async def create_group(
    company_id: UUID,
    body: GroupCreate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nome do grupo é obrigatório.")
    if await GroupsService.name_exists(admin_conn, company_id, name):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe um grupo com esse nome nesta empresa.")

    row = await GroupsService.create_group(admin_conn, company_id=company_id, name=name, created_by=user_id)
    return dict(row)


@router.delete("/{company_id}/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    company_id: UUID,
    group_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    if not await GroupsService.group_exists(admin_conn, group_id, company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grupo não encontrado.")

    await GroupsService.delete_group(admin_conn, group_id)


class GroupMemberAdd(BaseModel):
    user_id: UUID


@router.post("/{company_id}/groups/{group_id}/members", status_code=status.HTTP_201_CREATED)
async def add_group_member(
    company_id: UUID,
    group_id: UUID,
    body: GroupMemberAdd,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    if not await GroupsService.group_exists(admin_conn, group_id, company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grupo não encontrado.")
    # A9-37: o administrador geral põe qualquer conta ativa no grupo, e o grupo
    # passa a ser o acesso dela à empresa. O admin da empresa só põe quem já é
    # da empresa (A9-42: as contas são do administrador geral; ele não descobre
    # contas de outras empresas por aqui).
    if role == "supremo":
        if not await admin_conn.fetchval("SELECT EXISTS (SELECT 1 FROM public.users WHERE id = $1 AND is_active IS NOT FALSE)", body.user_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuário não encontrado.")
    elif not await GroupsService.member_of_company(admin_conn, body.user_id, company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuário não é membro desta empresa.")

    await GroupsService.add_member(admin_conn, group_id, body.user_id)
    return {"group_id": str(group_id), "user_id": str(body.user_id)}


@router.delete("/{company_id}/groups/{group_id}/members/{member_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_group_member(
    company_id: UUID,
    group_id: UUID,
    member_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    if not await GroupsService.group_exists(admin_conn, group_id, company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grupo não encontrado.")

    await GroupsService.remove_member(admin_conn, group_id, member_id)


class GroupAccessGrantCreate(BaseModel):
    permission_level: str
    folder_id: UUID | None = None


@router.post("/{company_id}/groups/{group_id}/access", status_code=status.HTTP_201_CREATED)
async def add_group_access_grant(
    company_id: UUID,
    group_id: UUID,
    body: GroupAccessGrantCreate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    if body.permission_level not in ("visualizador", "operador", "admin"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="permission_level inválido.")
    if not await GroupsService.group_exists(admin_conn, group_id, company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Grupo não encontrado.")

    folder_path = None
    if body.folder_id is not None:
        folder_path = await GroupsService.get_folder_path(admin_conn, body.folder_id, company_id)
        if folder_path is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada nesta empresa.")

    row = await GroupsService.insert_access_grant(
        admin_conn,
        group_id=group_id, company_id=company_id,
        permission_level=body.permission_level, folder_path=folder_path, granted_by=user_id,
    )
    return dict(row)


@router.delete("/{company_id}/groups/{group_id}/access/{access_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_group_access_grant(
    company_id: UUID,
    group_id: UUID,
    access_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, user_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")

    grant = await GroupsService.get_access_grant(admin_conn, access_id, company_id)
    if grant is None or str(grant["group_id"]) != str(group_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Concessão não encontrada.")

    await GroupsService.delete_access_grant(admin_conn, access_id)


# ---------------------------------------------------------------------------
# Fase 9.3 — Explain Access: mostra a cadeia de motivos por trás do acesso
# efetivo de um usuário (direto vs. grupo, especificidade, quem venceu).
# ---------------------------------------------------------------------------

@router.get("/{company_id}/explain-access")
async def explain_access(
    company_id: UUID,
    user_id: UUID = Query(...),
    folder_id: UUID | None = Query(None),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    actor_id = claims["sub"]
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, actor_id, company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")

    target_path = None
    if folder_id is not None:
        target_path = await AccessExplainService.get_folder_path(admin_conn, folder_id, company_id)
        if target_path is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada nesta empresa.")

    return await AccessExplainService.explain(admin_conn, user_id=user_id, company_id=company_id, target_path=target_path)


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


# ---------------------------------------------------------------------------
# Exportação completa (achado X2-16): pedir e listar, só admin da empresa
# ---------------------------------------------------------------------------

@router.post("/{company_id}/exports", status_code=status.HTTP_202_ACCEPTED)
async def request_export(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Põe na fila uma exportação de todos os documentos, pastas, metadados e trilha."""
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, claims["sub"], company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o admin da empresa exporta os documentos dela.")
    em_andamento = await admin_conn.fetchval(
        "SELECT id FROM public.company_exports WHERE company_id = $1 AND status IN ('pending', 'processing')",
        company_id,
    )
    if em_andamento:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já há uma exportação desta empresa em andamento.")
    export_id = await admin_conn.fetchval(
        "INSERT INTO public.company_exports (company_id, requested_by) VALUES ($1, $2) RETURNING id",
        company_id, claims["sub"],
    )
    return {"id": str(export_id), "status": "pending"}


@router.get("/{company_id}/exports")
async def list_exports(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """As 10 últimas exportações, com links de download (1 h) das que estão prontas."""
    import json as _json

    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, claims["sub"], company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o admin da empresa exporta os documentos dela.")
    rows = await admin_conn.fetch(
        """
        SELECT e.id::text, e.status, e.parts, e.document_count, e.total_bytes, e.hash_mismatches,
               e.error_message, e.created_at, e.finished_at, e.expires_at, u.full_name AS requested_by_name
        FROM public.company_exports e
        LEFT JOIN public.users u ON u.id = e.requested_by
        WHERE e.company_id = $1
        ORDER BY e.created_at DESC
        LIMIT 10
        """,
        company_id,
    )
    out = []
    for r in rows:
        item = dict(r)
        parts = item["parts"] if isinstance(item["parts"], list) else _json.loads(item["parts"] or "[]")
        if item["status"] == "done":
            for part in parts:
                part["download_url"], _exp = storage_service.generate_download_url(
                    key=part["key"], filename=part["name"], content_type="application/zip",
                )
                part.pop("key", None)
        else:
            for part in parts:
                part.pop("key", None)
        item["parts"] = parts
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# Verificação em duas etapas por empresa (decisão do dono, 26/11/2026)
# ---------------------------------------------------------------------------

_POLITICAS_MFA = ("desligada", "admins", "admins_sensiveis", "todos")


class MfaPolicy(BaseModel):
    policy: str
    motivo: str | None = None  # B4.2.7


@router.get("/{company_id}/mfa-policy")
async def get_mfa_policy(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    pol = await conn.fetchval("SELECT mfa_policy FROM public.companies WHERE id = $1", company_id)
    if pol is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    return {"policy": pol, "can_edit": await get_app_role(conn, claims) == "supremo"}


@router.put("/{company_id}/mfa-policy")
async def put_mfa_policy(
    company_id: UUID,
    body: MfaPolicy,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Quem precisa da verificação em duas etapas nesta empresa. Só o administrador geral muda."""
    if await get_app_role(conn, claims) != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador geral muda esta regra.")
    if body.policy not in _POLITICAS_MFA:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Política inválida.")
    antes = await admin_conn.fetchval("SELECT mfa_policy FROM public.companies WHERE id = $1", company_id)
    if antes is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    await admin_conn.execute("UPDATE public.companies SET mfa_policy = $2 WHERE id = $1", company_id, body.policy)
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="mfa_policy",
                                      target_id=company_id, target_name="Verificação em duas etapas",
                                      metadata={"antes": antes, "depois": body.policy,
                                                **({"motivo": body.motivo.strip()[:300]} if (body.motivo or "").strip() else {})})
    return {"policy": body.policy, "can_edit": True}


@router.post("/{company_id}/members/{member_id}/reset-mfa")
async def reset_member_mfa(
    company_id: UUID,
    member_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Celular perdido ou trocado: o administrador geral apaga o app autenticador
    da pessoa, que cadastra de novo no próximo acesso (se a política exigir).
    """
    role = await get_app_role(conn, claims)
    if role != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador geral zera a verificação em duas etapas.")
    nome = await _require_account_control(conn, admin_conn, claims["sub"], company_id, role, member_id)
    fatores = await admin_conn.fetch("SELECT id::text FROM auth.mfa_factors WHERE user_id = $1", member_id)
    async with httpx.AsyncClient() as client:
        for f in fatores:
            resp = await client.delete(
                f"{settings.SUPABASE_URL}/auth/v1/admin/users/{member_id}/factors/{f['id']}",
                headers={"apikey": settings.SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}"},
                timeout=10.0,
            )
            if resp.status_code not in (200, 204, 404):
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Não foi possível zerar agora. Tente de novo.")
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="mfa_reset",
                                      target_id=member_id, target_name=nome)
    from app.services.notification_service import security_alert_admins
    await security_alert_admins(
        admin_conn, company_id, f"A verificação em duas etapas de {nome} foi zerada pelo administrador geral.",
        except_user=claims["sub"], also_user=str(member_id),
    )
    return {"user_id": str(member_id), "removidos": len(fatores)}


@router.post("/{company_id}/members/{member_id}/end-sessions")
async def end_member_sessions(
    company_id: UUID,
    member_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Encerra todas as sessões de alguém (celular perdido, saída da empresa) — FA-A8-02, FA-A9-10."""
    role = await get_app_role(conn, claims)
    nome = await _require_account_control(conn, admin_conn, claims["sub"], company_id, role, member_id)
    email = await admin_conn.fetchval("SELECT email FROM auth.users WHERE id = $1", member_id)
    if email and email.lower() == settings.DEMO_EMAIL.lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="A conta de demonstração não encerra sessões.")
    res = await admin_conn.execute("DELETE FROM auth.sessions WHERE user_id = $1", member_id)
    n = int(res.split()[-1])
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="sessions_end",
                                      target_id=member_id, target_name=nome, metadata={"encerradas": n})
    return {"user_id": str(member_id), "encerradas": n}


@router.get("/{company_id}/people/{member_id}/reach")
async def person_reach(
    company_id: UUID,
    member_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Busca reversa (FA-A9-07): o que esta pessoa acessa nesta empresa, pasta a
    pasta, com o papel que vale em cada uma (direto, herdado ou por grupo).
    """
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, claims["sub"], company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só quem administra a empresa vê o alcance de outra pessoa.")
    empresa_toda = await admin_conn.fetchval(
        "SELECT public.user_has_access($1, NULL::ltree, $2)", member_id, company_id,
    )
    rows = await admin_conn.fetch(
        """
        SELECT f.id::text, f.name, f.path::text AS path, nlevel(f.path) AS depth,
               public.user_has_access($1, f.path, $2) AS role,
               public.folder_effective_sensitivity(f.id) AS sensitivity
        FROM public.folders f
        WHERE f.company_id = $2 AND f.deleted_at IS NULL
        ORDER BY f.path
        LIMIT 2000
        """,
        member_id, company_id,
    )
    pastas = [dict(r) for r in rows if r["role"]]
    return {
        "company_role": empresa_toda,
        "folders": pastas,
        "total_folders": len(rows),
        "sensitive_count": sum(1 for p in pastas if p["sensitivity"] in ("pessoal", "sensivel")),
    }


@router.get("/{company_id}/groups/{group_id}/impact")
async def group_impact(
    company_id: UUID,
    group_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Prévia de impacto (B3.1.5) antes de excluir o grupo: quem perde os
    acessos dele e quem fica sem nenhum acesso à empresa.
    """
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, claims["sub"], company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    rows = await admin_conn.fetch(
        """
        SELECT u.full_name,
               NOT EXISTS (SELECT 1 FROM public.user_company_access a WHERE a.user_id = u.id AND a.company_id = $1)
               AND NOT EXISTS (
                 SELECT 1 FROM public.group_member gm2 JOIN public.group_access ga2 ON ga2.group_id = gm2.group_id
                 WHERE gm2.user_id = u.id AND ga2.company_id = $1 AND gm2.group_id <> $2
               ) AS fica_sem_acesso
        FROM public.group_member gm JOIN public.users u ON u.id = gm.user_id
        WHERE gm.group_id = $2
        ORDER BY u.full_name
        """,
        company_id, group_id,
    )
    return {"membros": len(rows), "ficam_sem_acesso": [r["full_name"] for r in rows if r["fica_sem_acesso"]]}


class VersionsPolicy(BaseModel):
    keep_days: int | None = None  # None = para sempre


@router.get("/{company_id}/versions-policy")
async def get_versions_policy(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    row = await conn.fetchrow("SELECT versions_keep_days FROM public.companies WHERE id = $1", company_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    return {"keep_days": row["versions_keep_days"], "can_edit": await get_app_role(conn, claims) == "supremo"}


@router.put("/{company_id}/versions-policy")
async def put_versions_policy(
    company_id: UUID,
    body: VersionsPolicy,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Retenção do histórico de versões (B1.4.9). Apaga dado: só o administrador geral muda."""
    if await get_app_role(conn, claims) != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador geral muda por quanto tempo as versões antigas ficam guardadas.")
    if body.keep_days is not None and not (30 <= body.keep_days <= 3650):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O prazo vai de 30 a 3.650 dias (ou para sempre).")
    antes = await admin_conn.fetchval("SELECT versions_keep_days FROM public.companies WHERE id = $1", company_id)
    await admin_conn.execute("UPDATE public.companies SET versions_keep_days = $2 WHERE id = $1", company_id, body.keep_days)
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
        VALUES ($1::uuid, $2, 'versions_policy', 'config', $2, 'Histórico de versões', 'config', jsonb_build_object('antes', $3::int, 'depois', $4::int))
        """,
        claims["sub"], company_id, antes, body.keep_days,
    )
    return {"keep_days": body.keep_days, "can_edit": True}


# ---------------------------------------------------------------------------
# Pedido de acesso (B3.1.6)
# ---------------------------------------------------------------------------

class AccessRequestCreate(BaseModel):
    folder_id: UUID
    message: str | None = None


@router.post("/access-requests", status_code=status.HTTP_201_CREATED)
async def create_access_request(
    body: AccessRequestCreate,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Quem é da empresa e não acessa a pasta pede acesso. Para quem não é da
    empresa a pasta "não existe" (não confirma nem o nome).
    """
    uid = claims["sub"]
    if not rate_limit.check_and_record(f"access-req:{uid}", 20, 3600):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Muitos pedidos em pouco tempo. Tente mais tarde.")
    pasta = await admin_conn.fetchrow(
        "SELECT id, company_id, path, name FROM public.folders WHERE id = $1 AND deleted_at IS NULL", body.folder_id,
    )
    membro = pasta is not None and await admin_conn.fetchval(
        """
        SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)
            OR EXISTS (SELECT 1 FROM public.group_member gm JOIN public.group_access ga ON ga.group_id = gm.group_id
                       WHERE gm.user_id = $1 AND ga.company_id = $2)
        """,
        uid, pasta["company_id"],
    )
    if not membro:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    if await admin_conn.fetchval("SELECT public.user_has_access($1, $2, $3)", uid, pasta["path"], pasta["company_id"]):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Você já acessa esta pasta.")
    try:
        row = await admin_conn.fetchrow(
            """
            INSERT INTO public.access_requests (company_id, folder_id, requester_id, message)
            VALUES ($1, $2, $3, $4) RETURNING id::text, created_at
            """,
            pasta["company_id"], pasta["id"], uid, (body.message or "").strip()[:500] or None,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Você já pediu acesso a esta pasta; o pedido está com o admin da empresa.")
    nome = await admin_conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", uid)
    admins = await admin_conn.fetch(
        """
        SELECT DISTINCT user_id FROM public.user_company_access
        WHERE company_id = $1 AND permission_level = 'admin' AND folder_path IS NULL AND user_id <> $2
        """,
        pasta["company_id"], uid,
    )
    for a in admins:
        await admin_conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, actor_user_id, message)
            VALUES ($1, $2, 'access_request', 'folder', $3, $4, $5)
            """,
            a["user_id"], pasta["company_id"], pasta["id"], uid, f'{nome} pediu acesso à pasta "{pasta["name"]}". Responda em Pessoas e acessos.',
        )
    return dict(row) | {"status": "pendente"}


@router.get("/{company_id}/access-requests")
async def list_access_requests(
    company_id: UUID,
    status_filtro: str = Query("pendente", alias="status"),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    role = await get_app_role(conn, claims)
    if not await _can_manage_company(conn, claims["sub"], company_id, role):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")
    rows = await admin_conn.fetch(
        """
        SELECT r.id::text, r.folder_id::text, f.name AS folder_name, r.requester_id::text, u.full_name AS requester_name,
               r.message, r.status, r.created_at, r.decided_at, d.full_name AS decided_by_name, r.role_granted,
               (SELECT string_agg(anc.name, ' / ' ORDER BY nlevel(anc.path)) FROM public.folders anc
                 WHERE anc.company_id = f.company_id AND anc.path @> f.path) AS folder_path_label
        FROM public.access_requests r
        JOIN public.folders f ON f.id = r.folder_id
        JOIN public.users u ON u.id = r.requester_id
        LEFT JOIN public.users d ON d.id = r.decided_by
        WHERE r.company_id = $1 AND ($2 = 'todos' OR r.status = $2)
        ORDER BY r.created_at DESC
        LIMIT 200
        """,
        company_id, status_filtro,
    )
    return [dict(r) for r in rows]


class AccessRequestDecision(BaseModel):
    aprovar: bool
    permission_level: str = "visualizador"
    expires_on: date | None = None


@router.post("/access-requests/{request_id}/decide")
async def decide_access_request(
    request_id: UUID,
    body: AccessRequestDecision,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    pedido = await admin_conn.fetchrow(
        """
        SELECT r.id, r.company_id, r.folder_id, r.requester_id, r.status, f.path, f.name AS folder_name
        FROM public.access_requests r JOIN public.folders f ON f.id = r.folder_id WHERE r.id = $1
        """,
        request_id,
    )
    if pedido is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pedido não encontrado.")
    role = await get_app_role(conn, claims)
    if not await _can_manage_scope(conn, claims["sub"], pedido["company_id"], role, str(pedido["path"])):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra este lugar.")
    if pedido["status"] != "pendente":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Este pedido já foi respondido.")
    if body.aprovar:
        if body.permission_level not in ("visualizador", "operador", "admin"):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Papel inválido.")
        _validar_prazo(body.expires_on)
        try:
            async with admin_conn.transaction():
                row = await CompaniesService.insert_access_grant(
                    admin_conn, user_id=pedido["requester_id"], company_id=pedido["company_id"],
                    permission_level=body.permission_level, folder_path=str(pedido["path"]), granted_by=claims["sub"],
                )
                await _gravar_prazo(admin_conn, row["id"], body.expires_on)
        except asyncpg.UniqueViolationError:
            pass  # já tinha a concessão neste lugar: o pedido só é marcado como aprovado
        nome = await admin_conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", pedido["requester_id"])
        await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=pedido["company_id"], action="access_grant",
                                          target_id=pedido["requester_id"], target_name=nome or "pessoa",
                                          metadata={"papel": body.permission_level, "onde": pedido["folder_name"], "origem": "pedido de acesso",
                                                    "ate": body.expires_on.isoformat() if body.expires_on else None})
    await admin_conn.execute(
        "UPDATE public.access_requests SET status = $2, decided_by = $3, decided_at = now(), role_granted = $4 WHERE id = $1",
        request_id, "aprovado" if body.aprovar else "recusado", claims["sub"], body.permission_level if body.aprovar else None,
    )
    papel = {"visualizador": "visualizador", "operador": "operador", "admin": "administrador"}.get(body.permission_level, body.permission_level)
    msg = (f'Seu pedido de acesso à pasta "{pedido["folder_name"]}" foi aprovado ({papel}).' if body.aprovar
           else f'Seu pedido de acesso à pasta "{pedido["folder_name"]}" foi recusado.')
    await admin_conn.execute(
        """
        INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, actor_user_id, message)
        VALUES ($1, $2, 'access_request_decided', 'folder', $3, $4, $5)
        """,
        pedido["requester_id"], pedido["company_id"], pedido["folder_id"], claims["sub"], msg,
    )
    return {"status": "aprovado" if body.aprovar else "recusado"}
