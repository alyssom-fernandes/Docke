from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import os
import tempfile
import zipfile
from urllib.parse import quote

import asyncio

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
_BULK_LIMIT = 1000  # máximo de documentos por lote (mover, excluir, restaurar) — antes 50 (achado A4-26)
_BULK_DOWNLOAD_LIMIT = 200  # ZIP montado em memória; para mais, a exportação completa
# Fase 6.2: preview igualado ao limite de upload — o limite de 10MB era
# artificial (URL é presigned direto pro R2, o navegador baixa sozinho,
# o backend nunca vê o arquivo). Manter os dois amarrados evita a mesma
# divergência voltar a acontecer numa mudança futura de MAX_FILE_SIZE_BYTES.
_PREVIEW_SIZE_LIMIT = settings.MAX_FILE_SIZE_BYTES


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
    # Migração (achado X2-07): data em que o documento entrou no sistema antigo.
    # Só o admin da empresa toda pode informar; vira a data do documento no
    # Docke (inclusive para a retenção contada "da data de envio").
    original_created_at: datetime | None = None


async def _original_date_allowed(
    conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID, value: datetime | None,
) -> datetime | None:
    if value is None:
        return None
    from app.dependencies import get_app_role
    from app.services.companies_service import CompaniesService

    if await get_app_role(conn, claims) != "supremo" and not await CompaniesService.user_manages_company(
        conn, claims["sub"], company_id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Só o admin da empresa informa a data original (usada na migração de outro sistema).",
        )
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    if value > datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A data original não pode estar no futuro.")
    return value


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

    # --- Conflito de nome na mesma pasta: sufixo automático "(1)", "(2)"...
    #     em vez de bloquear (padrão Dropbox/Box — ADENDO-09 §13.4) ---
    final_name = await DocumentsService.resolve_unique_name(conn, body.folder_id, raw_name)

    # --- Cria registro em documents (ocr_status=pending, storage_path já definido) ---
    document_id = uuid4()
    key = storage_service.storage_key(str(body.company_id), str(document_id), ext)
    user_id = claims["sub"]

    # O tipo vem da extensão, não do navegador: o Chrome chama XML de
    # "text/xml" e o mapa diz "application/xml". A URL é assinada com este
    # tipo e o cliente precisa mandar exatamente ele no PUT (por isso volta
    # na resposta) — antes, o XML de NF-e falhava com 403 (achado X2-03).
    content_type = _MIME_MAP.get(ext, body.content_type)
    original = await _original_date_allowed(conn, claims, body.company_id, body.original_created_at)
    row = await DocumentsService.insert_pending_document(
        admin_conn,
        document_id=document_id, folder_id=body.folder_id, company_id=body.company_id,
        name=final_name, mime_type=content_type, file_type=ext,
        size_bytes=body.size_bytes, storage_path=key, uploaded_by=user_id, created_at=original,
    )

    upload_url, expires_at = storage_service.generate_upload_url(key=key, content_type=content_type)

    return {
        "document_id": row["id"],
        "upload_url": upload_url,
        "content_type": content_type,
        "name": final_name,
        "expires_at": expires_at.isoformat(),
        "storage_key": key,
        "mock_mode": storage_service.is_mock(),
    }


# ---------------------------------------------------------------------------
# POST /documents/:id/abort-upload — desiste de um envio que não se completou
# ---------------------------------------------------------------------------

@router.post("/{document_id}/abort-upload", status_code=status.HTTP_204_NO_CONTENT)
async def abort_upload(
    document_id: UUID,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """
    O envio direto ao storage falhou: apaga o registro provisório (sem hash),
    para não sobrar um "documento fantasma" ocupando o nome (achado X2-03).
    Idempotente; documento já confirmado não é tocado.
    """
    doc = await DocumentsService.get_document_for_confirm(admin_conn, document_id, claims["sub"])
    if doc is None:
        return
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para este envio.")
    await DocumentsService.delete_pending_document(admin_conn, document_id)


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
    if not storage_service.is_valid_mock_key(safe_key):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Chave inválida.")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Body vazio.")
    storage_service.mock_save(safe_key, data)
    return {"ok": True, "size": len(data)}


# ---------------------------------------------------------------------------
# PUT /documents/mock-upload-part/{key}/{part_number} — parte individual do
# upload multipart em mock mode (dev sem R2 configurado)
# ---------------------------------------------------------------------------

@router.put("/mock-upload-part/{safe_key:path}/{part_number}", include_in_schema=False)
async def mock_upload_part(safe_key: str, part_number: int, request: Request) -> Response:
    if not storage_service.is_mock():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if not storage_service.is_valid_mock_key(safe_key):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Chave inválida.")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Body vazio.")
    part_path = storage_service.MOCK_DIR / f"{safe_key}.part{part_number}"
    part_path.write_bytes(data)
    # ETag simulado — o mock não valida, só precisa devolver algo estável.
    return Response(status_code=200, headers={"ETag": f'"mock-{part_number}"'})


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
    1. HEAD no storage para verificar que o objeto existe e obter o tamanho REAL
       (o size_bytes declarado em /upload-url vem do cliente e não é confiável —
       a presigned URL de PUT não impõe content-length-range, então o limite só
       é de fato aplicado aqui, contra o ContentLength que o próprio storage relata).
    2. Calcula SHA-256 (streaming para não estourar memória em 50MB).
    3. Atualiza documents com content_hash e o size_bytes real.
    4. Cria ocr_job em pending — mesma transação (R3).
    """
    doc = await DocumentsService.get_document_for_confirm(admin_conn, document_id, claims["sub"])
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para confirmar este upload.")
    if doc["content_hash"] is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Upload já confirmado.")

    return await _finalize_confirmed_upload(admin_conn, doc, document_id, claims["sub"])


async def _finalize_confirmed_upload(
    admin_conn: asyncpg.Connection, doc: asyncpg.Record, document_id: UUID, user_id: str,
) -> dict[str, Any]:
    """
    Fase 11.1: extraído de confirm_upload pra ser reaproveitado também pelo
    fluxo multipart (POST /documents/multipart/{id}/complete) — o objeto já
    existe completo no storage nos dois casos (PUT único ou multipart
    completado), o resto (HEAD, hash, dedup, transação) é idêntico.
    """
    key = doc["storage_path"]

    meta = await asyncio.to_thread(storage_service.head_object, key)
    if meta is None:
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="Arquivo não encontrado no storage. Realize o upload antes de confirmar.",
        )

    real_size_bytes = meta.get("ContentLength")
    if real_size_bytes is not None and real_size_bytes > settings.MAX_FILE_SIZE_BYTES:
        # O cliente pode ter declarado um tamanho menor em /upload-url e enviado
        # um arquivo maior direto pro storage (a URL pré-assinada não impõe
        # limite). Remove o objeto e o registro pendente em vez de deixar lixo.
        try:
            await asyncio.to_thread(storage_service.delete_object, key)
        except Exception:
            pass
        await DocumentsService.delete_pending_document(admin_conn, document_id)
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Arquivo excede o limite de {settings.MAX_FILE_SIZE_BYTES // 1_048_576}MB.",
        )

    content_hash = storage_service.compute_sha256(key)
    if content_hash is None:
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="Não foi possível calcular o hash do arquivo.",
        )

    # Fase 11.4: dedup real — a UNIQUE(company_id, content_hash) é um invariante
    # deliberado desde a M1.2 (um documento por conteúdo por empresa) e NÃO deve
    # ser removida; duas linhas de documento nunca podem compartilhar o mesmo
    # content_hash. O que a Fase 11.4 corrige é o desperdício: antes, ao rejeitar
    # com 409, o arquivo que acabou de subir inteiro pro R2 ficava órfão pra
    # sempre (nunca era removido), e o registro pendente (content_hash NULL)
    # também ficava preso na tabela. Agora ambos são limpos antes do 409.
    duplicate = await DocumentsService.find_duplicate_by_hash(admin_conn, doc["company_id"], content_hash, document_id)
    if duplicate is not None:
        try:
            await asyncio.to_thread(storage_service.delete_object, key)
        except Exception:
            pass  # melhor esforço — mesmo padrão de trash.py; o dedup não deve travar por isso
        await DocumentsService.delete_pending_document(admin_conn, document_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f'Arquivo idêntico (mesmo SHA-256) já existe nesta empresa: "{duplicate["name"]}".',
        )

    row = await DocumentsService.confirm_upload_transaction(
        admin_conn, document_id=document_id, content_hash=content_hash, user_id=user_id,
        real_size_bytes=real_size_bytes,
    )
    if row["folder_id"] is not None:
        await notify_folder_favoriters(
            admin_conn, row["folder_id"], row["company_id"], user_id,
            f'Novo documento "{row["name"]}" foi enviado a uma pasta que você ancorou.',
        )

    # Fase 8.5: fast-path fiscal — reaproveita o parser de NFe/NFCe já usado
    # em GET /documents/:id/xml-fields pra preencher tipo_fiscal/competencia
    # sozinho no confirm, em vez de exigir que alguém abra o XML manualmente
    # depois pra descobrir que era uma nota fiscal. Documento acabou de ser
    # criado (tipo_fiscal/competencia sempre NULL aqui), então não há risco
    # de sobrescrever algo que a pessoa já preencheu à mão. Fase 11.1: também
    # se aplica ao fluxo multipart agora que este bloco é compartilhado.
    result = dict(row)
    ext = row["name"].rsplit(".", 1)[-1].lower() if "." in row["name"] else ""
    if ext == "xml" or row["mime_type"] == "application/xml":
        xml_bytes = storage_service.read_object(row["storage_path"])
        if xml_bytes is not None:
            nfe_fields = DocumentsService.extract_nfe_fields(xml_bytes)
            if nfe_fields is not None and nfe_fields.get("recognized"):
                data_emissao = nfe_fields.get("data_emissao")
                competencia = None
                if data_emissao:
                    try:
                        competencia = date.fromisoformat(data_emissao[:10]).replace(day=1)
                    except ValueError:
                        competencia = None
                updated = await DocumentsService.patch_metadata(
                    admin_conn, document_id,
                    name=None, sector=None, competencia=competencia, tipo_fiscal="NF-e",
                )
                if updated is not None:
                    result["tipo_fiscal"] = updated["tipo_fiscal"]
                    result["competencia"] = updated["competencia"]

    return result


# ---------------------------------------------------------------------------
# Fase 11.1 — multipart upload real pro R2: sobe o limite de fato pra arquivos
# grandes (200MB+) em partes de tamanho fixo, cada uma com sua própria URL
# pré-assinada — em vez de um único PUT gigante (mais frágil em rede
# instável e sujeito a timeout do lado do storage).
# ---------------------------------------------------------------------------

_MULTIPART_PART_SIZE = 10 * 1024 * 1024  # 10MB — mínimo aceito pelo S3/R2 multipart (exceto a última parte)
# Não há threshold aqui no backend — quem decide se usa /upload-url (PUT único)
# ou /multipart/* é o cliente (mesmo valor em Documents.tsx::MULTIPART_THRESHOLD,
# 20MB). Os dois fluxos continuam válidos independente do tamanho declarado.


class MultipartCreateRequest(BaseModel):
    folder_id: UUID
    company_id: UUID
    name: str
    size_bytes: int
    content_type: str
    original_created_at: datetime | None = None  # ver UploadUrlRequest


@router.post("/multipart/create", status_code=status.HTTP_201_CREATED)
async def create_multipart_upload(
    body: MultipartCreateRequest,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Etapa 1 do upload em partes — mesma validação de /upload-url (tamanho,
    extensão, path traversal, permissão de pasta, conflito de nome), só que
    abre um multipart upload no storage em vez de gerar uma única URL de PUT."""
    if body.size_bytes > settings.MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Arquivo excede o limite de {settings.MAX_FILE_SIZE_BYTES // 1_048_576}MB.",
        )
    if body.size_bytes <= 0:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="size_bytes deve ser positivo.")

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

    folder = await DocumentsService.find_folder_for_upload(conn, body.folder_id, body.company_id)
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    if folder["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para fazer upload nesta pasta.")

    final_name = await DocumentsService.resolve_unique_name(conn, body.folder_id, raw_name)

    document_id = uuid4()
    key = storage_service.storage_key(str(body.company_id), str(document_id), ext)
    user_id = claims["sub"]
    content_type = _MIME_MAP.get(ext, body.content_type)
    original = await _original_date_allowed(conn, claims, body.company_id, body.original_created_at)

    await DocumentsService.insert_pending_document(
        admin_conn,
        document_id=document_id, folder_id=body.folder_id, company_id=body.company_id,
        name=final_name, mime_type=content_type, file_type=ext,
        size_bytes=body.size_bytes, storage_path=key, uploaded_by=user_id, created_at=original,
    )

    upload_id = storage_service.create_multipart_upload(key, content_type)
    total_parts = (body.size_bytes + _MULTIPART_PART_SIZE - 1) // _MULTIPART_PART_SIZE

    return {
        "document_id": str(document_id),
        "upload_id": upload_id,
        "storage_key": key,
        "part_size": _MULTIPART_PART_SIZE,
        "total_parts": total_parts,
        "mock_mode": storage_service.is_mock(),
    }


class PartUrlRequest(BaseModel):
    upload_id: str
    part_number: int


@router.post("/multipart/{document_id}/part-url")
async def get_multipart_part_url(
    document_id: UUID,
    body: PartUrlRequest,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    doc = await DocumentsService.get_document_for_confirm(admin_conn, document_id, claims["sub"])
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para este upload.")
    if doc["content_hash"] is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Upload já confirmado.")

    url = storage_service.generate_part_upload_url(doc["storage_path"], body.upload_id, body.part_number)
    return {"upload_url": url, "part_number": body.part_number}


class PartInfo(BaseModel):
    part_number: int
    etag: str


class MultipartCompleteRequest(BaseModel):
    upload_id: str
    parts: list[PartInfo]


@router.post("/multipart/{document_id}/complete")
async def complete_multipart_upload(
    document_id: UUID,
    body: MultipartCompleteRequest,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    doc = await DocumentsService.get_document_for_confirm(admin_conn, document_id, claims["sub"])
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para confirmar este upload.")
    if doc["content_hash"] is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Upload já confirmado.")

    try:
        storage_service.complete_multipart_upload(
            doc["storage_path"], body.upload_id,
            [{"PartNumber": p.part_number, "ETag": p.etag} for p in body.parts],
        )
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_424_FAILED_DEPENDENCY,
            detail="Não foi possível completar o upload em partes — alguma parte pode estar faltando ou corrompida.",
        )

    return await _finalize_confirmed_upload(admin_conn, doc, document_id, claims["sub"])


class MultipartAbortRequest(BaseModel):
    upload_id: str


@router.post("/multipart/{document_id}/abort", status_code=status.HTTP_204_NO_CONTENT)
async def abort_multipart_upload(
    document_id: UUID,
    body: MultipartAbortRequest,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """Cancela um upload em partes abandonado (ex: usuário fechou a aba no meio) —
    limpa tanto o multipart upload no storage quanto o registro pendente."""
    doc = await DocumentsService.get_document_for_confirm(admin_conn, document_id, claims["sub"])
    if doc is None:
        return  # já não existe — idempotente
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para este upload.")

    try:
        storage_service.abort_multipart_upload(doc["storage_path"], body.upload_id)
    except Exception:
        pass
    await DocumentsService.delete_pending_document(admin_conn, document_id)


# ---------------------------------------------------------------------------
# GET /documents/mock-download/:key — serve arquivo para download (mock only)
# ---------------------------------------------------------------------------

@router.get("/mock-download/{safe_key:path}", include_in_schema=False)
async def mock_download_file(safe_key: str, filename: str = "") -> Response:
    """Serve o arquivo com Content-Disposition: attachment. Apenas em mock mode."""
    if not storage_service.is_mock():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    if not storage_service.is_valid_mock_key(safe_key):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Chave inválida.")
    data = storage_service.mock_read(safe_key)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Arquivo não encontrado no mock storage.")
    ext = safe_key.rsplit(".", 1)[-1].lower() if "." in safe_key else "bin"
    content_type = _MIME_MAP.get(ext, "application/octet-stream")
    safe_fn = filename or safe_key.rsplit("__", 1)[-1]
    escaped_fn = safe_fn.replace("\\", "").replace('"', "")
    disposition = f'attachment; filename="{escaped_fn}"; filename*=UTF-8\'\'{quote(safe_fn)}'
    return Response(content=data, media_type=content_type, headers={"Content-Disposition": disposition})


# ---------------------------------------------------------------------------
# GET /documents/:id/download-url — URL pré-assinada para download unitário
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Texto dos documentos (OCR) por empresa: situação e nova leitura em lote
# ---------------------------------------------------------------------------

class ReprocessTextRequest(BaseModel):
    company_id: UUID


_SEM_TEXTO_SQL = """
    company_id = $1 AND deleted_at IS NULL
    AND (ocr_status = 'failed' OR (ocr_status = 'done' AND coalesce(ocr_text, '') = '' AND ocr_completed_at IS NULL))
"""


async def _require_company_admin(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID) -> None:
    from app.dependencies import get_app_role
    from app.services.companies_service import CompaniesService

    if await get_app_role(conn, claims) == "supremo":
        return
    if not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você não administra esta empresa.")


@router.get("/text-status")
async def text_status(
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Quantos documentos da empresa estão com o texto pronto, na fila, com falha
    ou "prontos sem texto" pelo OCR antigo (até 25/11/2026 o OCR de produção
    devolvia texto vazio para todo PDF; ocr_completed_at nulo marca esses).
    """
    await _require_company_admin(conn, claims, company_id)
    row = await admin_conn.fetchrow(
        f"""
        SELECT
          count(*) FILTER (WHERE ocr_status = 'done' AND coalesce(ocr_text, '') <> '') AS com_texto,
          count(*) FILTER (WHERE ocr_status IN ('pending', 'processing')) AS na_fila,
          count(*) FILTER (WHERE {_SEM_TEXTO_SQL}) AS a_reler
        FROM public.documents
        WHERE company_id = $1 AND deleted_at IS NULL
        """,
        company_id,
    )
    return dict(row)


@router.post("/reprocess-text", status_code=status.HTTP_202_ACCEPTED)
async def reprocess_text(
    body: ReprocessTextRequest,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Põe de novo na fila de leitura de texto os documentos com falha ou sem texto (admin da empresa)."""
    await _require_company_admin(conn, claims, body.company_id)
    async with admin_conn.transaction():
        ids = [r["id"] for r in await admin_conn.fetch(
            f"SELECT id FROM public.documents WHERE {_SEM_TEXTO_SQL} FOR UPDATE", body.company_id,
        )]
        for document_id in ids:
            await DocumentsService.enqueue_ocr(admin_conn, document_id)
    return {"enqueued": len(ids)}


async def _log_access(conn: asyncpg.Connection, user_id: str, document_id: UUID, action: str) -> None:
    """
    Registra na trilha quem abriu ou baixou o documento — antes nada disso
    era gravado e a auditoria não respondia "quem viu este arquivo". A mesma
    pessoa abrindo o mesmo documento várias vezes em 10 minutos conta uma
    vez, para a trilha não virar ruído. Falha aqui nunca impede de abrir.
    """
    try:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)
                SELECT $1::uuid, d.company_id, $3, 'document', d.id, d.name
                FROM public.documents d
                WHERE d.id = $2 AND NOT EXISTS (
                  SELECT 1 FROM public.activity_log a
                  WHERE a.user_id = $1::uuid AND a.item_id = $2 AND a.action = $3
                    AND a.created_at > now() - interval '10 minutes'
                )
                """,
                user_id, document_id, action,
            )
    except asyncpg.PostgresError:
        pass


@router.get("/{document_id}/download-url")
async def get_download_url(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    URL pré-assinada para download com Content-Disposition: attachment.
    Expiração: 1 hora.
    """
    doc = await DocumentsService.get_document_for_download(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    await _log_access(conn, claims["sub"], document_id, "download")

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
    if len(body.document_ids) > _BULK_DOWNLOAD_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Máximo de {_BULK_DOWNLOAD_LIMIT} documentos por lote.",
        )

    rows = await DocumentsService.fetch_documents_for_bulk_download(conn, [str(did) for did in body.document_ids])
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Nenhum documento encontrado ou acessível.")

    def montar_zip() -> str:
        """
        Monta o ZIP em disco fora do laço assíncrono e devolve o caminho
        (achado X3-04): antes o ZIP inteiro era lido para a memória antes de
        enviar e a leitura do storage travava a API. Cada arquivo é escrito e
        liberado; arquivos ausentes no storage são pulados.
        """
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
        try:
            with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
                seen_names: dict[str, int] = {}
                for row in rows:
                    data = storage_service.read_object(row["storage_path"])
                    if data is None:
                        continue
                    base_name = row["name"]
                    if base_name in seen_names:
                        seen_names[base_name] += 1
                        dot = base_name.rfind(".")
                        base_name = (f"{base_name[:dot]} ({seen_names[base_name]}){base_name[dot:]}" if dot != -1
                                     else f"{base_name} ({seen_names[base_name]})")
                    else:
                        seen_names[base_name] = 1
                    zf.writestr(base_name, data)
                    del data
        finally:
            tmp.close()
        return tmp.name

    caminho = await asyncio.to_thread(montar_zip)

    def enviar():
        try:
            with open(caminho, "rb") as fh:
                while True:
                    bloco = fh.read(1024 * 1024)
                    if not bloco:
                        break
                    yield bloco
        finally:
            os.unlink(caminho)

    return StreamingResponse(
        enviar(),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="docke_download.zip"',
            "Content-Length": str(os.path.getsize(caminho)),
        },
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

    # Sob legal hold ou com retenção travada vigente: ficam de fora e voltam na
    # resposta com o motivo (o banco também recusaria — migration 20261125000001).
    blocked = [dict(r) for r in await admin_conn.fetch(
        """
        SELECT id::text, name, public.document_deletion_block_reason(id) AS motivo
        FROM public.documents WHERE id = ANY($1::uuid[])
        """,
        deletable_ids,
    ) if r["motivo"]]
    if blocked:
        blocked_ids = {b["id"] for b in blocked}
        deletable_ids = [i for i in deletable_ids if i not in blocked_ids]
    if not deletable_ids:
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail="Nenhum dos documentos pode ser excluído: estão sob legal hold ou com retenção obrigatória em vigor.",
        )

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
        "blocked": blocked,
    }


class BulkRestoreRequest(BaseModel):
    document_ids: list[UUID]


@router.post("/bulk-restore")
async def bulk_restore(
    body: BulkRestoreRequest,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Tira da lixeira vários documentos de uma vez, cada um para a pasta de onde
    saiu (ou a primeira pasta raiz, se ela também foi excluída). É o "Desfazer"
    da exclusão em lote e do Ctrl+Z (achado A4-61).
    """
    if not body.document_ids or len(body.document_ids) > _BULK_LIMIT:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Informe de 1 a {_BULK_LIMIT} documentos.")
    user_id = claims["sub"]
    restored, failed = [], []
    for document_id in body.document_ids:
        doc = await DocumentsService.get_trashed_document(admin_conn, document_id)
        if doc is None:
            failed.append(str(document_id))
            continue
        original = doc["deleted_original_folder_id"] or doc["folder_id"]
        target = await DocumentsService.find_folder_by_id(admin_conn, original) or await DocumentsService.find_root_folder(
            admin_conn, doc["company_id"]
        )
        if target is None:
            failed.append(str(document_id))
            continue
        permission = await DocumentsService.check_permission_for_path(admin_conn, user_id, str(target["path"]), target["company_id"])
        if permission not in ("admin", "operador"):
            failed.append(str(document_id))
            continue
        row = await DocumentsService.restore_single(admin_conn, document_id, target["id"])
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)
            VALUES ($1::uuid, $2::uuid, 'restore', 'document', $3::uuid, $4)
            """,
            user_id, row["company_id"], row["id"], row["name"],
        )
        restored.append(row["id"])
    return {"restored": len(restored), "document_ids": restored, "failed": failed}


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
    if not storage_service.is_valid_mock_key(safe_key):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Chave inválida.")
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
    claims: dict[str, Any] = Depends(get_current_user),
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

    ext = doc["name"].rsplit(".", 1)[-1].lower() if "." in doc["name"] else ""
    preview_key = doc["storage_path"]
    preview_mime = doc["mime_type"]

    # Fase 12.1: DOCX/XLSX/DOC/XLS não têm preview nativo no navegador — serve
    # um PDF derivado (gerado uma vez via LibreOffice headless, cacheado no
    # storage sob derivatives/{...}.pdf; reaproveitado em previews seguintes).
    if ext in ("docx", "doc", "xlsx", "xls"):
        derivative_key = storage_service.derivative_pdf_key(doc["storage_path"])
        if await asyncio.to_thread(storage_service.head_object, derivative_key) is None:
            pdf_bytes = await asyncio.to_thread(storage_service.convert_office_to_pdf, doc["storage_path"], ext)
            if pdf_bytes is None:
                return {
                    "inline": False,
                    "preview_url": None,
                    "expires_at": None,
                    "size_bytes": doc["size_bytes"],
                    "message": "Não foi possível gerar a pré-visualização deste arquivo. Use o download.",
                }
            await asyncio.to_thread(storage_service.put_object_bytes, derivative_key, pdf_bytes, "application/pdf")
        preview_key = derivative_key
        preview_mime = "application/pdf"
    elif preview_mime == "application/pdf":
        # PDF escaneado que passou pelo OCR: a prévia usa a versão com a camada
        # de texto (dá para selecionar e copiar o texto, como no Quick Look).
        ocr_key = storage_service.ocr_pdf_key(doc["storage_path"])
        if await asyncio.to_thread(storage_service.head_object, ocr_key) is not None:
            preview_key = ocr_key

    preview_url, expires_at = storage_service.generate_preview_url(
        key=preview_key,
        content_type=preview_mime,
    )
    await _log_access(conn, claims["sub"], document_id, "view")
    return {
        "inline": True,
        "preview_url": preview_url,
        "expires_at": expires_at.isoformat(),
        "size_bytes": doc["size_bytes"],
        "mime_type": preview_mime,
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

@router.get("/ocr-status")
async def get_documents_ocr_status(
    document_ids: str = Query(..., description="IDs separados por vírgula"),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Status de OCR de um lote de documentos — usado pelo Task Center pra
    acompanhar upload → extração → indexação sem recarregar a pasta inteira."""
    ids = [UUID(x) for x in document_ids.split(",") if x.strip()]
    if not ids:
        return []
    rows = await DocumentsService.get_ocr_status_batch(conn, ids)
    return [dict(r) for r in rows]


@router.get("/recent")
async def list_recent_documents(
    company_id: UUID = Query(...),
    limit: int = Query(10, ge=1, le=50),
    mine: bool = Query(False, description="Os que eu abri por último, em vez dos últimos enviados."),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    rows = await DocumentsService.list_recent(conn, company_id, limit, opened_by=claims["sub"] if mine else None)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /documents — lista documentos de uma pasta (RLS filtra automaticamente)
# ---------------------------------------------------------------------------

@router.get("")
async def list_documents(
    response: Response,
    folder_id: UUID = Query(...),
    company_id: UUID = Query(...),
    limit: int | None = Query(None, ge=1, le=500),
    offset: int = Query(0, ge=0),
    sort: str = Query("name"),
    dir: str = Query("asc"),
    q: str | None = Query(None, max_length=200),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Documentos da pasta; com limit, paginados (total no cabeçalho X-Total-Count)."""
    rows, total = await DocumentsService.list_by_folder(
        conn, folder_id, company_id, limit=limit, offset=offset, sort=sort, direction=dir, q=(q or "").strip() or None,
    )
    response.headers["X-Total-Count"] = str(total)
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

    old = await DocumentsService.get_document_detail(conn, document_id)
    if old is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if body.name is not None:
        from app.services.names import clean_name

        body.name = clean_name(body.name, kind="documento")
        if body.name != old["name"] and await DocumentsService.name_taken_in_folder(conn, document_id, body.name):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f'Já existe um documento "{body.name}" nesta pasta.')

    row = await DocumentsService.patch_metadata(
        conn, document_id,
        name=body.name, sector=body.sector, competencia=body.competencia, tipo_fiscal=body.tipo_fiscal,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if body.name is not None and body.name != old["name"]:
        # Trilha completa (achado X2-13): renomear também gera evento.
        import json as _json
        await conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
            VALUES (auth.uid(), $1::uuid, 'rename', 'document', $2::uuid, $3, $4::jsonb)
            """,
            row["company_id"], str(document_id), row["name"],
            _json.dumps({"de": old["name"], "para": row["name"]}, ensure_ascii=False),
        )
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

    from app.services.retention_service import RetentionService
    if await RetentionService.document_is_under_hold(conn, document_id):
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Documento bloqueado para exclusão — está sob retenção legal (legal hold).")

    await DocumentsService.soft_delete_single(admin_conn, document_id)
    # A exclusão de um documento só também entra na trilha (antes só a em lote).
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)
        SELECT $1::uuid, company_id, 'delete', 'document', id, name FROM public.documents WHERE id = $2
        """,
        user_id, document_id,
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
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)
        VALUES ($1::uuid, $2::uuid, 'restore', 'document', $3::uuid, $4)
        """,
        user_id, str(row["company_id"]), str(row["id"]), row["name"],
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
    doc = await DocumentsService.get_document_for_ocr_retry(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if doc["permission"] not in ("admin", "operador"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para reprocessar o OCR deste documento.")
    if doc["ocr_status"] == "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe um job de OCR pendente para este documento.")
    if doc["ocr_status"] == "processing":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="OCR em processamento. Aguarde a conclusão.")

    await DocumentsService.retry_ocr_transaction(admin_conn, document_id)

    return {"document_id": str(document_id), "name": doc["name"], "ocr_status": "pending", "message": "Job de OCR criado com sucesso."}

