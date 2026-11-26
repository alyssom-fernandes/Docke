"""
Organizar páginas de um PDF (benchmark B2.4.5): girar, reordenar, remover e
extrair páginas. O original nunca é alterado: "versão" grava uma versão nova
do mesmo documento (a anterior fica no histórico, com a impressão digital) e
"extrair" cria um documento novo na mesma pasta com as páginas escolhidas.
Feito no servidor com o pdfium (o mesmo do OCR).
"""
import asyncio
import hashlib
import io
from typing import Any, Literal
from uuid import UUID, uuid4

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.dependencies import get_current_user, get_db, get_db_admin
from app.routers.versions import _MAX_VERSIONS, _check_write_access
from app.services import storage_service
from app.services.documents_service import DocumentsService
from app.services.versions_service import VersionsService

router = APIRouter(tags=["pages"])
MAX_PAGINAS = 2000


class Pagina(BaseModel):
    indice: int = Field(..., ge=0, description="Posição da página no PDF atual, a partir de 0.")
    rotacao: Literal[0, 90, 180, 270] = 0


class Organizar(BaseModel):
    paginas: list[Pagina] = Field(..., min_length=1, max_length=MAX_PAGINAS)
    modo: Literal["versao", "extrair"] = "versao"
    nome: str | None = Field(None, max_length=200)


def montar_pdf(data: bytes, paginas: list[Pagina]) -> tuple[bytes, int]:
    """Monta o PDF novo na ordem pedida, somando a rotação de cada página. Devolve (bytes, páginas do original)."""
    import pypdfium2 as pdfium

    src = pdfium.PdfDocument(data)
    try:
        total = len(src)
        fora = [p.indice + 1 for p in paginas if p.indice >= total]
        if fora:
            raise ValueError(f"O documento tem {total} página{'s' if total != 1 else ''}; não existe a página {fora[0]}.")
        out = pdfium.PdfDocument.new()
        try:
            for p in paginas:
                out.import_pages(src, [p.indice])
                if p.rotacao:
                    pg = out[len(out) - 1]
                    pg.set_rotation((pg.get_rotation() + p.rotacao) % 360)
            buf = io.BytesIO()
            out.save(buf)
            return buf.getvalue(), total
        finally:
            out.close()
    finally:
        src.close()


def _resumo(paginas: list[Pagina], total: int) -> str:
    ordem = [p.indice for p in paginas]
    partes = []
    removidas = total - len(set(ordem))
    if removidas > 0:
        partes.append(f"{removidas} removida{'s' if removidas > 1 else ''}")
    if ordem != sorted(ordem):
        partes.append("ordem nova")
    giradas = sum(1 for p in paginas if p.rotacao)
    if giradas:
        partes.append(f"{giradas} girada{'s' if giradas > 1 else ''}")
    return ", ".join(partes) or "sem mudanças"


@router.post("/documents/{document_id}/pages")
async def organizar_paginas(
    document_id: UUID,
    body: Organizar,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _check_write_access(conn, document_id)  # escrita na pasta e reserva para edição
    doc = await admin_conn.fetchrow(
        "SELECT name, storage_path, company_id::text, folder_id FROM public.documents WHERE id = $1 AND deleted_at IS NULL", document_id,
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    if not doc["name"].lower().endswith(".pdf"):
        raise HTTPException(status_code=422, detail="Organizar páginas vale só para PDF.")
    data = await asyncio.to_thread(storage_service.read_object, doc["storage_path"])
    if not data:
        raise HTTPException(status_code=status.HTTP_424_FAILED_DEPENDENCY, detail="Não foi possível ler o arquivo guardado. Tente de novo.")
    try:
        novo, total = await asyncio.to_thread(montar_pdf, data, body.paginas)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception:
        raise HTTPException(status_code=422, detail="Este PDF não pôde ser reorganizado (arquivo protegido ou danificado).")
    sha = hashlib.sha256(novo).hexdigest()
    uid = claims["sub"]
    resumo = _resumo(body.paginas, total)

    if body.modo == "versao":
        if await VersionsService.count_versions(admin_conn, document_id) >= _MAX_VERSIONS:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"Este documento atingiu o limite de {_MAX_VERSIONS} versões.")
        numero = await VersionsService.next_version_number(admin_conn, document_id)
        chave = storage_service.storage_key(doc["company_id"], f"{document_id}-v{numero}", "pdf")
        await asyncio.to_thread(storage_service.put_object_bytes, chave, novo, "application/pdf")
        versao = uuid4()
        async with admin_conn.transaction():
            await VersionsService.insert_version(
                admin_conn, version_id=versao, document_id=document_id, version_number=numero, storage_key=chave,
                size_bytes=len(novo), mime_type="application/pdf", uploaded_by=uid, sha256=sha,
            )
            await VersionsService.activate_version(
                admin_conn, document_id=document_id, version_id=versao, storage_key=chave, mime_type="application/pdf", size_bytes=len(novo),
            )
            await DocumentsService.enqueue_ocr(admin_conn, document_id)
            await VersionsService.log_version_upload(admin_conn, document_id=document_id, user_id=uid)
            await admin_conn.execute(
                """
                INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
                VALUES ($1::uuid, $2::uuid, 'pages_organized', 'document', $3, $4, jsonb_build_object('versao', $5::int, 'resumo', $6::text, 'paginas', $7::int))
                """,
                uid, doc["company_id"], document_id, doc["name"], numero, resumo, len(body.paginas),
            )
        return {"modo": "versao", "document_id": str(document_id), "version_number": numero, "paginas": len(body.paginas), "resumo": resumo}

    # Extrair: documento novo na mesma pasta. A escrita nela já foi conferida acima
    # (_check_write_access); grava pela conexão interna para o OCR enxergar o documento.
    base = doc["name"][:-4]
    nome = (body.nome or "").strip() or f"{base} (páginas extraídas).pdf"
    if not nome.lower().endswith(".pdf"):
        nome += ".pdf"
    nome = await DocumentsService.resolve_unique_name(conn, doc["folder_id"], nome)
    novo_id = uuid4()
    chave = storage_service.storage_key(doc["company_id"], str(novo_id), "pdf")
    await asyncio.to_thread(storage_service.put_object_bytes, chave, novo, "application/pdf")
    await admin_conn.execute(
        """
        INSERT INTO public.documents (id, folder_id, company_id, name, mime_type, file_type, size_bytes, storage_path, content_hash, copied_from, uploaded_by)
        VALUES ($1, $2, $3::uuid, $4, 'application/pdf', 'pdf', $5, $6, $7, $8, $9::uuid)
        """,
        novo_id, doc["folder_id"], doc["company_id"], nome, len(novo), chave, sha, document_id, uid,
    )
    await DocumentsService.enqueue_ocr(admin_conn, novo_id)
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
        VALUES ($1::uuid, $2::uuid, 'pages_extracted', 'document', $3, $4, jsonb_build_object('origem', $5::text, 'paginas', $6::int))
        """,
        uid, doc["company_id"], novo_id, nome, doc["name"], len(body.paginas),
    )
    return {"modo": "extrair", "document_id": str(novo_id), "name": nome, "paginas": len(body.paginas)}
