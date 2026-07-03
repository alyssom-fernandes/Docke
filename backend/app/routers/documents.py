from datetime import date
from typing import Any
from uuid import UUID, uuid4

import io
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from urllib.parse import quote

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin
from app.config import settings
from app.services import storage_service
from app.services.notification_service import notify_folder_favoriters

router = APIRouter(prefix="/documents", tags=["documents"])

_ALLOWED_EXT = set(settings.ALLOWED_EXTENSIONS)

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
    # Usa apenas o sufixo mais à direita e converte para minúsculas
    raw_name = body.name
    dot_idx = raw_name.rfind(".")
    if dot_idx == -1:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nome do arquivo sem extensão.")
    ext = raw_name[dot_idx + 1:].lower()
    # Rejeita caracteres que não sejam alfanuméricos (protege path traversal)
    if not ext.isalnum():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Extensão inválida.")
    if ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Extensão .{ext} não permitida. Permitidas: {', '.join(sorted(_ALLOWED_EXT))}",
        )

    # --- Valida que a pasta existe e o usuário tem acesso (RLS filtra) ---
    folder = await conn.fetchrow(
        """
        SELECT f.id, f.company_id, f.path,
               public.user_has_access(auth.uid(), f.path, f.company_id) AS permission
        FROM public.folders f
        WHERE f.id = $1 AND f.company_id = $2 AND f.deleted_at IS NULL
        """,
        body.folder_id,
        body.company_id,
    )
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    if folder["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para fazer upload nesta pasta.")

    # --- Conflito de nome na mesma pasta ---
    conflict = await conn.fetchval(
        "SELECT id FROM public.documents WHERE folder_id = $1 AND name = $2 AND deleted_at IS NULL",
        body.folder_id,
        raw_name,
    )
    if conflict is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Já existe um arquivo com este nome nesta pasta.",
        )

    # --- Cria registro em documents (ocr_status=pending, storage_path já definido) ---
    document_id = uuid4()
    key = storage_service.storage_key(str(body.company_id), str(document_id), ext)
    user_id = claims["sub"]

    row = await admin_conn.fetchrow(
        """
        INSERT INTO public.documents
          (id, folder_id, company_id, name, mime_type, file_type,
           size_bytes, storage_path, uploaded_by, ocr_status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        RETURNING id::text, name, storage_path, created_at
        """,
        document_id,
        body.folder_id,
        body.company_id,
        raw_name,
        _MIME_MAP.get(ext, body.content_type),
        ext,
        body.size_bytes,
        key,
        user_id,
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
    # safe_key usa __ como separador (gerado pelo storage_service)
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
    doc = await admin_conn.fetchrow(
        "SELECT id, storage_path, company_id, content_hash FROM public.documents WHERE id = $1",
        document_id,
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["content_hash"] is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Upload já confirmado.")

    key = doc["storage_path"]

    # HEAD — verifica existência no storage
    meta = storage_service.head_object(key)
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="Arquivo não encontrado no storage. Realize o upload antes de confirmar.",
        )

    # Calcula SHA-256 (streaming)
    content_hash = storage_service.compute_sha256(key)
    if content_hash is None:
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="Não foi possível calcular o hash do arquivo.",
        )

    # Verifica duplicata por hash dentro da empresa
    duplicate = await admin_conn.fetchval(
        """
        SELECT id FROM public.documents
        WHERE company_id = $1 AND content_hash = $2 AND id != $3
        """,
        doc["company_id"],
        content_hash,
        document_id,
    )
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Arquivo idêntico (mesmo SHA-256) já existe nesta empresa.",
        )

    # Atualiza hash + cria ocr_job em transação única (R3)
    async with admin_conn.transaction():
        row = await admin_conn.fetchrow(
            """
            UPDATE public.documents
            SET content_hash = $2, updated_at = now()
            WHERE id = $1
            RETURNING id::text, name, folder_id, company_id, storage_path, content_hash,
                      size_bytes, ocr_status, created_at, updated_at
            """,
            document_id,
            content_hash,
        )
        await admin_conn.execute(
            "INSERT INTO public.ocr_jobs (document_id, status) VALUES ($1, 'pending')",
            document_id,
        )
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot)
            VALUES ($1::uuid, $2::uuid, 'upload', 'document', $3::uuid, $4)
            """,
            claims["sub"],
            str(row["company_id"]),
            str(document_id),
            row["name"],
        )
        if row["folder_id"] is not None:
            await notify_folder_favoriters(
                admin_conn, row["folder_id"], row["company_id"], claims["sub"],
                f'Novo documento "{row["name"]}" foi enviado a uma pasta que você favoritou.',
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
    doc = await conn.fetchrow(
        "SELECT id, name, storage_path, mime_type, size_bytes FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
        document_id,
    )
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

_BULK_LIMIT = 50  # máximo de arquivos por lote


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

    # Busca metadados — RLS garante que só retorna documentos visíveis ao usuário
    rows = await conn.fetch(
        """
        SELECT id::text, name, storage_path, mime_type, size_bytes
        FROM public.documents
        WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
        ORDER BY name
        """,
        [str(did) for did in body.document_ids],
    )
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nenhum documento encontrado ou acessível.")

    # Constrói ZIP num arquivo temporário (evita OutOfMemory para lotes grandes)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    try:
        with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            seen_names: dict[str, int] = {}
            for row in rows:
                data = storage_service.read_object(row["storage_path"])
                if data is None:
                    continue  # arquivo ausente no storage — pula silenciosamente

                # Garante nomes únicos no ZIP (mesmo basename em pastas diferentes)
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

        # Lê o ZIP e retorna como streaming
        tmp.seek(0)
        zip_bytes = tmp.read()
    finally:
        tmp.close()
        import os
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

    # Valida pasta destino e permissão (RLS garante visibilidade)
    target = await conn.fetchrow(
        """
        SELECT f.id, f.company_id,
               public.user_has_access(auth.uid(), f.path, f.company_id) AS permission
        FROM public.folders f
        WHERE f.id = $1 AND f.deleted_at IS NULL
        """,
        body.target_folder_id,
    )
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta destino não encontrada.")
    if target["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão na pasta destino.")

    doc_ids = [str(did) for did in body.document_ids]

    # UPDATE via conn: RLS WITH CHECK valida que user tem editor+ na NOVA pasta
    result = await conn.fetch(
        """
        UPDATE public.documents
        SET folder_id  = $2,
            company_id = $3,
            updated_at = now()
        WHERE id = ANY($1::uuid[])
          AND deleted_at IS NULL
          AND company_id = $3
        RETURNING id::text, name
        """,
        doc_ids,
        body.target_folder_id,
        target["company_id"],
    )

    if result:
        # activity_log para cada documento movido (INSERT via admin_conn — append-only)
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
            SELECT $1::uuid, $3::uuid, 'move', 'document', id::uuid, name, $4::jsonb
            FROM public.documents
            WHERE id = ANY($2::uuid[]) AND deleted_at IS NULL
            """,
            user_id,
            doc_ids,
            str(target["company_id"]),
            f'{{"target_folder_id": "{body.target_folder_id}"}}',
        )
        plural = "s" if len(result) > 1 else ""
        await notify_folder_favoriters(
            admin_conn, body.target_folder_id, target["company_id"], user_id,
            f'{len(result)} documento{plural} movido{plural} para uma pasta que você favoritou.',
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

    # Busca docs visíveis + permissão via conn (RLS + user_has_access)
    visible = await conn.fetch(
        """
        SELECT d.id::text, d.name, d.company_id::text, d.uploaded_by::text,
               public.user_has_access(
                 auth.uid(),
                 (SELECT f.path FROM public.folders f WHERE f.id = d.folder_id),
                 d.company_id
               ) AS permission
        FROM public.documents d
        WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL
        """,
        doc_ids,
    )

    # admin exclui qualquer documento no seu escopo; operador só os que ele mesmo inseriu.
    deletable_ids = [
        r["id"] for r in visible
        if r["permission"] == "admin" or (r["permission"] == "operador" and r["uploaded_by"] == user_id)
    ]
    if not deletable_ids:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para deletar nenhum dos documentos informados.")

    # Pastas de origem, coletadas ANTES do soft delete (pra notificar quem favoritou).
    source_folders = await conn.fetch(
        "SELECT DISTINCT folder_id, company_id FROM public.documents WHERE id = ANY($1::uuid[]) AND folder_id IS NOT NULL",
        deletable_ids,
    )

    # Soft delete via admin_conn (bypassa bloqueio de RLS para deleted_at)
    # trash_expires_at (ADR-025/030): usa o retention_days da empresa NO MOMENTO da exclusão.
    deleted = await admin_conn.fetch(
        """
        UPDATE public.documents d
        SET deleted_at = now(),
            deleted_original_folder_id = folder_id,
            trash_expires_at = now() + (c.retention_days || ' days')::interval
        FROM public.companies c
        WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL AND c.id = d.company_id
        RETURNING d.id::text, d.name, d.company_id::text
        """,
        deletable_ids,
    )

    if deleted:
        company_id = deleted[0]["company_id"]
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot)
            SELECT $1::uuid, $3::uuid, 'delete', 'document', id::uuid, name
            FROM public.documents
            WHERE id = ANY($2::uuid[])
            """,
            user_id,
            [r["id"] for r in deleted],
            company_id,
        )
        for sf in source_folders:
            await notify_folder_favoriters(
                admin_conn, sf["folder_id"], sf["company_id"], user_id,
                "Um ou mais documentos foram excluídos de uma pasta que você favoritou.",
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
    # Detecta content-type pela extensão no safe_key
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

_PREVIEW_SIZE_LIMIT = 10 * 1024 * 1024  # 10MB


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
    doc = await conn.fetchrow(
        """
        SELECT id, name, storage_path, mime_type, size_bytes
        FROM public.documents
        WHERE id = $1 AND deleted_at IS NULL
        """,
        document_id,
    )
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

# Namespace padrão dos XMLs de NFe/NFCe (portal fiscal SEFAZ)
_NFE_NS = {"nfe": "http://www.portalfiscal.inf.br/nfe"}


def _extract_nfe_fields(xml_bytes: bytes) -> dict[str, Any] | None:
    """
    Faz parsing de um XML de NFe/NFCe e extrai os campos mais relevantes
    para conferência rápida sem precisar abrir o XML bruto.
    Retorna None se o XML não seguir o schema reconhecido (não é NFe).
    """
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return None

    inf_nfe = root.find(".//nfe:infNFe", _NFE_NS)
    if inf_nfe is None:
        return None

    def text(path: str) -> str | None:
        el = inf_nfe.find(path, _NFE_NS)
        return el.text.strip() if el is not None and el.text else None

    chave_acesso = (inf_nfe.get("Id") or "").replace("NFe", "") or None

    return {
        "recognized": True,
        "chave_acesso": chave_acesso,
        "numero": text("nfe:ide/nfe:nNF"),
        "serie": text("nfe:ide/nfe:serie"),
        "data_emissao": text("nfe:ide/nfe:dhEmi") or text("nfe:ide/nfe:dEmi"),
        "natureza_operacao": text("nfe:ide/nfe:natOp"),
        "emitente_nome": text("nfe:emit/nfe:xNome"),
        "emitente_cnpj": text("nfe:emit/nfe:CNPJ"),
        "destinatario_nome": text("nfe:dest/nfe:xNome"),
        "destinatario_cnpj": text("nfe:dest/nfe:CNPJ") or text("nfe:dest/nfe:CPF"),
        "valor_total": text("nfe:total/nfe:ICMSTot/nfe:vNF"),
    }


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
    doc = await conn.fetchrow(
        "SELECT id, name, storage_path, mime_type, file_type FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
        document_id,
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")

    ext = doc["name"].rsplit(".", 1)[-1].lower() if "." in doc["name"] else ""
    if ext != "xml" and doc["mime_type"] != "application/xml":
        return {"recognized": False, "reason": "Documento não é um arquivo XML."}

    data = storage_service.read_object(doc["storage_path"])
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Arquivo não encontrado no storage.")

    fields = _extract_nfe_fields(data)
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
    rows = await conn.fetch(
        """
        SELECT
          d.id::text,
          d.name,
          d.folder_id::text,
          d.company_id::text,
          d.mime_type,
          d.file_type,
          d.size_bytes,
          d.ocr_status,
          d.created_at
        FROM public.documents d
        WHERE d.company_id = $1 AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC
        LIMIT $2
        """,
        company_id,
        limit,
    )
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
    rows = await conn.fetch(
        """
        SELECT
          d.id::text,
          d.name,
          d.folder_id::text,
          d.company_id::text,
          d.mime_type,
          d.file_type,
          d.size_bytes,
          d.storage_path,
          d.content_hash,
          d.sector,
          d.competencia,
          d.tipo_fiscal,
          d.ocr_status,
          d.uploaded_by::text,
          d.created_at,
          d.updated_at
        FROM public.documents d
        WHERE d.folder_id = $1
          AND d.company_id = $2
          AND d.deleted_at IS NULL
        ORDER BY d.name
        """,
        folder_id,
        company_id,
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /documents/:id — detalhes de um documento
# ---------------------------------------------------------------------------

@router.get("/{document_id}")
async def get_document(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    row = await conn.fetchrow(
        """
        SELECT
          d.id::text,
          d.name,
          d.folder_id::text,
          d.company_id::text,
          d.mime_type,
          d.file_type,
          d.size_bytes,
          d.storage_path,
          d.content_hash,
          d.sector,
          d.competencia,
          d.tipo_fiscal,
          d.ocr_status,
          d.ocr_text,
          d.ocr_completed_at,
          d.uploaded_by::text,
          d.created_at,
          d.updated_at,
          d.deleted_original_folder_id::text
        FROM public.documents d
        WHERE d.id = $1 AND d.deleted_at IS NULL
        """,
        document_id,
    )
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

    row = await conn.fetchrow(
        """
        UPDATE public.documents
        SET
          name        = COALESCE($2, name),
          sector      = COALESCE($3, sector),
          competencia = COALESCE($4, competencia),
          tipo_fiscal = COALESCE($5, tipo_fiscal),
          updated_at  = now()
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING
          id::text, name, folder_id::text, company_id::text,
          mime_type, file_type, size_bytes, sector, competencia,
          tipo_fiscal, ocr_status, created_at, updated_at
        """,
        document_id,
        body.name,
        body.sector,
        body.competencia,
        body.tipo_fiscal,
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
    doc = await conn.fetchrow(
        """
        SELECT d.id, d.folder_id, d.company_id, d.uploaded_by,
               public.user_has_access(
                 auth.uid(),
                 (SELECT f.path FROM public.folders f WHERE f.id = d.folder_id),
                 d.company_id
               ) AS permission
        FROM public.documents d
        WHERE d.id = $1 AND d.deleted_at IS NULL
        """,
        document_id,
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    user_id = claims["sub"]
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para deletar este documento.")
    if doc["permission"] == "operador" and str(doc["uploaded_by"]) != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você só pode excluir documentos que você mesmo inseriu.")

    await admin_conn.execute(
        """
        UPDATE public.documents d
        SET deleted_at = now(),
            deleted_original_folder_id = folder_id,
            trash_expires_at = now() + (c.retention_days || ' days')::interval
        FROM public.companies c
        WHERE d.id = $1 AND d.deleted_at IS NULL AND c.id = d.company_id
        """,
        document_id,
    )


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

    doc = await admin_conn.fetchrow(
        """
        SELECT id, folder_id, company_id, deleted_at,
               deleted_original_folder_id
        FROM public.documents
        WHERE id = $1 AND deleted_at IS NOT NULL
        """,
        document_id,
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado na lixeira.")

    original_folder_id = doc["deleted_original_folder_id"] or doc["folder_id"]
    target_folder = await admin_conn.fetchrow(
        "SELECT id, path, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
        original_folder_id,
    )
    if target_folder is None:
        target_folder = await admin_conn.fetchrow(
            """
            SELECT id, path, company_id FROM public.folders
            WHERE company_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
            ORDER BY created_at
            LIMIT 1
            """,
            doc["company_id"],
        )
        if target_folder is None:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Pasta original deletada e nenhuma pasta raiz disponível na empresa.",
            )

    permission = await admin_conn.fetchval(
        "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
        user_id,
        str(target_folder["path"]),
        str(target_folder["company_id"]),
    )
    if permission not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão na pasta de destino.")

    row = await admin_conn.fetchrow(
        """
        UPDATE public.documents
        SET deleted_at = NULL,
            folder_id = $2,
            deleted_original_folder_id = NULL,
            updated_at = now()
        WHERE id = $1
        RETURNING
          id::text, name, folder_id::text, company_id::text,
          mime_type, file_type, size_bytes, sector, competencia,
          tipo_fiscal, ocr_status, created_at, updated_at
        """,
        document_id,
        target_folder["id"],
    )
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
    doc = await conn.fetchrow(
        "SELECT id, ocr_status, name FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
        document_id,
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["ocr_status"] == "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe um job de OCR pendente para este documento.")
    if doc["ocr_status"] == "processing":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="OCR em processamento. Aguarde a conclusão.")

    async with admin_conn.transaction():
        await admin_conn.execute(
            "INSERT INTO public.ocr_jobs (document_id, status) VALUES ($1, 'pending')",
            document_id,
        )
        await admin_conn.execute(
            "UPDATE public.documents SET ocr_status = 'pending', updated_at = now() WHERE id = $1",
            document_id,
        )

    return {"document_id": str(document_id), "name": doc["name"], "ocr_status": "pending", "message": "Job de OCR criado com sucesso."}
