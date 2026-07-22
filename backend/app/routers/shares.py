"""
ADR-022/027/031 — Compartilhamento externo.

Rotas autenticadas: criar, listar, revogar links (prefix /shares).
Rotas públicas: resolver/acessar um link (prefix /s) — sem autenticação,
usam admin_conn diretamente (não há usuário logado para RLS aplicar).
"""
import hashlib
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin
from app.services import rate_limit, storage_service
from app.services.notification_service import notify_share_accessed, notify_share_blocked
from app.services.shares_service import SharesService

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

    row = await SharesService.insert_share(
        conn,
        resource_type=body.resource_type, resource_id=body.resource_id, company_id=company_id,
        token_hash=token_hash, password_hash=password_hash, expires_at=expires_at,
        pin_to_version_id=pin_to_version_id, created_by=user_id,
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


# ---------------------------------------------------------------------------
# DELETE /shares/:id — revoga
# ---------------------------------------------------------------------------

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


async def _resolve_share(admin_conn: asyncpg.Connection, token: str) -> dict[str, Any]:
    row = await SharesService.resolve_share_by_token_hash(admin_conn, _hash_token(token))
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Link não encontrado.")
    if row["revoked_at"] is not None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Este link foi revogado.")
    if row["expired_at"] is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Este documento não está mais disponível.")
    if row["expires_at"] is not None and row["expires_at"] < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Este link expirou.")
    return dict(row)


@public_router.get("/{token}/info")
async def share_info(
    token: str,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    share = await _resolve_share(admin_conn, token)

    if share["resource_type"] == "document":
        doc = await SharesService.get_document_name(admin_conn, share["resource_id"])
        if doc is None or doc["deleted_at"] is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Este documento não está mais disponível.")
        name = doc["name"]
    else:
        folder = await SharesService.get_folder_name(admin_conn, share["resource_id"])
        if folder is None or folder["deleted_at"] is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Esta pasta não está mais disponível.")
        name = folder["name"]

    return {
        "resource_type": share["resource_type"],
        "name": name,
        "has_password": share["password_hash"] is not None,
    }


class UnlockRequest(BaseModel):
    password: str | None = None


async def _verify_password(
    admin_conn: asyncpg.Connection, request: Request, token: str, share: dict[str, Any], password: str | None,
) -> None:
    if share["password_hash"] is None:
        return
    key = f"share-pw:{token}"
    locked = rate_limit.is_locked_out(key)
    if locked:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail=f"Muitas tentativas. Tente novamente em {int(locked // 60) + 1} minuto(s).")
    if not password or not bcrypt.checkpw(password.encode(), share["password_hash"].encode()):
        just_locked = rate_limit.record_failed_attempt(key, _PASSWORD_ATTEMPTS, _PASSWORD_WINDOW_SECS, _LOCKOUT_SECS)
        await _log_access(admin_conn, request, share["id"], False)
        if just_locked:
            await notify_share_blocked(admin_conn, share["id"])
            raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Muitas tentativas incorretas. Tente novamente em 15 minutos.")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Senha incorreta.")


async def _log_access(admin_conn: asyncpg.Connection, request: Request, share_id: str, success: bool) -> None:
    await SharesService.insert_access_log(
        admin_conn, share_id=share_id, ip_hash=rate_limit.client_ip_hash(request),
        user_agent=request.headers.get("user-agent", "")[:500], success=success,
    )
    if success:
        await SharesService.register_successful_access(admin_conn, share_id)
        await notify_share_accessed(admin_conn, share_id)


@public_router.post("/{token}/content")
async def share_content(
    token: str,
    body: UnlockRequest,
    request: Request,
    folder_id: UUID | None = Query(None, description="Navegar para uma subpasta dentro do link (só para resource_type=folder)"),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    """Retorna o conteúdo do link — documento (com URL de download) ou listagem de pasta."""
    share = await _resolve_share(admin_conn, token)
    await _verify_password(admin_conn, request, token, share, body.password)

    if share["resource_type"] == "document":
        version_id = share["pin_to_version_id"]
        doc = await SharesService.get_document_for_content(admin_conn, share["resource_id"])
        if doc is None or doc["deleted_at"] is not None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Este documento não está mais disponível.")
        version_id = version_id or doc["current_version_id"]
        version = await SharesService.get_version_for_content(admin_conn, version_id)
        if version is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Versão do documento não encontrada.")

        download_url, expires_at = storage_service.generate_preview_url(key=version["storage_key"], content_type=version["mime_type"])
        await _log_access(admin_conn, request, share["id"], True)
        return {"type": "document", "name": doc["name"], "mime_type": version["mime_type"], "preview_url": download_url}

    # resource_type == "folder" — navegação somente leitura dentro da árvore compartilhada
    root_folder = await SharesService.get_folder_for_content(admin_conn, share["resource_id"])
    if root_folder is None or root_folder["deleted_at"] is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Esta pasta não está mais disponível.")

    current_id = folder_id or root_folder["id"]
    current = await SharesService.get_active_folder(admin_conn, current_id)
    if current is None or not _is_within_shared_root(str(current["path"]), str(root_folder["path"])):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Fora da pasta compartilhada.")

    subfolders = await SharesService.list_subfolders(admin_conn, current["id"])
    documents = await SharesService.list_documents_in_folder(admin_conn, current["id"])
    await _log_access(admin_conn, request, share["id"], True)
    return {
        "type": "folder",
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
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    """Download de um documento específico dentro de uma pasta compartilhada."""
    share = await _resolve_share(admin_conn, token)
    await _verify_password(admin_conn, request, token, share, body.password)

    if share["resource_type"] == "document":
        if str(document_id) != str(share["resource_id"]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Documento fora do escopo deste link.")
    else:
        root_folder = await SharesService.get_folder_path(admin_conn, share["resource_id"])
        doc = await SharesService.get_document_in_folder_scope(
            admin_conn, document_id, root_folder["path"] if root_folder else None,
        )
        if doc is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Documento fora do escopo deste link.")

    doc = await SharesService.get_document_for_download(admin_conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")

    download_url, expires_at = storage_service.generate_download_url(
        key=doc["storage_path"], filename=doc["name"], content_type=doc["mime_type"],
    )
    await _log_access(admin_conn, request, share["id"], True)
    return {"download_url": download_url, "name": doc["name"]}
