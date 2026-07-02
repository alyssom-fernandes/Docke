from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

import httpx

from app.config import settings
from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services import storage_service

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
    manages = await conn.fetchval(
        """
        SELECT EXISTS (
          SELECT 1 FROM public.user_company_access
          WHERE user_id = $1 AND company_id = $2
            AND permission_level = 'admin' AND folder_path IS NULL
        )
        """,
        user_id,
        company_id,
    )
    return bool(manages)


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

    if role == "supremo":
        rows = await admin_conn.fetch(
            """
            SELECT
              c.id::text, c.name, c.cnpj, c.logo_key, c.is_active, c.created_at,
              (SELECT COUNT(*) FROM public.documents d WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS document_count,
              (SELECT COUNT(*) FROM public.user_company_access uca WHERE uca.company_id = c.id AND uca.folder_path IS NULL) AS user_count
            FROM public.companies c
            ORDER BY c.name
            """
        )
    else:
        rows = await admin_conn.fetch(
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
        # Concede acesso admin ao criador automaticamente (nível máximo em user_company_access)
        await admin_conn.execute(
            """
            INSERT INTO public.user_company_access
              (user_id, company_id, folder_path, permission_level, granted_by)
            VALUES ($1, $2::uuid, NULL, 'admin', $1)
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

    row = await admin_conn.fetchrow(
        """
        UPDATE public.companies
        SET name      = COALESCE($2, name),
            cnpj      = CASE WHEN $3::boolean THEN $4 ELSE cnpj END,
            is_active = COALESCE($5, is_active),
            logo_key  = COALESCE($6, logo_key)
        WHERE id = $1
        RETURNING id::text, name, cnpj, logo_key, is_active, created_at
        """,
        company_id,
        body.name,
        "cnpj" in body.model_fields_set,
        body.cnpj,
        body.is_active,
        body.logo_key,
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
    row = await conn.fetchrow("SELECT logo_key FROM public.companies WHERE id = $1", company_id)
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
    permission_level: str = "visualizador"  # visualizador | auditor | admin


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
    if body.permission_level not in ("visualizador", "auditor", "admin"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="permission_level inválido.")
    if len(body.password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A senha deve ter no mínimo 8 caracteres.")

    existing_username = await admin_conn.fetchval("SELECT id FROM public.users WHERE username = $1", body.username)
    if existing_username:
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

    await admin_conn.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1::uuid, $2, $3, 'usuario')",
        new_user_id,
        body.username,
        body.full_name,
    )
    row = await admin_conn.fetchrow(
        """
        INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path, granted_by)
        VALUES ($1::uuid, $2, $3, NULL, $4::uuid)
        RETURNING id::text, user_id::text, company_id::text, permission_level, created_at
        """,
        new_user_id,
        company_id,
        body.permission_level,
        user_id,
    )
    return dict(row) | {"username": body.username, "full_name": body.full_name}


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

    await admin_conn.execute(
        "DELETE FROM public.user_company_access WHERE user_id = $1 AND company_id = $2",
        member_id,
        company_id,
    )

