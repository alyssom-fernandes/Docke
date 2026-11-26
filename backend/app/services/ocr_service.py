"""
Extração de texto dos documentos (o "OCR" do Docke), para a busca por
conteúdo, a busca dentro da prévia e a comparação de versões.

Por formato:
- PDF: camada de texto de cada página (PDFium). Página sem texto (escaneada)
  é rasterizada a 300 dpi e passa pelo Tesseract. Quando alguma página passou
  pelo OCR, sai também um PDF pesquisável (imagem + texto invisível), guardado
  como derivado para a prévia ter texto selecionável.
- Imagem (JPG, PNG, GIF): binarização e correção de inclinação (OpenCV) e
  Tesseract.
- XML (NF-e e afins), DOCX, XLSX, CSV e TXT: leitura direta do conteúdo.
- DOC e XLS: o PDF derivado do LibreOffice (o mesmo da prévia) e, dele, o texto.

Até 25/11/2026 o provedor de produção abria o PDF com o Pillow (que não lê PDF)
e devolvia texto vazio para todo PDF, XML, DOCX, XLSX, CSV e TXT, marcando o
documento como pronto (achado X3-01). Agora um formato sem extração conhecida
levanta UnsupportedFormat, e um erro de leitura levanta exceção: o worker
tenta de novo e, na última tentativa, marca a falha.
"""
from __future__ import annotations

import asyncio
import io
import re
import zipfile
from dataclasses import dataclass
from xml.etree import ElementTree  # noqa: F401 — ParseError usado por quem chama

from app.services.file_signature import safe_xml_fromstring

# Teto do texto guardado: o tsvector do Postgres aceita até 1 MB.
MAX_TEXT_CHARS = 500_000
# PDF escaneado muito longo: as páginas além deste número ficam sem OCR (a
# camada de texto nativa, se houver, ainda é lida em todas).
MAX_OCR_PAGES = 100
_OCR_SCALE = 300 / 72  # 300 dpi
_MIN_CHARS_NATIVE_PAGE = 16  # menos que isso numa página: tratada como escaneada

_TEXT_MIMES = {"text/plain", "text/csv", "application/csv"}
_XML_MIMES = {"application/xml", "text/xml"}
_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_LEGACY_OFFICE = {"application/msword": "doc", "application/vnd.ms-excel": "xls"}
_IMAGE_MIMES = {"image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/tiff", "image/bmp"}


class UnsupportedFormat(Exception):
    """O formato não tem extração de texto (o worker grava a falha sem repetir)."""


@dataclass
class Extraction:
    text: str
    # PDF com camada de texto do OCR (só quando alguma página foi rasterizada).
    searchable_pdf: bytes | None = None
    ocr_pages: int = 0


def clean_text(raw: str) -> str:
    """Tira caracteres de controle e espaços repetidos; mantém as quebras de linha."""
    raw = raw.replace("\r\n", "\n").replace("\r", "\n")
    raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", " ", raw)
    lines = [re.sub(r"[ \t ]+", " ", line).strip() for line in raw.split("\n")]
    text = "\n".join(line for line in lines if line)
    return text[:MAX_TEXT_CHARS]


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1", errors="replace")


def _xml_text(data: bytes) -> str:
    """Todo o texto dos elementos (valores da NF-e: CNPJ, nomes, produtos, chaves)."""
    root = safe_xml_fromstring(data)
    parts = [t.strip() for t in root.itertext() if t and t.strip()]
    return "\n".join(parts)


def _docx_text(data: bytes) -> str:
    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = ["word/document.xml"] + sorted(
            n for n in z.namelist() if re.match(r"word/(header|footer|footnotes|endnotes)\d*\.xml$", n)
        )
        paragraphs: list[str] = []
        for name in names:
            if name not in z.namelist():
                continue
            root = safe_xml_fromstring(z.read(name))
            for p in root.iter(f"{ns}p"):
                texto = "".join(t.text or "" for t in p.iter(f"{ns}t"))
                if texto.strip():
                    paragraphs.append(texto)
    return "\n".join(paragraphs)


def _xlsx_text(data: bytes) -> str:
    from openpyxl import load_workbook

    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    linhas: list[str] = []
    try:
        for ws in wb.worksheets:
            linhas.append(ws.title)
            for row in ws.iter_rows(values_only=True):
                valores = [str(v) for v in row if v is not None and str(v).strip()]
                if valores:
                    linhas.append(" ".join(valores))
                if sum(len(x) for x in linhas) > MAX_TEXT_CHARS:
                    return "\n".join(linhas)
    finally:
        wb.close()
    return "\n".join(linhas)


class OCRProvider:
    """Tesseract disponível: OCR de imagem e de página escaneada. Sem ele, só texto nativo."""

    def __init__(self, tesseract: bool) -> None:
        self.tesseract = tesseract
        if tesseract:
            import pytesseract

            self._pyt = pytesseract

    async def extract(self, file_bytes: bytes, mime_type: str, *, max_ocr_pages: int = MAX_OCR_PAGES) -> Extraction:
        return await asyncio.get_running_loop().run_in_executor(
            None, self.extract_sync, file_bytes, mime_type, max_ocr_pages
        )

    # -- síncrono (roda numa thread) ---------------------------------------

    def extract_sync(self, file_bytes: bytes, mime_type: str, max_ocr_pages: int = MAX_OCR_PAGES) -> Extraction:
        mime = (mime_type or "").split(";")[0].strip().lower()
        if mime == "application/pdf":
            return self._pdf(file_bytes, max_ocr_pages)
        if mime in _XML_MIMES:
            return Extraction(clean_text(_xml_text(file_bytes)))
        if mime == _DOCX:
            return Extraction(clean_text(_docx_text(file_bytes)))
        if mime == _XLSX:
            return Extraction(clean_text(_xlsx_text(file_bytes)))
        if mime in _TEXT_MIMES or mime.startswith("text/"):
            return Extraction(clean_text(_decode(file_bytes)))
        if mime in _IMAGE_MIMES:
            if not self.tesseract:
                raise UnsupportedFormat("OCR de imagem indisponível neste servidor (Tesseract ausente).")
            return Extraction(clean_text(self._image(file_bytes)), ocr_pages=1)
        raise UnsupportedFormat(f"Formato sem extração de texto: {mime or 'desconhecido'}.")

    def _ocr_pil(self, img) -> str:
        return self._pyt.image_to_string(img, lang="por+eng")

    def _image(self, file_bytes: bytes) -> str:
        import cv2
        import numpy as np
        from PIL import Image

        nparr = np.frombuffer(file_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            # GIF e outros que o OpenCV não abre: o Pillow abre e o Tesseract lê direto.
            pil = Image.open(io.BytesIO(file_bytes)).convert("RGB")
            return self._ocr_pil(pil)
        return self._ocr_pil(Image.fromarray(self._preprocess(img)))

    @staticmethod
    def _preprocess(img):
        """Binarização Otsu e correção de inclinação (deskew)."""
        import cv2
        import numpy as np

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        coords = np.column_stack(np.where(binary < 128))
        if coords.shape[0] > 0:
            angle = cv2.minAreaRect(coords)[-1]
            if angle < -45:
                angle = 90 + angle
            elif angle > 45:
                angle = angle - 90
            if 0.5 < abs(angle) < 15:
                (h, w) = binary.shape[:2]
                m = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
                binary = cv2.warpAffine(binary, m, (w, h), flags=cv2.INTER_CUBIC, borderValue=255)
        return binary

    def _pdf(self, data: bytes, max_ocr_pages: int) -> Extraction:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(data)
        try:
            textos: list[str] = []
            ocr_pdf_pages: dict[int, bytes] = {}
            for i in range(len(pdf)):
                page = pdf[i]
                textpage = page.get_textpage()
                nativo = textpage.get_text_bounded() or ""
                textpage.close()
                if len(nativo.strip()) >= _MIN_CHARS_NATIVE_PAGE or not self.tesseract or len(ocr_pdf_pages) >= max_ocr_pages:
                    textos.append(nativo)
                    page.close()
                    continue
                # Página escaneada: rasteriza e lê com o Tesseract; guarda a
                # página em PDF (imagem + texto invisível) para o derivado.
                pil = page.render(scale=_OCR_SCALE, grayscale=True).to_pil()
                page.close()
                textos.append(self._ocr_pil(pil))
                ocr_pdf_pages[i] = self._pyt.image_to_pdf_or_hocr(pil, lang="por+eng", extension="pdf")
                del pil
            texto = clean_text("\n\n".join(textos))
            searchable = self._merge_searchable(pdf, ocr_pdf_pages) if ocr_pdf_pages else None
            return Extraction(texto, searchable_pdf=searchable, ocr_pages=len(ocr_pdf_pages))
        finally:
            pdf.close()

    @staticmethod
    def _merge_searchable(original, ocr_pages: dict[int, bytes]) -> bytes | None:
        """PDF novo: páginas com texto nativo vêm do original; as escaneadas, do Tesseract."""
        import pypdfium2 as pdfium

        out = pdfium.PdfDocument.new()
        abertos = []
        try:
            for i in range(len(original)):
                if i in ocr_pages:
                    src = pdfium.PdfDocument(ocr_pages[i])
                    abertos.append(src)
                    out.import_pages(src, [0])
                else:
                    out.import_pages(original, [i])
            buf = io.BytesIO()
            out.save(buf)
            return buf.getvalue()
        except Exception:
            return None
        finally:
            for src in abertos:
                src.close()
            out.close()


def legacy_office_extension(mime_type: str) -> str | None:
    """DOC e XLS passam antes pelo LibreOffice (PDF derivado)."""
    return _LEGACY_OFFICE.get((mime_type or "").split(";")[0].strip().lower())


def get_provider() -> OCRProvider:
    """Com o binário do Tesseract instalado (imagem Docker de produção), OCR completo."""
    try:
        import pytesseract

        pytesseract.get_tesseract_version()
        return OCRProvider(tesseract=True)
    except Exception:
        return OCRProvider(tesseract=False)
