"""
Miniaturas da grade (A4-20) e derivado PDF de Office gerado no envio (A5-42).

- PDF: primeira página renderizada pelo pypdfium2.
- Imagem: reduzida pelo Pillow (respeitando a orientação EXIF).
- DOCX/XLSX/DOC/XLS: convertidos para PDF pelo LibreOffice uma vez, guardados
  em derivatives/{chave}.pdf (a prévia passa a abrir na hora) e a miniatura sai
  da primeira página desse PDF.

O resultado é WEBP de até 240 x 360 px. Quem chama grava o estado em
public.document_thumbnails (ok = false quando não há miniatura possível, para
não tentar de novo a cada ciclo).
"""
from __future__ import annotations

import asyncio
import io
import logging

import asyncpg

from app.services import storage_service

logger = logging.getLogger("docke.miniaturas")

LARGURA = 240
ALTURA = 360
_IMAGENS = {"image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/tiff", "image/bmp"}
_OFFICE = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/msword": "doc",
    "application/vnd.ms-excel": "xls",
}
_LIMITE_BYTES = 60 * 1024 * 1024


def _mime(m: str | None) -> str:
    return (m or "").split(";")[0].strip().lower()


def suporta(mime_type: str | None) -> bool:
    m = _mime(mime_type)
    return m == "application/pdf" or m in _IMAGENS or m in _OFFICE


def render_thumbnail(data: bytes, mime_type: str) -> bytes | None:
    """Bytes do arquivo → WEBP da miniatura, ou None se não der."""
    from PIL import Image, ImageOps

    m = _mime(mime_type)
    try:
        if m == "application/pdf":
            import pypdfium2 as pdfium

            pdf = pdfium.PdfDocument(data)
            try:
                if len(pdf) == 0:
                    return None
                page = pdf[0]
                largura, _ = page.get_size()
                escala = min(2.0, LARGURA / largura) if largura else 1.0
                img = page.render(scale=escala).to_pil()
                page.close()
            finally:
                pdf.close()
        elif m in _IMAGENS:
            img = Image.open(io.BytesIO(data))
            img.seek(0)
            img = ImageOps.exif_transpose(img)
        else:
            return None
        if img.mode not in ("RGB", "L"):
            fundo = Image.new("RGB", img.size, (255, 255, 255))
            rgba = img.convert("RGBA")
            fundo.paste(rgba, mask=rgba.split()[-1])
            img = fundo
        img = img.convert("RGB")
        img.thumbnail((LARGURA, ALTURA))
        out = io.BytesIO()
        img.save(out, "WEBP", quality=72, method=4)
        return out.getvalue()
    except Exception as exc:  # arquivo corrompido, formato raro: fica sem miniatura
        logger.info("Miniatura não gerada (%s): %s", m, exc)
        return None


def _gerar(storage_path: str, mime_type: str) -> bytes | None:
    """Lê o objeto (ou o PDF derivado do Office) e devolve a miniatura."""
    m = _mime(mime_type)
    if m in _OFFICE:
        chave = storage_service.derivative_pdf_key(storage_path)
        pdf = storage_service.read_object(chave)
        if pdf is None:
            pdf = storage_service.convert_office_to_pdf(storage_path, _OFFICE[m])
            if pdf is None:
                return None
            storage_service.put_object_bytes(chave, pdf, "application/pdf")
        return render_thumbnail(pdf, "application/pdf")
    data = storage_service.read_object(storage_path)
    if data is None or len(data) > _LIMITE_BYTES:
        return None
    return render_thumbnail(data, m)


async def generate_pending(conn: asyncpg.Connection, limit: int = 8) -> int:
    """Gera as miniaturas que faltam (documentos novos primeiro). Devolve quantas tentou."""
    rows = await conn.fetch(
        """
        SELECT d.storage_path, d.mime_type, d.company_id
        FROM public.documents d
        LEFT JOIN public.document_thumbnails t ON t.storage_path = d.storage_path
        WHERE t.storage_path IS NULL AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
          AND d.storage_path IS NOT NULL AND d.storage_path <> ''
        ORDER BY d.created_at DESC
        LIMIT $1
        """,
        limit * 4,
    )
    if not rows:
        # Sem fila: limpa o estado de arquivos que não existem mais (versões
        # trocadas, reset da demo, exclusão definitiva).
        await conn.execute(
            """
            DELETE FROM public.document_thumbnails t
            WHERE NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.storage_path = t.storage_path)
            """
        )
        return 0
    feitos = 0
    for r in rows:
        if feitos >= limit:
            break
        if not suporta(r["mime_type"]):
            ok = False
        else:
            feitos += 1
            webp = await asyncio.to_thread(_gerar, r["storage_path"], r["mime_type"])
            ok = webp is not None
            if ok:
                await asyncio.to_thread(
                    storage_service.put_object_bytes, storage_service.thumb_key(r["storage_path"]), webp, "image/webp",
                )
        await conn.execute(
            """
            INSERT INTO public.document_thumbnails (storage_path, company_id, ok)
            VALUES ($1, $2, $3)
            ON CONFLICT (storage_path) DO UPDATE SET ok = EXCLUDED.ok, created_at = now()
            """,
            r["storage_path"], r["company_id"], ok,
        )
    return feitos


def thumb_url(storage_path: str) -> str:
    url, _ = storage_service.generate_preview_url(storage_service.thumb_key(storage_path), "image/webp", expires_in=3600)
    return url
