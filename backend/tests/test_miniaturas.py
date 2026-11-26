"""Miniaturas da grade (A4-20): geração, estado e URL na listagem."""
import io
import uuid

import pytest

from app.services import storage_service, thumbnail_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


def _png(w=800, h=600) -> bytes:
    from PIL import Image

    out = io.BytesIO()
    Image.new("RGB", (w, h), (12, 140, 120)).save(out, "PNG")
    return out.getvalue()


def _pdf() -> bytes:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    pdf.new_page(595, 842)
    out = io.BytesIO()
    pdf.save(out)
    pdf.close()
    return out.getvalue()


def test_render_png_e_pdf_viram_webp_pequeno():
    from PIL import Image

    for data, mime in ((_png(), "image/png"), (_pdf(), "application/pdf")):
        webp = thumbnail_service.render_thumbnail(data, mime)
        assert webp is not None, mime
        img = Image.open(io.BytesIO(webp))
        assert img.format == "WEBP" and img.width <= 240 and img.height <= 360, mime
    assert thumbnail_service.render_thumbnail(b"nao e imagem", "image/png") is None
    assert thumbnail_service.render_thumbnail(b"x", "text/plain") is None


async def _doc(admin, e, nome, mime, conteudo):
    doc = str(uuid.uuid4())
    chave = f"companies/{e['co']}/documents/{doc}.bin"
    if conteudo is not None:
        storage_service.mock_save(chave, conteudo)
    await admin.execute(
        """
        INSERT INTO public.documents (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                                      storage_path, content_hash, ocr_status, uploaded_by)
        VALUES ($1, $2, $3, $4, $5, 'x', 10, $6, $7, 'done', $8)
        """,
        doc, e["co"], e["sub"], nome, mime, chave, uuid.uuid4().hex * 2, e["user"],
    )
    return doc, chave


@pytest.mark.asyncio
async def test_worker_gera_marca_e_listagem_devolve_url(api, admin, empresa):  # noqa: F811
    com, chave_com = await _doc(admin, empresa, "Foto.png", "image/png", _png())
    sem, chave_sem = await _doc(admin, empresa, "Planilha.csv", "text/csv", b"a;b")
    try:
        # Roda até a fila desta empresa acabar (pode haver documentos de outros testes).
        for _ in range(20):
            await thumbnail_service.generate_pending(admin, limit=50)
            n = await admin.fetchval(
                "SELECT count(*) FROM public.document_thumbnails WHERE storage_path = ANY($1::text[])",
                [chave_com, chave_sem],
            )
            if n == 2:
                break
        estado = dict(await admin.fetch(
            "SELECT storage_path, ok FROM public.document_thumbnails WHERE storage_path = ANY($1::text[])",
            [chave_com, chave_sem],
        ))
        assert estado == {chave_com: True, chave_sem: False}
        assert storage_service.mock_read(storage_service.thumb_key(chave_com)) is not None

        h = _token(empresa["user"])
        r = await api.get(API + "/documents", params={"folder_id": empresa["sub"], "company_id": empresa["co"]}, headers=h)
        assert r.status_code == 200, r.text
        por_id = {d["id"]: d for d in r.json()}
        assert por_id[com]["thumb_url"] and por_id[sem]["thumb_url"] is None
        assert "has_thumb" not in por_id[com]
    finally:
        await admin.execute(
            "DELETE FROM public.document_thumbnails WHERE storage_path = ANY($1::text[])", [chave_com, chave_sem],
        )
