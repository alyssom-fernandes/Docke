"""OCR de PDF escaneado retoma da última página pronta depois de uma interrupção."""
import io

import pypdfium2 as pdfium
import pytest

from app.services.ocr_service import OCRProvider
from app.workers.ocr_worker import StorageCheckpoint


def _pdf_em_branco(paginas: int) -> bytes:
    doc = pdfium.PdfDocument.new()
    for _ in range(paginas):
        doc.new_page(595, 842)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


class _CheckpointMemoria:
    def __init__(self, prontas=None):
        self.prontas = dict(prontas or {})
        self.gravadas: list[int] = []

    def load(self):
        return dict(self.prontas)

    def save_page(self, i, texto, pdf):
        self.prontas[i] = (texto, pdf)
        self.gravadas.append(i)


def _provedor_falso(lidas: list[int], quebra_na: int | None = None):
    p = OCRProvider(tesseract=False)
    p.tesseract = True
    contador = iter(range(1000))

    def ocr(_img):
        i = next(contador)
        if quebra_na is not None and len(lidas) == quebra_na:
            raise RuntimeError("processo reiniciado")
        lidas.append(i)
        return f"texto da leitura {i}"

    p._ocr_pil = ocr
    pagina_pdf = _pdf_em_branco(1)

    class _Pyt:
        @staticmethod
        def image_to_pdf_or_hocr(_img, lang, extension):
            return pagina_pdf

    p._pyt = _Pyt
    return p


def test_interrompido_no_meio_continua_de_onde_parou():
    pdf = _pdf_em_branco(5)
    ck = _CheckpointMemoria()

    lidas: list[int] = []
    with pytest.raises(RuntimeError):
        _provedor_falso(lidas, quebra_na=3).extract_sync(pdf, "application/pdf", checkpoint=ck)
    assert ck.gravadas == [0, 1, 2]

    lidas2: list[int] = []
    resultado = _provedor_falso(lidas2).extract_sync(pdf, "application/pdf", checkpoint=ck)
    # Só as páginas 3 e 4 passam de novo pelo Tesseract.
    assert len(lidas2) == 2
    assert resultado.ocr_pages == 5
    assert resultado.searchable_pdf
    assert "texto da leitura 0" in resultado.text and "texto da leitura 1" in resultado.text


def test_sem_ponto_de_retomada_le_tudo():
    lidas: list[int] = []
    resultado = _provedor_falso(lidas).extract_sync(_pdf_em_branco(3), "application/pdf")
    assert len(lidas) == 3
    assert resultado.ocr_pages == 3


def test_checkpoint_no_storage_so_conta_pagina_com_pdf_e_texto(monkeypatch):
    guardado: dict[str, bytes] = {}
    from app.services import storage_service

    monkeypatch.setattr(storage_service, "put_object_bytes", lambda k, d, _ct: guardado.__setitem__(k, d))
    monkeypatch.setattr(storage_service, "read_object", lambda k: guardado.get(k))
    monkeypatch.setattr(storage_service, "delete_object", lambda k: guardado.pop(k, None))
    monkeypatch.setattr(
        storage_service, "list_objects", lambda prefixo: [(k, None) for k in list(guardado) if k.startswith(prefixo)]
    )

    ck = StorageCheckpoint("documents/emp/doc.pdf")
    ck.save_page(0, "página zero", b"%PDF-0")
    ck.save_page(2, "página dois", b"%PDF-2")
    # Página 1 ficou pela metade (só o PDF): não conta como pronta.
    storage_service.put_object_bytes(f"{ck.prefix}1.pdf", b"%PDF-1", "application/pdf")
    assert ck.prefix == "derivatives/documents/emp/doc.pdf.ocr-parcial/"
    assert ck.load() == {0: ("página zero", b"%PDF-0"), 2: ("página dois", b"%PDF-2")}

    ck.clear()
    assert guardado == {}
