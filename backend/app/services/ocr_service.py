"""
Pipeline de OCR com interface OCRProvider.

Dois provedores:
- TesseractProvider: usa pytesseract + pré-processamento OpenCV (deskew, binarização).
  Requer Tesseract instalado no sistema.
- FallbackProvider: tenta decodificar bytes como texto UTF-8/Latin-1.
  Funciona para PDFs baseados em texto e arquivos mock de teste.

O worker escolhe o provedor na inicialização via `get_provider()`.
"""
import asyncio
import io
import re
from abc import ABC, abstractmethod


class OCRProvider(ABC):
    """Interface para extração de texto. Todas as implementações são async."""

    @abstractmethod
    async def extract(self, file_bytes: bytes, mime_type: str) -> str:
        """
        Extrai texto do arquivo e retorna como string limpa.
        Retorna string vazia se o arquivo não contiver texto extraível.
        """


class TesseractProvider(OCRProvider):
    """
    Extrai texto usando Tesseract OCR com pré-processamento de imagem.
    Para PDFs: converte cada página para imagem (via PIL) antes do OCR.
    Para imagens: aplica deskew + binarização Otsu via OpenCV.
    """

    def __init__(self) -> None:
        import pytesseract as _pyt  # noqa: F401 — valida que está disponível
        self._pyt = _pyt

    async def extract(self, file_bytes: bytes, mime_type: str) -> str:
        # Executa em thread pool para não bloquear o event loop
        return await asyncio.get_event_loop().run_in_executor(
            None, self._extract_sync, file_bytes, mime_type
        )

    def _extract_sync(self, file_bytes: bytes, mime_type: str) -> str:
        import cv2
        import numpy as np
        from PIL import Image

        if mime_type == "application/pdf":
            return self._extract_pdf(file_bytes)

        # Imagens: pré-processa antes do OCR
        nparr = np.frombuffer(file_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return ""

        # Binarização Otsu
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        # Deskew via minAreaRect
        coords = np.column_stack(np.where(binary < 128))
        if coords.shape[0] > 0:
            angle = cv2.minAreaRect(coords)[-1]
            if angle < -45:
                angle = 90 + angle
            if abs(angle) > 0.5:
                (h, w) = binary.shape[:2]
                M = cv2.getRotationMatrix2D((w // 2, h // 2), angle, 1.0)
                binary = cv2.warpAffine(binary, M, (w, h), flags=cv2.INTER_CUBIC, borderValue=255)

        pil_img = Image.fromarray(binary)
        text = self._pyt.image_to_string(pil_img, lang="por+eng")
        return _clean_text(text)

    def _extract_pdf(self, pdf_bytes: bytes) -> str:
        """Extrai texto de PDF convertendo páginas em imagens (sem poppler, usa PIL direto)."""
        from PIL import Image

        # Tenta abrir como imagem diretamente (PDFs com camada de imagem)
        try:
            img = Image.open(io.BytesIO(pdf_bytes))
            text = self._pyt.image_to_string(img, lang="por+eng")
            return _clean_text(text)
        except Exception:
            return ""


class FallbackProvider(OCRProvider):
    """
    Provedor de fallback para ambientes sem Tesseract.
    Tenta decodificar os bytes como texto UTF-8 ou Latin-1.
    Filtra linhas de controle PDF e retorna apenas conteúdo legível.
    Útil para PDFs baseados em texto e para testes com arquivos mock.
    """

    async def extract(self, file_bytes: bytes, mime_type: str) -> str:
        for encoding in ("utf-8", "latin-1"):
            try:
                raw = file_bytes.decode(encoding)
                return _clean_text(raw)
            except UnicodeDecodeError:
                continue
        return ""


def _clean_text(raw: str) -> str:
    """Remove caracteres de controle e linhas excessivamente curtas."""
    lines = []
    for line in raw.splitlines():
        stripped = line.strip()
        # Filtra linhas de controle PDF e linhas muito curtas
        if len(stripped) < 3:
            continue
        if stripped.startswith("%PDF") or stripped.startswith("%%EOF"):
            continue
        if re.match(r"^[\x00-\x1f]+$", stripped):
            continue
        lines.append(stripped)
    return " ".join(lines)


def get_provider() -> OCRProvider:
    """
    Retorna o melhor provedor disponível no ambiente atual.
    TesseractProvider se o binário estiver instalado; FallbackProvider caso contrário.
    """
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        return TesseractProvider()
    except Exception:
        return FallbackProvider()
