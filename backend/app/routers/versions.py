"""
ADR-024/029/034 — Versionamento de documentos.

Regras:
- Limite de 10 versões por documento. Ao atingir, BLOQUEIA novo upload
  (nunca exclui a mais antiga automaticamente — pode ter valor probatório fiscal).
- Restaurar uma versão antiga sempre cria uma NOVA versão (clona o storage_key
  da versão escolhida — sem duplicar o arquivo no storage, já que o conteúdo
  é idêntico). Nunca reverte apagando histórico.
- Toda nova versão (upload ou restore) dispara OCR novamente.
- Exclusão manual de versão verifica se outra versão compartilha o mesmo
  storage_key (caso de uma restauração) antes de remover o objeto do storage.
- Busca indexa só a versão atual (documents.ocr_text é sobrescrito a cada nova versão).
"""
import logging
from typing import Any
from uuid import UUID, uuid4

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import settings
from app.dependencies import get_current_user, get_db, get_db_admin
from app.services import storage_service
from app.services.documents_service import DocumentsService
from app.services.notification_service import notify_document_watchers

logger = logging.getLogger("docke.versions")
from app.services.versions_service import VersionsService

router = APIRouter(prefix="/documents", tags=["versions"])

_MAX_VERSIONS = 10

_MIME_MAP: dict[str, str] = {
    "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "csv": "text/csv",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "xml": "application/xml",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "txt": "text/plain",
}


class VersionUploadRequest(BaseModel):
    size_bytes: int
    content_type: str


async def _check_write_access(conn: asyncpg.Connection, document_id: UUID) -> dict[str, Any]:
    """Documento existe, não está na lixeira, e o usuário tem permissão de escrita (admin)."""
    doc = await VersionsService.get_document_for_write_check(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para versionar este documento.")
    return dict(doc)


# ---------------------------------------------------------------------------
# GET /documents/:id/versions — histórico de versões
# ---------------------------------------------------------------------------

@router.get("/{document_id}/versions")
async def list_versions(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    doc = await VersionsService.get_document_basic(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")

    rows = await VersionsService.list_versions(conn, document_id)
    return [dict(r) | {"is_current": r["id"] == str(doc["current_version_id"])} for r in rows]


# ---------------------------------------------------------------------------
# POST /documents/:id/versions/upload-url — fase 1: presigned URL
# ---------------------------------------------------------------------------

@router.post("/{document_id}/versions/upload-url", status_code=status.HTTP_201_CREATED)
async def create_version_upload_url(
    document_id: UUID,
    body: VersionUploadRequest,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    doc = await _check_write_access(conn, document_id)

    if body.size_bytes > settings.MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Arquivo excede o limite de {settings.MAX_FILE_SIZE_BYTES // 1_048_576}MB.",
        )

    ext = doc["name"].rsplit(".", 1)[-1].lower() if "." in doc["name"] else "bin"

    version_count = await VersionsService.count_versions(admin_conn, document_id)
    if version_count >= _MAX_VERSIONS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Este documento atingiu o limite de {_MAX_VERSIONS} versões. "
                   f"Exclua uma versão antiga manualmente ou crie um novo documento.",
        )

    next_number = await VersionsService.next_version_number(admin_conn, document_id)
    version_id = uuid4()
    key = storage_service.storage_key(str(doc["company_id"]), f"{document_id}-v{next_number}", ext)
    content_type = _MIME_MAP.get(ext, body.content_type)
    user_id = claims["sub"]

    await VersionsService.insert_version(
        admin_conn, version_id=version_id, document_id=document_id, version_number=next_number,
        storage_key=key, size_bytes=body.size_bytes, mime_type=content_type, uploaded_by=user_id,
    )

    upload_url, expires_at = storage_service.generate_upload_url(key=key, content_type=content_type)
    return {
        "version_id": str(version_id),
        "version_number": next_number,
        "upload_url": upload_url,
        "expires_at": expires_at.isoformat(),
        "mock_mode": storage_service.is_mock(),
    }


# ---------------------------------------------------------------------------
# POST /documents/:id/versions/:version_id/confirm — fase 2: confirma e ativa
# ---------------------------------------------------------------------------

@router.post("/{document_id}/versions/{version_id}/confirm")
async def confirm_version(
    document_id: UUID,
    version_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _check_write_access(conn, document_id)

    version = await VersionsService.get_version(admin_conn, version_id, document_id)
    if version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Versão não encontrada.")

    meta = storage_service.head_object(version["storage_key"])
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="Arquivo não encontrado no storage. Realize o upload antes de confirmar.",
        )

    # size_bytes declarado em /upload-url vem do cliente e não é confiável (a
    # presigned URL de PUT não impõe content-length-range) — o ContentLength
    # real do HEAD é a única fonte confiável, aqui e no limite de tamanho.
    real_size_bytes = meta.get("ContentLength")
    if real_size_bytes is not None and real_size_bytes > settings.MAX_FILE_SIZE_BYTES:
        try:
            storage_service.delete_object(version["storage_key"])
        except Exception:
            pass
        await VersionsService.delete_pending_version(admin_conn, version_id)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Arquivo excede o limite de {settings.MAX_FILE_SIZE_BYTES // 1_048_576}MB.",
        )

    async with admin_conn.transaction():
        await VersionsService.activate_version(
            admin_conn, document_id=document_id, version_id=version_id,
            storage_key=version["storage_key"], mime_type=version["mime_type"],
            size_bytes=real_size_bytes if real_size_bytes is not None else version["size_bytes"],
        )
        await DocumentsService.enqueue_ocr(admin_conn, document_id)
        await VersionsService.log_version_upload(admin_conn, document_id=document_id, user_id=claims["sub"])
        doc_row = await VersionsService.get_document_name_and_company(admin_conn, document_id)
        await notify_document_watchers(
            admin_conn, document_id, doc_row["company_id"], claims["sub"],
            f'Nova versão de "{doc_row["name"]}" foi enviada.',
        )

    return {"status": "ok", "version_id": str(version_id)}


# ---------------------------------------------------------------------------
# POST /documents/:id/versions/:version_id/restore — clona versão antiga
# ---------------------------------------------------------------------------

@router.post("/{document_id}/versions/{version_id}/restore")
async def restore_version(
    document_id: UUID,
    version_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _check_write_access(conn, document_id)

    old_version = await VersionsService.get_version(admin_conn, version_id, document_id)
    if old_version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Versão não encontrada.")

    version_count = await VersionsService.count_versions(admin_conn, document_id)
    if version_count >= _MAX_VERSIONS:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Este documento atingiu o limite de {_MAX_VERSIONS} versões. "
                   f"Exclua uma versão antiga manualmente antes de restaurar.",
        )

    next_number = await VersionsService.next_version_number(admin_conn, document_id)
    new_version_id = uuid4()
    user_id = claims["sub"]

    async with admin_conn.transaction():
        # Clona o storage_key da versão antiga — mesmo conteúdo, sem copiar o arquivo.
        await VersionsService.insert_version(
            admin_conn, version_id=new_version_id, document_id=document_id, version_number=next_number,
            storage_key=old_version["storage_key"], size_bytes=old_version["size_bytes"],
            mime_type=old_version["mime_type"], uploaded_by=user_id,
        )
        await VersionsService.activate_version(
            admin_conn, document_id=document_id, version_id=new_version_id,
            storage_key=old_version["storage_key"], mime_type=old_version["mime_type"], size_bytes=old_version["size_bytes"],
        )
        await DocumentsService.enqueue_ocr(admin_conn, document_id)
        await VersionsService.log_version_restore(
            admin_conn, document_id=document_id, user_id=user_id,
            restored_version=next_number - 1, new_version=next_number,
        )
        doc_row = await VersionsService.get_document_name_and_company(admin_conn, document_id)
        await notify_document_watchers(
            admin_conn, document_id, doc_row["company_id"], user_id,
            f'"{doc_row["name"]}" foi restaurado para uma versão anterior.',
        )

    return {"status": "ok", "new_version_id": str(new_version_id), "version_number": next_number}


# ---------------------------------------------------------------------------
# GET /documents/:id/versions/:version_id/download-url — baixa versão específica
# ---------------------------------------------------------------------------

@router.get("/{document_id}/versions/{version_id}/download-url")
async def get_version_download_url(
    document_id: UUID,
    version_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    doc = await VersionsService.get_document_for_download(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")

    version = await VersionsService.get_version_for_download(conn, version_id, document_id)
    if version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Versão não encontrada.")

    filename = f"v{version['version_number']}_{doc['name']}"
    download_url, expires_at = storage_service.generate_download_url(
        key=version["storage_key"], filename=filename, content_type=version["mime_type"],
    )
    return {"download_url": download_url, "expires_at": expires_at.isoformat(), "name": filename}


# ---------------------------------------------------------------------------
# DELETE /documents/:id/versions/:version_id — exclui versão antiga manualmente
# ---------------------------------------------------------------------------

@router.delete("/{document_id}/versions/{version_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_version(
    document_id: UUID,
    version_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    await _check_write_access(conn, document_id)

    version = await VersionsService.get_version(admin_conn, version_id, document_id)
    if version is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Versão não encontrada.")

    if await VersionsService.is_current_version(admin_conn, document_id, version_id):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Não é possível excluir a versão atual.")

    await VersionsService.delete_version_row(admin_conn, version_id)

    # Só remove o objeto do storage se nenhuma outra versão ainda referencia a
    # mesma chave (acontece quando uma restauração cloneou o storage_key).
    if not await VersionsService.storage_key_still_referenced(admin_conn, version["storage_key"]):
        try:
            storage_service.delete_object(version["storage_key"])
        except Exception:
            logger.exception(
                "Falha ao remover objeto do storage após excluir versão %s do documento %s (key=%s) — objeto pode ter ficado órfão.",
                version_id, document_id, version["storage_key"],
            )
