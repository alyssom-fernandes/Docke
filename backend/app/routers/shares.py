"""
ADR-022/027/031 — Compartilhamento externo.

Rotas autenticadas: criar, listar, revogar links (prefix /shares).
Rotas públicas: resolver/acessar um link (prefix /s) — sem autenticação, então
sem RLS por usuário; usam get_db_share_public, no papel docke_share_public, que
só alcança as colunas que essas rotas usam (migration 20261026000002).
"""
import hashlib
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_share_public
from app.services import rate_limit, storage_service
from app.services.notification_service import notify_share_accessed, notify_share_blocked
from app.services.shares_service import SharesService


_BRT = timezone(timedelta(hours=-3))  # datas mostradas ao destinatário no horário de Brasília

router = APIRouter(tags=["shares"])
public_router = APIRouter(prefix="/s", tags=["shares-public"])

_GEN_LIMIT_HOUR = 30
_GEN_LIMIT_DAY = 100
_PASSWORD_ATTEMPTS = 5
_PASSWORD_WINDOW_SECS = 60
_LOCKOUT_SECS = 15 * 60

_EXPIRY_MAP = {
    "never": None,
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "30d": timedelta(days=30),
}


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _is_within_shared_root(candidate_path: str, root_path: str) -> bool:
    """Equivalente ao operador ltree `@>` (ancestral-ou-igual), não um simples
    prefixo de string: `str.startswith(root_path)` aceitaria incorretamente
    "empresa.fiscal2" como estando dentro de "empresa.fiscal" só porque a
    string bate no começo. Mesmo critério usado em permission_service.py."""
    return candidate_path == root_path or candidate_path.startswith(root_path + ".")


# ---------------------------------------------------------------------------
# POST /shares — cria link de compartilhamento
# ---------------------------------------------------------------------------

class ShareCreate(BaseModel):
    resource_type: str  # document | folder
    resource_id: UUID
    password: str | None = None
    expires_in: str = "never"  # never | 24h | 7d | 30d | custom
    custom_expires_at: date | None = None
    always_latest: bool = False  # ADR-031: desmarcado por padrão = fixa a versão atual
    # Achado A5-77: limite de aberturas e "só visualizar" (sem botão de baixar).
    max_views: int | None = None
    allow_download: bool = True


class ShareUpdate(BaseModel):
    """Editar um link depois de criado: validade, senha, limite e download."""
    expires_in: str | None = None  # never | 24h | 7d | 30d | custom
    custom_expires_at: date | None = None
    password: str | None = None  # "" remove a senha
    max_views: int | None = None  # 0 remove o limite
    allow_download: bool | None = None


@router.post("/shares", status_code=status.HTTP_201_CREATED)
async def create_share(
    body: ShareCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    user_id = claims["sub"]

    if not rate_limit.check_and_record(f"share-gen-hour:{user_id}", _GEN_LIMIT_HOUR, 3600):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Limite de 30 links por hora atingido.")
    if not rate_limit.check_and_record(f"share-gen-day:{user_id}", _GEN_LIMIT_DAY, 86400):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Limite de 100 links por dia atingido.")

    if body.resource_type not in ("document", "folder"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="resource_type inválido.")

    pin_to_version_id = None
    if body.resource_type == "document":
        doc = await SharesService.get_document_for_share(conn, body.resource_id)
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
        company_id = doc["company_id"]
        if not body.always_latest:
            pin_to_version_id = doc["current_version_id"]
    else:
        folder = await SharesService.get_folder_for_share(conn, body.resource_id)
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
        company_id = folder["company_id"]

    if body.expires_in == "custom":
        if body.custom_expires_at is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Informe custom_expires_at.")
        # datetime.max.time() (23:59:59) — o link fica válido ATÉ O FIM do dia
        # escolhido. Com datetime.min.time() (00:00:00) o link expirava no
        # início do próprio dia selecionado, um dia inteiro antes do esperado.
        expires_at = datetime.combine(body.custom_expires_at, datetime.max.time(), tzinfo=timezone.utc)
    elif body.expires_in in _EXPIRY_MAP:
        delta = _EXPIRY_MAP[body.expires_in]
        expires_at = (datetime.now(timezone.utc) + delta) if delta else None
    else:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="expires_in inválido.")

    token = uuid4().hex + uuid4().hex  # 256 bits de entropia
    token_hash = _hash_token(token)
    password_hash = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode() if body.password else None

    if body.max_views is not None and not (1 <= body.max_views <= 10_000):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O limite de aberturas vai de 1 a 10.000.")
    row = await SharesService.insert_share(
        conn,
        resource_type=body.resource_type, resource_id=body.resource_id, company_id=company_id,
        token_hash=token_hash, password_hash=password_hash, expires_at=expires_at,
        pin_to_version_id=pin_to_version_id, created_by=user_id,
        max_views=body.max_views, allow_download=body.allow_download,
    )
    return {
        "id": row["id"],
        "token": token,  # só aparece nesta resposta — não é recuperável depois (só o hash é persistido)
        "created_at": row["created_at"].isoformat(),
        "expires_at": expires_at.isoformat() if expires_at else None,
        "has_password": password_hash is not None,
    }


# ---------------------------------------------------------------------------
# GET /shares — lista links (próprios, ou todos se admin da empresa)
# ---------------------------------------------------------------------------

@router.get("/shares")
async def list_shares(
    resource_type: str | None = Query(None),
    resource_id: UUID | None = Query(None),
    company_id: UUID | None = Query(None),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await SharesService.list_shares(conn, resource_type=resource_type, resource_id=resource_id, company_id=company_id)
    return [dict(r) for r in rows]


@router.get("/shares/by-resource/accesses")
async def list_resource_accesses(
    resource_type: str = Query(..., pattern="^(document|folder)$"),
    resource_id: UUID = Query(...),
    limit: int = Query(30, ge=1, le=200),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Acessos por link de um documento ou pasta, de todos os links dele, para a
    linha do tempo do item (A5-25). A RLS limita aos links visíveis.
    """
    rows = await conn.fetch(
        """
        SELECT a.id::text, a.accessed_at, a.success, a.user_agent, s.id::text AS share_id,
               s.revoked_at IS NOT NULL AS share_revoked
        FROM public.share_accesses a
        JOIN public.shares s ON s.id = a.share_id
        WHERE s.resource_type = $1 AND s.resource_id = $2
        ORDER BY a.accessed_at DESC
        LIMIT $3
        """,
        resource_type, resource_id, limit,
    )
    return [dict(r) for r in rows]


@router.get("/shares/{share_id}/accesses")
async def list_share_accesses(
    share_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Quem abriu o link e quando (A6-17): data, sucesso (senha certa, dentro
    da validade) e o navegador. O IP fica só como hash, nunca aparece. A RLS
    limita aos links que a pessoa pode ver.
    """
    visible = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM public.shares WHERE id = $1)", share_id)
    if not visible:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link não encontrado.")
    rows = await conn.fetch(
        """
        SELECT id::text, accessed_at, success, user_agent
        FROM public.share_accesses WHERE share_id = $1
        ORDER BY accessed_at DESC LIMIT 100
        """,
        share_id,
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# DELETE /shares/:id — revoga
# ---------------------------------------------------------------------------

@router.patch("/shares/{share_id}")
async def update_share(
    share_id: UUID,
    body: ShareUpdate,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Muda validade, senha, limite de aberturas ou download de um link ativo (RLS: quem pode revogar pode editar)."""
    sets: list[str] = []
    args: list[Any] = [share_id]
    if body.expires_in is not None:
        if body.expires_in == "custom":
            if body.custom_expires_at is None:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Informe a data de validade.")
            new_exp = datetime.combine(body.custom_expires_at, datetime.max.time(), tzinfo=timezone.utc)
        elif body.expires_in in _EXPIRY_MAP:
            delta = _EXPIRY_MAP[body.expires_in]
            new_exp = (datetime.now(timezone.utc) + delta) if delta else None
        else:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Validade inválida.")
        args.append(new_exp)
        sets.append(f"expires_at = ${len(args)}")
    if body.password is not None:
        args.append(bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode() if body.password else None)
        sets.append(f"password_hash = ${len(args)}")
    if body.max_views is not None:
        if body.max_views < 0 or body.max_views > 10_000:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O limite de aberturas vai de 1 a 10.000.")
        args.append(body.max_views or None)
        sets.append(f"max_views = ${len(args)}")
    if body.allow_download is not None:
        args.append(body.allow_download)
        sets.append(f"allow_download = ${len(args)}")
    if not sets:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nada para alterar.")
    row = await conn.fetchrow(
        f"UPDATE public.shares SET {', '.join(sets)} WHERE id = $1 AND revoked_at IS NULL "
        "RETURNING id::text, expires_at, password_hash IS NOT NULL AS has_password, max_views, allow_download, view_count",
        *args,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link não encontrado ou já revogado.")
    return dict(row)


@router.delete("/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_share(
    share_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> None:
    row = await SharesService.revoke_share(conn, share_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link não encontrado.")


# ---------------------------------------------------------------------------
# Rotas públicas — sem autenticação
# ---------------------------------------------------------------------------

async def expire_shares_for_resource(admin_conn: asyncpg.Connection, resource_type: str, resource_id: UUID) -> None:
    """
    ADR-031: ao excluir um recurso permanentemente (manual ou pela retenção
    automática da lixeira), os shares associados são marcados expired.
    Chamado por trash.py (exclusão manual) e pelo worker de retenção (purga automática).
    """
    await SharesService.expire_shares_for_resource(admin_conn, resource_type, resource_id)


async def _resolve_share(conn: asyncpg.Connection, token: str) -> dict[str, Any]:
    row = await SharesService.resolve_share_by_token_hash(conn, _hash_token(token))
    # Mensagens com a próxima ação (A1-14): o destinatário não tem conta e só
    # pode pedir um novo link a quem enviou.
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link não encontrado. Confira se o endereço foi copiado inteiro ou peça um novo a quem enviou.")
    if row["revoked_at"] is not None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Quem enviou desativou este link. Peça um novo, se ainda precisar do arquivo.")
    if row["expired_at"] is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="O arquivo deste link não está mais disponível. Peça um novo link a quem enviou.")
    if row["expires_at"] is not None and row["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail=f"Este link venceu em {row['expires_at'].astimezone(_BRT).strftime('%d/%m/%Y')}. Peça um novo a quem enviou.")
    if row["max_views"] is not None and (row["view_count"] or 0) >= row["max_views"]:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Este link já foi aberto o número máximo de vezes. Peça um novo a quem enviou.")
    return dict(row)


@public_router.get("/{token}/info")
async def share_info(
    token: str,
    conn: asyncpg.Connection = Depends(get_db_share_public),
) -> dict[str, Any]:
    share = await _resolve_share(conn, token)

    size_bytes = None
    if share["resource_type"] == "document":
        doc = await SharesService.get_document_name(conn, share["resource_id"])
        if doc is None or doc["deleted_at"] is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Este documento não está mais disponível. Peça um novo link a quem enviou.")
        name = doc["name"]
        size_bytes = doc["size_bytes"]
    else:
        folder = await SharesService.get_folder_name(conn, share["resource_id"])
        if folder is None or folder["deleted_at"] is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Esta pasta não está mais disponível.")
        name = folder["name"]

    # Quem enviou, de qual empresa, até quando vale e o tamanho (A1-11).
    ctx = await conn.fetchrow("SELECT company_name, sender_name FROM public.share_public_context($1)", share["id"])
    return {
        "resource_type": share["resource_type"],
        "name": name,
        "has_password": share["password_hash"] is not None,
        "allow_download": share["allow_download"],
        "views_left": (share["max_views"] - (share["view_count"] or 0)) if share["max_views"] else None,
        "expires_at": share["expires_at"].isoformat() if share["expires_at"] else None,
        "size_bytes": size_bytes,
        "company_name": ctx["company_name"] if ctx else None,
        "sender_name": ctx["sender_name"] if ctx else None,
    }


class UnlockRequest(BaseModel):
    password: str | None = None


async def _verify_password(
    conn: asyncpg.Connection, request: Request, token: str, share: dict[str, Any], password: str | None,
) -> None:
    if share["password_hash"] is None:
        return
    key = f"share-pw:{token}"
    locked = rate_limit.is_locked_out(key)
    if locked:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail=f"Muitas tentativas. Tente novamente em {int(locked // 60) + 1} minuto(s).")
    if not password or not bcrypt.checkpw(password.encode(), share["password_hash"].encode()):
        just_locked = rate_limit.record_failed_attempt(key, _PASSWORD_ATTEMPTS, _PASSWORD_WINDOW_SECS, _LOCKOUT_SECS)
        await _log_access(conn, request, share["id"], False)
        if just_locked:
            await notify_share_blocked(conn, share["id"])
            raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Muitas tentativas incorretas. Tente novamente em 15 minutos.")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Senha incorreta.")


async def _log_access(conn: asyncpg.Connection, request: Request, share_id: str, success: bool) -> None:
    await SharesService.insert_access_log(
        conn, share_id=share_id, ip_hash=rate_limit.client_ip_hash(request),
        user_agent=request.headers.get("user-agent", "")[:500], success=success,
    )
    if success:
        await SharesService.register_successful_access(conn, share_id)
        await notify_share_accessed(conn, share_id)


@public_router.post("/{token}/content")
async def share_content(
    token: str,
    body: UnlockRequest,
    request: Request,
    folder_id: UUID | None = Query(None, description="Navegar para uma subpasta dentro do link (só para resource_type=folder)"),
    conn: asyncpg.Connection = Depends(get_db_share_public),
) -> dict[str, Any]:
    """Retorna o conteúdo do link — documento (com URL de download) ou listagem de pasta."""
    share = await _resolve_share(conn, token)
    await _verify_password(conn, request, token, share, body.password)

    if share["resource_type"] == "document":
        version_id = share["pin_to_version_id"]
        doc = await SharesService.get_document_for_content(conn, share["resource_id"])
        if doc is None or doc["deleted_at"] is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Este documento não está mais disponível.")
        version_id = version_id or doc["current_version_id"]
        version = await SharesService.get_version_for_content(conn, version_id)
        if version is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Versão do documento não encontrada.")

        download_url, expires_at = storage_service.generate_preview_url(key=version["storage_key"], content_type=version["mime_type"])
        await _log_access(conn, request, share["id"], True)
        return {"type": "document", "name": doc["name"], "mime_type": version["mime_type"], "preview_url": download_url,
                "allow_download": share["allow_download"], "document_id": str(share["resource_id"])}

    # resource_type == "folder" — navegação somente leitura dentro da árvore compartilhada
    root_folder = await SharesService.get_folder_for_content(conn, share["resource_id"])
    if root_folder is None or root_folder["deleted_at"] is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Esta pasta não está mais disponível.")

    current_id = folder_id or root_folder["id"]
    current = await SharesService.get_active_folder(conn, current_id)
    if current is None or not _is_within_shared_root(str(current["path"]), str(root_folder["path"])):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Fora da pasta compartilhada.")

    subfolders = await SharesService.list_subfolders(conn, current["id"])
    documents = await SharesService.list_documents_in_folder(conn, current["id"])
    await _log_access(conn, request, share["id"], True)
    return {
        "type": "folder",
        "allow_download": share["allow_download"],
        "name": current["name"],
        "folder_id": str(current["id"]),
        "is_root": str(current["id"]) == str(root_folder["id"]),
        "folders": [dict(r) for r in subfolders],
        "documents": [dict(r) for r in documents],
    }


@public_router.post("/{token}/download/{document_id}")
async def share_download(
    token: str,
    document_id: UUID,
    body: UnlockRequest,
    request: Request,
    conn: asyncpg.Connection = Depends(get_db_share_public),
) -> dict[str, Any]:
    """Download de um documento específico dentro de uma pasta compartilhada."""
    share = await _resolve_share(conn, token)
    await _verify_password(conn, request, token, share, body.password)
    if not share["allow_download"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Este link permite só visualizar.")

    if share["resource_type"] == "document":
        if str(document_id) != str(share["resource_id"]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Documento fora do escopo deste link.")
    else:
        root_folder = await SharesService.get_folder_path(conn, share["resource_id"])
        doc = await SharesService.get_document_in_folder_scope(
            conn, document_id, root_folder["path"] if root_folder else None,
        )
        if doc is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Documento fora do escopo deste link.")

    doc = await SharesService.get_document_for_download(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")

    download_url, expires_at = storage_service.generate_download_url(
        key=doc["storage_path"], filename=doc["name"], content_type=doc["mime_type"],
    )
    await _log_access(conn, request, share["id"], True)
    return {"download_url": download_url, "name": doc["name"]}
