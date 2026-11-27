"""
Pedir arquivos a terceiros (benchmark FA-A4-11, B3.5.8, B1.1.6 em parte).

Quem tem permissão de enviar numa pasta cria um link de envio; o terceiro
(contador, fornecedor, funcionário) abre /enviar/{token}, informa o nome e
manda os arquivos, sem conta no Docke. Cada arquivo passa pela mesma
conferência do envio normal (tamanho real, conteúdo × extensão, SHA-256,
duplicidade) e quem pediu recebe um aviso.

As rotas públicas (/r/{token}/...) usam a conexão de admin, então toda
consulta filtra pelo pedido do token; nada do resto da empresa é exposto
(nem o nome de um arquivo duplicado).
"""
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

import asyncpg
import bcrypt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from app.config import settings
from app.dependencies import get_current_user, get_db, get_db_admin
from app.services import rate_limit, storage_service
from app.services.documents_service import _MIME_MAP, DocumentsService
from app.services import features_service

router = APIRouter(tags=["upload-requests"])

_ALLOWED_EXT = set(settings.ALLOWED_EXTENSIONS)
_PW_ATTEMPTS = 5
_PW_WINDOW = 60
_PW_LOCKOUT = 15 * 60


# ---------------------------------------------------------------------------
# Quem pede
# ---------------------------------------------------------------------------

class UploadRequestCreate(BaseModel):
    company_id: UUID
    folder_id: UUID
    title: str = Field(min_length=1, max_length=120)
    message: str | None = Field(default=None, max_length=1000)
    expires_days: int = Field(default=7, ge=1, le=90)
    password: str | None = Field(default=None, max_length=200)
    max_files: int = Field(default=20, ge=1, le=200)
    # A7-55, B3.5.8: o que chegar já comprova esta competência.
    obligation_instance_id: UUID | None = None


@router.post("/upload-requests", status_code=status.HTTP_201_CREATED)
async def create_upload_request(
    body: UploadRequestCreate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    from app.routers.shares import _politica

    await features_service.require(conn, body.company_id, "pedidos")
    folder = await DocumentsService.find_folder_for_upload(conn, body.folder_id, body.company_id)
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    if folder["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só quem pode enviar nesta pasta pede arquivos para ela.")
    if not rate_limit.check_and_record(f"upreq-gen:{claims['sub']}", 30, 3600):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Muitos pedidos criados em pouco tempo. Tente mais tarde.")

    # Mesma política dos links públicos da empresa: senha obrigatória e validade máxima.
    req_senha, max_dias = await _politica(admin_conn, body.company_id)
    senha = (body.password or "").strip() or None
    if req_senha and not senha:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Esta empresa exige senha em todo link público. Defina uma senha para o pedido.")
    if senha and len(senha) < 4:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A senha precisa de ao menos 4 caracteres.")
    if max_dias and body.expires_days > max_dias:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"A empresa permite links de no máximo {max_dias} {'dia' if max_dias == 1 else 'dias'}.")

    if body.obligation_instance_id is not None:
        # A competência precisa ser desta empresa e visível para quem pede.
        dona = await conn.fetchval(
            "SELECT company_id FROM public.obligation_instances WHERE id = $1", body.obligation_instance_id,
        )
        if dona is None or dona != body.company_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada nesta empresa.")

    token = secrets.token_urlsafe(24)
    expira = datetime.now(timezone.utc) + timedelta(days=body.expires_days)
    row = await admin_conn.fetchrow(
        """
        INSERT INTO public.upload_requests (company_id, folder_id, token, title, message, password_hash, expires_at, max_files, created_by,
                                            obligation_instance_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id::text, token, title, expires_at, max_files, obligation_instance_id::text
        """,
        body.company_id, body.folder_id, token, body.title.strip(), (body.message or "").strip() or None,
        bcrypt.hashpw(senha.encode(), bcrypt.gensalt()).decode() if senha else None,
        expira, body.max_files, claims["sub"], body.obligation_instance_id,
    )
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
        VALUES ($1::uuid, $2::uuid, 'upload_request', 'folder', $3::uuid, $4, 'share', jsonb_build_object('titulo', $5::text, 'dias', $6::int))
        """,
        claims["sub"], body.company_id, body.folder_id,
        await admin_conn.fetchval("SELECT name FROM public.folders WHERE id = $1", body.folder_id), body.title.strip(), body.expires_days,
    )
    return dict(row) | {"has_password": bool(senha)}


@router.get("/upload-requests")
async def list_upload_requests(
    company_id: UUID = Query(...),
    folder_id: UUID | None = Query(None),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Pedidos que a pessoa vê (o RLS vale pela pasta), com quantos arquivos chegaram."""
    rows = await conn.fetch(
        """
        SELECT r.id::text, r.folder_id::text, f.name AS folder_name, r.token, r.title, r.message, r.expires_at,
               r.max_files, r.revoked_at, r.created_at, (r.password_hash IS NOT NULL) AS has_password,
               u.full_name AS created_by_name,
               (SELECT count(*) FROM public.upload_request_files x WHERE x.request_id = r.id AND x.confirmed_at IS NOT NULL) AS received,
               (SELECT max(x.confirmed_at) FROM public.upload_request_files x WHERE x.request_id = r.id) AS last_received_at
        FROM public.upload_requests r
        JOIN public.folders f ON f.id = r.folder_id
        LEFT JOIN public.users u ON u.id = r.created_by
        WHERE r.company_id = $1 AND ($2::uuid IS NULL OR r.folder_id = $2)
        ORDER BY r.created_at DESC
        LIMIT 100
        """,
        company_id, folder_id,
    )
    agora = datetime.now(timezone.utc)
    out = []
    for r in rows:
        d = dict(r)
        d["status"] = "revogado" if d["revoked_at"] else "vencido" if d["expires_at"] <= agora else "lotado" if d["received"] >= d["max_files"] else "aberto"
        out.append(d)
    return out


@router.get("/upload-requests/{request_id}/files")
async def list_upload_request_files(
    request_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        """
        SELECT x.id::text, x.document_id::text, x.sender_name, x.file_name, x.size_bytes, x.confirmed_at,
               (d.id IS NOT NULL AND d.deleted_at IS NULL) AS available, d.folder_id::text
        FROM public.upload_request_files x
        LEFT JOIN public.documents d ON d.id = x.document_id
        WHERE x.request_id = $1 AND x.confirmed_at IS NOT NULL
        ORDER BY x.confirmed_at DESC
        """,
        request_id,
    )
    return [dict(r) for r in rows]


@router.post("/upload-requests/{request_id}/revoke")
async def revoke_upload_request(
    request_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    req = await conn.fetchrow("SELECT id, folder_id, company_id FROM public.upload_requests WHERE id = $1", request_id)
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pedido não encontrado.")
    folder = await DocumentsService.find_folder_for_upload(conn, req["folder_id"], req["company_id"])
    if folder is None or folder["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só quem pode enviar nesta pasta encerra o pedido.")
    await admin_conn.execute("UPDATE public.upload_requests SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1", request_id)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Quem envia (público, sem conta)
# ---------------------------------------------------------------------------

async def _pedido(admin_conn: asyncpg.Connection, token: str) -> asyncpg.Record:
    req = await admin_conn.fetchrow(
        """
        SELECT r.id, r.company_id, r.folder_id, r.title, r.message, r.password_hash, r.expires_at, r.max_files,
               r.revoked_at, r.created_by, r.obligation_instance_id,
               c.name AS company_name, f.name AS folder_name, f.deleted_at AS folder_deleted,
               (SELECT count(*) FROM public.upload_request_files x WHERE x.request_id = r.id AND x.confirmed_at IS NOT NULL) AS received
        FROM public.upload_requests r
        JOIN public.companies c ON c.id = r.company_id
        JOIN public.folders f ON f.id = r.folder_id
        WHERE r.token = $1
        """,
        token,
    )
    if req is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Este link de envio não existe.")
    if req["revoked_at"] is not None or req["folder_deleted"] is not None:
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Este pedido foi encerrado por quem o criou.")
    if not await features_service.enabled(admin_conn, req["company_id"], "pedidos"):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="A empresa desligou os pedidos de arquivo por link. Fale com quem pediu o arquivo.")
    if req["expires_at"] <= datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_410_GONE, detail="Este link de envio venceu. Peça um novo a quem o enviou.")
    return req


def _conferir_senha(request: Request, token: str, req: asyncpg.Record, senha: str | None) -> None:
    if req["password_hash"] is None:
        return
    chave = f"upreq-pw:{token}:{rate_limit.client_ip_hash(request)}"
    travado = rate_limit.is_locked_out(chave)
    if travado:
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail=f"Muitas tentativas. Tente de novo em {int(travado // 60) + 1} minuto(s).")
    if not senha or not bcrypt.checkpw(senha.encode(), req["password_hash"].encode()):
        rate_limit.record_failed_attempt(chave, _PW_ATTEMPTS, _PW_WINDOW, _PW_LOCKOUT)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Senha incorreta.")


@router.get("/r/{token}/info")
async def upload_request_info(token: str, admin_conn: asyncpg.Connection = Depends(get_db_admin)) -> dict[str, Any]:
    req = await _pedido(admin_conn, token)
    return {
        "title": req["title"], "message": req["message"], "company_name": req["company_name"],
        "folder_name": req["folder_name"], "expires_at": req["expires_at"], "requires_password": req["password_hash"] is not None,
        "max_files": req["max_files"], "received": req["received"],
        "allowed_extensions": sorted(_ALLOWED_EXT), "max_file_mb": settings.MAX_FILE_SIZE_BYTES // 1_048_576,
    }


class PublicUploadUrl(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    size_bytes: int
    content_type: str = "application/octet-stream"
    sender_name: str = Field(min_length=1, max_length=120)
    password: str | None = None


@router.post("/r/{token}/upload-url", status_code=status.HTTP_201_CREATED)
async def public_upload_url(
    token: str, body: PublicUploadUrl, request: Request, admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    req = await _pedido(admin_conn, token)
    _conferir_senha(request, token, req, body.password)
    if not rate_limit.check_and_record(f"upreq-up:{rate_limit.client_ip_hash(request)}", 60, 600):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Muitos envios em pouco tempo. Espere alguns minutos.")
    pendentes = await admin_conn.fetchval(
        "SELECT count(*) FROM public.upload_request_files WHERE request_id = $1 AND confirmed_at IS NULL AND created_at > now() - interval '1 hour'",
        req["id"],
    )
    if req["received"] + pendentes >= req["max_files"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Este pedido aceita no máximo {req['max_files']} arquivos e já está completo.")
    if body.size_bytes <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Arquivo vazio.")
    if body.size_bytes > settings.MAX_FILE_SIZE_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail=f"O arquivo passa do limite de {settings.MAX_FILE_SIZE_BYTES // 1_048_576} MB.")
    nome = body.name.replace("/", "_").replace("\\", "_").strip()
    ponto = nome.rfind(".")
    ext = nome[ponto + 1:].lower() if ponto != -1 else ""
    if not ext or not ext.isalnum() or ext not in _ALLOWED_EXT:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Tipo de arquivo não aceito. Aceitos: {', '.join(sorted(_ALLOWED_EXT))}.")

    final = await DocumentsService.resolve_unique_name(admin_conn, req["folder_id"], nome)
    document_id = uuid4()
    key = storage_service.storage_key(str(req["company_id"]), str(document_id), ext)
    content_type = _MIME_MAP.get(ext, body.content_type)
    await DocumentsService.insert_pending_document(
        admin_conn, document_id=document_id, folder_id=req["folder_id"], company_id=req["company_id"],
        name=final, mime_type=content_type, file_type=ext, size_bytes=body.size_bytes, storage_path=key,
        uploaded_by=str(req["created_by"]), created_at=None,
    )
    await admin_conn.execute(
        "INSERT INTO public.upload_request_files (request_id, document_id, sender_name, file_name, size_bytes) VALUES ($1, $2, $3, $4, $5)",
        req["id"], document_id, body.sender_name.strip(), final, body.size_bytes,
    )
    upload_url, expires_at = storage_service.generate_upload_url(key=key, content_type=content_type)
    return {"document_id": str(document_id), "upload_url": upload_url, "content_type": content_type, "name": final,
            "expires_at": expires_at.isoformat(), "mock_mode": storage_service.is_mock()}


class PublicConfirm(BaseModel):
    document_id: UUID
    password: str | None = None


async def _arquivo_do_pedido(admin_conn: asyncpg.Connection, req: asyncpg.Record, document_id: UUID) -> asyncpg.Record:
    x = await admin_conn.fetchrow(
        "SELECT id, sender_name, confirmed_at FROM public.upload_request_files WHERE request_id = $1 AND document_id = $2",
        req["id"], document_id,
    )
    if x is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Envio não encontrado neste pedido.")
    return x


async def _comprovar_obrigacao(admin_conn: asyncpg.Connection, req: asyncpg.Record, doc: asyncpg.Record, remetente: str) -> None:
    """
    A7-55, B3.5.8: o arquivo recebido pelo pedido vira comprovante da
    competência (em nome de quem pediu), entra na trilha da obrigação e, se
    ela pede conferência, avisa os administradores.
    """
    from app.services.obligations_service import period_label

    inst = await admin_conn.fetchrow(
        """
        SELECT oi.id, oi.status, oi.period, ot.name AS template_name
        FROM public.obligation_instances oi JOIN public.obligation_templates ot ON ot.id = oi.template_id
        WHERE oi.id = $1 AND oi.company_id = $2
        """,
        req["obligation_instance_id"], req["company_id"],
    )
    if inst is None or inst["status"] in ("dispensado", "cancelado"):
        return
    await admin_conn.execute(
        """
        INSERT INTO public.obligation_documents (obligation_instance_id, document_id, linked_by)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING
        """,
        inst["id"], doc["id"], req["created_by"],
    )
    nome = f'{inst["template_name"]} · {period_label(inst["period"])}'
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
        VALUES ($1, $2, 'obligation_link', 'obligation', $3, $4, 'obligation',
                jsonb_build_object('tipo', 'competencia', 'documento', $5::text, 'pelo_pedido', $6::text, 'remetente', $7::text))
        """,
        req["created_by"], req["company_id"], inst["id"], nome, doc["name"], req["title"], remetente,
    )
    status_agora = await admin_conn.fetchval("SELECT status FROM public.obligation_instances WHERE id = $1", inst["id"])
    if status_agora == "reviewing":
        await admin_conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
            SELECT DISTINCT uca.user_id, $1::uuid, 'obligation_review', 'obligation_instance', $2::uuid, $3::text
            FROM public.user_company_access uca
            WHERE uca.company_id = $1 AND uca.folder_path IS NULL AND uca.permission_level = 'admin'
            """,
            req["company_id"], inst["id"], f'"{nome}": {remetente} mandou {doc["name"]} pelo pedido; espera sua conferência.',
        )


@router.post("/r/{token}/confirm")
async def public_confirm(
    token: str, body: PublicConfirm, request: Request, admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    from app.routers.documents import _finalize_confirmed_upload

    req = await _pedido(admin_conn, token)
    _conferir_senha(request, token, req, body.password)
    x = await _arquivo_do_pedido(admin_conn, req, body.document_id)
    if x["confirmed_at"] is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Este arquivo já foi recebido.")
    doc = await admin_conn.fetchrow(
        "SELECT id, name, storage_path, company_id, content_hash FROM public.documents WHERE id = $1 AND company_id = $2",
        body.document_id, req["company_id"],
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Envio não encontrado neste pedido.")
    try:
        row = await _finalize_confirmed_upload(admin_conn, doc, body.document_id, str(req["created_by"]))
    except HTTPException as exc:
        await admin_conn.execute("DELETE FROM public.upload_request_files WHERE id = $1", x["id"])
        if exc.status_code == status.HTTP_409_CONFLICT:
            # Sem o nome do arquivo que já existe: quem envia é de fora da empresa.
            raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                detail="Este arquivo já estava no Docke (o mesmo conteúdo foi enviado antes). Não precisa mandar de novo.")
        raise
    await admin_conn.execute("UPDATE public.upload_request_files SET confirmed_at = now() WHERE id = $1", x["id"])
    if req["obligation_instance_id"] is not None:
        await _comprovar_obrigacao(admin_conn, req, row, x["sender_name"])
    await admin_conn.execute(
        """
        INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
        VALUES ($1, $2, 'upload_request_received', 'folder', $3, $4)
        """,
        req["created_by"], req["company_id"], req["folder_id"],
        f'{x["sender_name"]} enviou "{row["name"]}" pelo pedido "{req["title"]}".',
    )
    return {"name": row["name"], "status": "recebido"}


@router.post("/r/{token}/abort", status_code=status.HTTP_204_NO_CONTENT)
async def public_abort(
    token: str, body: PublicConfirm, request: Request, admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> None:
    req = await _pedido(admin_conn, token)
    _conferir_senha(request, token, req, body.password)
    x = await _arquivo_do_pedido(admin_conn, req, body.document_id)
    if x["confirmed_at"] is not None:
        return
    await DocumentsService.delete_pending_document(admin_conn, body.document_id)
    await admin_conn.execute("DELETE FROM public.upload_request_files WHERE id = $1", x["id"])
