from datetime import date
from typing import Any
from uuid import UUID, uuid4

import io
import os
import tempfile
import zipfile
from urllib.parse import quote

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin
from app.config import settings
from app.services import storage_service
from app.services.documents_service import DocumentsService, _MIME_MAP
from app.services.notification_service import notify_folder_favoriters

router = APIRouter(prefix="/documents", tags=["documents"])

_ALLOWED_EXT = set(settings.ALLOWED_EXTENSIONS)
_BULK_LIMIT = 50  # máximo de arquivos por lote
_PREVIEW_SIZE_LIMIT = 10 * 1024 * 1024  # 10MB


class BulkDownloadRequest(BaseModel):
    document_ids: list[UUID]


class BulkMoveRequest(BaseModel):
    document_ids: list[UUID]
    target_folder_id: UUID


class BulkDeleteRequest(BaseModel):
    document_ids: list[UUID]


class UploadUrlRequest(BaseModel):
    folder_id: UUID
    company_id: UUID
    name: str
    size_bytes: int
    content_type: str


class DocumentPatch(BaseModel):
    name: str | None = None
    sector: str | None = None
    competencia: date | None = None
    tipo_fiscal: str | None = None


# ---------------------------------------------------------------------------
# POST /documents/upload-url — gera presigned URL para upload direto ao R2
# DEVE vir antes de /{document_id} para FastAPI não confundir o literal
# ---------------------------------------------------------------------------

@router.post("/upload-url", status_code=status.HTTP_201_CREATED)
async def create_upload_url(
    body: UploadUrlRequest,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Fase 1 do upload em 2 etapas:
    1. Valida tamanho, extensão e conflito de nome.
    2. Cria registro em documents com ocr_status='pending'.
    3. Retorna URL pré-assinada para PUT direto no R2.
    """
    # --- Validação de tamanho ---
    if body.size_bytes > settings.MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Arquivo excede o limite de {settings.MAX_FILE_SIZE_BYTES // 1_048_576}MB.",
        )
    if body.size_bytes <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="size_bytes deve ser positivo.")

    # --- Extensão segura (sem path traversal) ---
    raw_name = body.name
    dot_idx = raw_name.rfind(".")
    if dot_idx == -1:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nome do arquivo sem extensão.")
    ext = raw_name[dot_idx + 1:].lower()
    if not ext.isalnum():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Extensão inválida.")
    if ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Extensão .{ext} não permitida. Permitidas: {', '.join(sorted(_ALLOWED_EXT))}",
        )

    # --- Valida que a pasta existe e o usuário tem acesso (RLS filtra) ---
    folder = await DocumentsService.find_folder_for_upload(conn, body.folder_id, body.company_id)
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    if folder["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para fazer upload nesta pasta.")

    # --- Conflito de nome na mesma pasta ---
    conflict = await DocumentsService.find_name_conflict(conn, body.folder_id, raw_name)
    if conflict is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Já existe um arquivo com este nome nesta pasta.",
        )

    # --- Cria registro em documents (ocr_status=pending, storage_path já definido) ---
    document_id = uuid4()
    key = storage_service.storage_key(str(body.company_id), str(document_id), ext)
    user_id = claims["sub"]

    row = await DocumentsService.insert_pending_document(
        admin_conn,
        document_id=document_id, folder_id=body.folder_id, company_id=body.company_id,
        name=raw_name, mime_type=_MIME_MAP.get(ext, body.content_type), file_type=ext,
        size_bytes=body.size_bytes, storage_path=key, uploaded_by=user_id,
    )

    upload_url, expires_at = storage_service.generate_upload_url(
        key=key,
        content_type=_MIME_MAP.get(ext, body.content_type),
    )

    return {
        "document_id": row["id"],
        "upload_url": upload_url,
        "expires_at": expires_at.isoformat(),
        "storage_key": key,
        "mock_mode": storage_service.is_mock(),
    }


# ---------------------------------------------------------------------------
# POST /documents/mock-upload/{key} — endpoint de upload interno (mock only)
# Substitui o PUT direto ao R2 durante desenvolvimento local
# ---------------------------------------------------------------------------

@router.put("/mock-upload/{safe_key:path}", include_in_schema=False)
async def mock_upload(safe_key: str, request: Request) -> dict[str, Any]:
    """
    Recebe o arquivo e salva no mock storage local.
    Usado apenas quando R2 não está configurado (mock_mode=true).
    """
    if not storage_service.is_mock():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    data = await request.body()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Body vazio.")
    storage_service.mock_save(safe_key, data)
    return {"ok": True, "size": len(data)}


# ---------------------------------------------------------------------------
# POST /documents/:id/confirm — confirma upload e dispara OCR
# DEVE vir antes de /{document_id} para FastAPI não confundir ":id/confirm"
# ---------------------------------------------------------------------------

@router.post("/{document_id}/confirm")
async def confirm_upload(
    document_id: UUID,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Fase 2 do upload em 2 etapas:
    1. HEAD no storage para verificar que o objeto existe.
    2. Calcula SHA-256 (streaming para não estourar memória em 50MB).
    3. Atualiza documents com content_hash.
    4. Cria ocr_job em pending — mesma transação (R3).
    """
    doc = await DocumentsService.get_document_for_confirm(admin_conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["content_hash"] is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Upload já confirmado.")

    key = doc["storage_path"]

    meta = storage_service.head_object(key)
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="Arquivo não encontrado no storage. Realize o upload antes de confirmar.",
        )

    content_hash = storage_service.compute_sha256(key)
    if content_hash is None:
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="Não foi possível calcular o hash do arquivo.",
        )

    duplicate = await DocumentsService.find_duplicate_by_hash(admin_conn, doc["company_id"], content_hash, document_id)
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Arquivo idêntico (mesmo SHA-256) já existe nesta empresa.",
        )

    row = await DocumentsService.confirm_upload_transaction(
        admin_conn, document_id=document_id, content_hash=content_hash, user_id=claims["sub"],
    )
    if row["folder_id"] is not None:
        await notify_folder_favoriters(
            admin_conn, row["folder_id"], row["company_id"], claims["sub"],
            f'Novo documento "{row["name"]}" foi enviado a uma pasta que você ancorou.',
        )

    return dict(row)


# ---------------------------------------------------------------------------
# GET /documents/mock-download/:key — serve arquivo para download (mock only)
# ---------------------------------------------------------------------------

@router.get("/mock-download/{safe_key:path}", include_in_schema=False)
async def mock_download_file(safe_key: str, filename: str = "") -> Response:
    """Serve o arquivo com Content-Disposition: attachment. Apenas em mock mode."""
    if not storage_service.is_mock():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    data = storage_service.mock_read(safe_key)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Arquivo não encontrado no mock storage.")
    ext = safe_key.rsplit(".", 1)[-1].lower() if "." in safe_key else "bin"
    content_type = _MIME_MAP.get(ext, "application/octet-stream")
    safe_fn = filename or safe_key.rsplit("__", 1)[-1]
    disposition = f'attachment; filename="{safe_fn}"; filename*=UTF-8\'\'{quote(safe_fn)}'
    return Response(content=data, media_type=content_type, headers={"Content-Disposition": disposition})


# ---------------------------------------------------------------------------
# GET /documents/:id/download-url — URL pré-assinada para download unitário
# ---------------------------------------------------------------------------

@router.get("/{document_id}/download-url")
async def get_download_url(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    URL pré-assinada para download com Content-Disposition: attachment.
    Expiração: 1 hora.
    """
    doc = await DocumentsService.get_document_for_download(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")

    download_url, expires_at = storage_service.generate_download_url(
        key=doc["storage_path"],
        filename=doc["name"],
        content_type=doc["mime_type"],
    )
    return {
        "download_url": download_url,
        "expires_at": expires_at.isoformat(),
        "name": doc["name"],
        "size_bytes": doc["size_bytes"],
        "mime_type": doc["mime_type"],
    }


# ---------------------------------------------------------------------------
# POST /documents/bulk-download — gera ZIP de múltiplos documentos
# DEVE vir antes de /{document_id} para não ser capturado pelo parâmetro UUID
# ---------------------------------------------------------------------------

@router.post("/bulk-download")
async def bulk_download(
    body: BulkDownloadRequest,
    conn: asyncpg.Connection = Depends(get_db),
) -> StreamingResponse:
    """
    Gera ZIP de múltiplos documentos e retorna como streaming.
    - RLS filtra automaticamente documentos inacessíveis (não aparecem nas rows).
    - Arquivos ausentes no storage são ignorados com aviso no nome (não bloqueiam o ZIP).
    - Limite: 50 documentos por chamada.
    - Usa arquivo temporário para o ZIP (evita armazenar tudo em memória).
    """
    if not body.document_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Lista de documentos vazia.")
    if len(body.document_ids) > _BULK_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Máximo de {_BULK_LIMIT} documentos por lote.",
        )

    rows = await DocumentsService.fetch_documents_for_bulk_download(conn, [str(did) for did in body.document_ids])
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nenhum documento encontrado ou acessível.")

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            seen_names: dict[str, int] = {}
            for row in rows:
                data = storage_service.read_object(row["storage_path"])
                if data is None:
                    continue  # arquivo ausente no storage — pula silenciosamente

                base_name = row["name"]
                if base_name in seen_names:
                    seen_names[base_name] += 1
                    dot = base_name.rfind(".")
                    if dot != -1:
                        base_name = f"{base_name[:dot]} ({seen_names[base_name]}){base_name[dot:]}"
                    else:
                        base_name = f"{base_name} ({seen_names[base_name]})"
                else:
                    seen_names[base_name] = 1

                zf.writestr(base_name, data)
        tmp.flush()

        tmp.seek(0)
        zip_bytes = tmp.read()
    finally:
        tmp.close()
        os.unlink(tmp.name)

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="docke_download.zip"'},
    )


# ---------------------------------------------------------------------------
# POST /documents/bulk-move — move múltiplos documentos para uma pasta destino
# ---------------------------------------------------------------------------

@router.post("/bulk-move")
async def bulk_move(
    body: BulkMoveRequest,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Move documentos em lote para target_folder_id.
    RLS do UPDATE (documents_update) valida acesso ao folder destino via WITH CHECK.
    activity_log: INSERT para cada documento movido (R2 / invariante append-only).
    """
    if not body.document_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Lista vazia.")
    if len(body.document_ids) > _BULK_LIMIT:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Máximo de {_BULK_LIMIT} documentos por lote.")

    user_id = claims["sub"]

    target = await DocumentsService.find_target_folder_for_move(conn, body.target_folder_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta destino não encontrada.")
    if target["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão na pasta destino.")

    doc_ids = [str(did) for did in body.document_ids]

    result = await DocumentsService.bulk_move_documents(conn, doc_ids, body.target_folder_id, target["company_id"])

    if result:
        await DocumentsService.log_move_activity(
            admin_conn, user_id=user_id, doc_ids=doc_ids, company_id=target["company_id"], target_folder_id=body.target_folder_id,
        )
        plural = "s" if len(result) > 1 else ""
        await notify_folder_favoriters(
            admin_conn, body.target_folder_id, target["company_id"], user_id,
            f'{len(result)} documento{plural} movido{plural} para uma pasta que você ancorou.',
        )

    return {
        "moved": len(result),
        "document_ids": [r["id"] for r in result],
    }


# ---------------------------------------------------------------------------
# POST /documents/bulk-delete — soft delete em lote
# ---------------------------------------------------------------------------

@router.post("/bulk-delete", status_code=status.HTTP_200_OK)
async def bulk_delete(
    body: BulkDeleteRequest,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Soft delete em lote. Mesma limitação de RLS do delete unitário:
    conn valida visibilidade + permissão, admin_conn executa o UPDATE.
    activity_log: INSERT para cada documento deletado.
    """
    if not body.document_ids:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Lista vazia.")
    if len(body.document_ids) > _BULK_LIMIT:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Máximo de {_BULK_LIMIT} documentos por lote.")

    user_id = claims["sub"]
    doc_ids = [str(did) for did in body.document_ids]

    visible = await DocumentsService.fetch_documents_with_permission(conn, doc_ids)

    # admin exclui qualquer documento no seu escopo; operador só os que ele mesmo inseriu.
    deletable_ids = [
        r["id"] for r in visible
        if r["permission"] == "admin" or (r["permission"] == "operador" and r["uploaded_by"] == user_id)
    ]
    if not deletable_ids:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para deletar nenhum dos documentos informados.")

    # Pastas de origem, coletadas ANTES do soft delete (pra notificar quem favoritou).
    source_folders = await DocumentsService.fetch_source_folders(conn, deletable_ids)

    deleted = await DocumentsService.soft_delete_bulk(admin_conn, deletable_ids)

    if deleted:
        company_id = deleted[0]["company_id"]
        await DocumentsService.log_bulk_delete_activity(
            admin_conn, user_id=user_id, doc_ids=[r["id"] for r in deleted], company_id=company_id,
        )
        for sf in source_folders:
            await notify_folder_favoriters(
                admin_conn, sf["folder_id"], sf["company_id"], user_id,
                "Um ou mais documentos foram excluídos de uma pasta que você ancorou.",
            )

    return {
        "deleted": len(deleted),
        "document_ids": [r["id"] for r in deleted],
        "skipped": len(body.document_ids) - len(deletable_ids),
    }


# ---------------------------------------------------------------------------
# GET /documents/mock-preview/:key — serve arquivo para preview inline (mock only)
# ---------------------------------------------------------------------------

@router.get("/mock-preview/{safe_key:path}", include_in_schema=False)
async def mock_preview(safe_key: str) -> Response:
    """
    Serve o arquivo com Content-Disposition: inline para preview no browser.
    Apenas ativo em mock mode (sem R2 configurado).
    """
    if not storage_service.is_mock():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    data = storage_service.mock_read(safe_key)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Arquivo não encontrado no mock storage.")
    ext = safe_key.rsplit(".", 1)[-1].lower() if "." in safe_key else "bin"
    content_type = _MIME_MAP.get(ext, "application/octet-stream")
    return Response(
        content=data,
        media_type=content_type,
        headers={"Content-Disposition": "inline"},
    )


# ---------------------------------------------------------------------------
# GET /documents/:id/preview-url — URL pré-assinada para preview inline
# ---------------------------------------------------------------------------

@router.get("/{document_id}/preview-url")
async def get_preview_url(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    Retorna URL pré-assinada para abrir o documento inline no browser.
    - Expiração: 5 minutos.
    - Content-Disposition: inline (abre no browser, não faz download).
    - Documentos > 10MB: retorna inline=false e orientação para download.
    """
    doc = await DocumentsService.get_document_for_preview(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")

    if doc["size_bytes"] > _PREVIEW_SIZE_LIMIT:
        return {
            "inline": False,
            "preview_url": None,
            "expires_at": None,
            "size_bytes": doc["size_bytes"],
            "size_limit_bytes": _PREVIEW_SIZE_LIMIT,
            "message": f"Arquivo com {doc['size_bytes'] // 1_048_576}MB excede o limite de 10MB para preview inline. Use o download.",
        }

    preview_url, expires_at = storage_service.generate_preview_url(
        key=doc["storage_path"],
        content_type=doc["mime_type"],
    )
    return {
        "inline": True,
        "preview_url": preview_url,
        "expires_at": expires_at.isoformat(),
        "size_bytes": doc["size_bytes"],
        "mime_type": doc["mime_type"],
        "name": doc["name"],
    }


# ---------------------------------------------------------------------------
# GET /documents/:id/xml-fields — extrai campos-chave de XML fiscal (NFe/NFCe)
# ---------------------------------------------------------------------------

@router.get("/{document_id}/xml-fields")
async def get_xml_fields(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    Extrai campos-chave (emitente, CNPJ, valor, data, número, chave de acesso)
    de um documento XML fiscal (NFe/NFCe padrão SEFAZ).
    Retorna {"recognized": false} se o documento não for XML ou não seguir o schema NFe.
    """
    doc = await DocumentsService.get_document_for_xml(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")

    ext = doc["name"].rsplit(".", 1)[-1].lower() if "." in doc["name"] else ""
    if ext != "xml" and doc["mime_type"] != "application/xml":
        return {"recognized": False, "reason": "Documento não é um arquivo XML."}

    data = storage_service.read_object(doc["storage_path"])
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Arquivo não encontrado no storage.")

    fields = DocumentsService.extract_nfe_fields(data)
    if fields is None:
        return {"recognized": False, "reason": "XML não segue o schema de NFe/NFCe reconhecido."}
    return fields


# ---------------------------------------------------------------------------
# GET /documents/recent — documentos mais recentes da empresa (sem folder obrigatório)
# DEVE vir antes de GET "" para FastAPI não confundir "recent" como document_id
# ---------------------------------------------------------------------------

@router.get("/recent")
async def list_recent_documents(
    company_id: UUID = Query(...),
    limit: int = Query(10, ge=1, le=50),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await DocumentsService.list_recent(conn, company_id, limit)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /documents — lista documentos de uma pasta (RLS filtra automaticamente)
# ---------------------------------------------------------------------------

@router.get("")
async def list_documents(
    folder_id: UUID = Query(...),
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await DocumentsService.list_by_folder(conn, folder_id, company_id)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /documents/:id — detalhes de um documento
# ---------------------------------------------------------------------------

@router.get("/{document_id}")
async def get_document(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    row = await DocumentsService.get_document_detail(conn, document_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    return dict(row)


# ---------------------------------------------------------------------------
# PATCH /documents/:id — atualiza metadados editáveis
# ---------------------------------------------------------------------------

@router.patch("/{document_id}")
async def patch_document(
    document_id: UUID,
    body: DocumentPatch,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    if all(v is None for v in [body.name, body.sector, body.competencia, body.tipo_fiscal]):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nenhum campo para atualizar.")

    row = await DocumentsService.patch_metadata(
        conn, document_id,
        name=body.name, sector=body.sector, competencia=body.competencia, tipo_fiscal=body.tipo_fiscal,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    return dict(row)


# ---------------------------------------------------------------------------
# DELETE /documents/:id — soft delete
# ---------------------------------------------------------------------------

@router.delete("/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    doc = await DocumentsService.get_document_for_delete(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    user_id = claims["sub"]
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para deletar este documento.")
    if doc["permission"] == "operador" and str(doc["uploaded_by"]) != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você só pode excluir documentos que você mesmo inseriu.")

    await DocumentsService.soft_delete_single(admin_conn, document_id)


# ---------------------------------------------------------------------------
# POST /documents/:id/restore — restaura da lixeira
# ---------------------------------------------------------------------------

@router.post("/{document_id}/restore")
async def restore_document(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Regra de pasta deletada: se a pasta original está deletada, restaura
    na primeira pasta raiz ativa da empresa.
    """
    user_id = claims["sub"]

    doc = await DocumentsService.get_trashed_document(admin_conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado na lixeira.")

    original_folder_id = doc["deleted_original_folder_id"] or doc["folder_id"]
    target_folder = await DocumentsService.find_folder_by_id(admin_conn, original_folder_id)
    if target_folder is None:
        target_folder = await DocumentsService.find_root_folder(admin_conn, doc["company_id"])
        if target_folder is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Pasta original deletada e nenhuma pasta raiz disponível na empresa.",
            )

    permission = await DocumentsService.check_permission_for_path(
        admin_conn, user_id, str(target_folder["path"]), target_folder["company_id"],
    )
    if permission not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão na pasta de destino.")

    row = await DocumentsService.restore_single(admin_conn, document_id, target_folder["id"])
    return dict(row)


# ---------------------------------------------------------------------------
# POST /documents/:id/retry-ocr — cria novo job de OCR (M3.3)
# ---------------------------------------------------------------------------

@router.post("/{document_id}/retry-ocr", status_code=status.HTTP_202_ACCEPTED)
async def retry_ocr(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    """
    Cria um novo job de OCR para o documento, colocando em fila novamente.
    Apenas documentos com ocr_status 'failed' ou 'done' podem ser re-enfileirados.
    Não edita jobs existentes — sempre cria um novo (I1 append-only em ocr_jobs).
    """
    doc = await DocumentsService.get_document_for_ocr_retry(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["ocr_status"] == "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe um job de OCR pendente para este documento.")
    if doc["ocr_status"] == "processing":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="OCR em processamento. Aguarde a conclusão.")

    await DocumentsService.retry_ocr_transaction(admin_conn, document_id)

    return {"document_id": str(document_id), "name": doc["name"], "ocr_status": "pending", "message": "Job de OCR criado com sucesso."}
