"""
Extração de texto por formato (app/services/ocr_service.py), sem banco e sem
rede. Até 25/11/2026 o provedor de produção devolvia texto vazio para todo
PDF, XML, DOCX, XLSX, CSV e TXT (achado X3-01). O CI não tem o binário do
Tesseract, então aqui vale o caminho de texto nativo; o OCR de imagem é
testado só quando o Tesseract estiver instalado.
"""
import io
import zipfile

import pytest

from app.seed.demo_data import _generate_minimal_pdf
from app.services.ocr_service import OCRProvider, UnsupportedFormat, clean_text, get_provider

SEM_TESSERACT = OCRProvider(tesseract=False)


def test_pdf_digital_le_a_camada_de_texto():
    pdf = _generate_minimal_pdf("Contrato de Locação\n\nCNPJ 12.345.678/0001-90 — São Paulo")
    r = SEM_TESSERACT.extract_sync(pdf, "application/pdf")
    assert "Contrato de Locação" in r.text
    assert "12.345.678/0001-90" in r.text
    assert r.searchable_pdf is None and r.ocr_pages == 0


def test_xml_da_nfe_traz_os_valores():
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<nfeProc><NFe><infNFe><emit><CNPJ>12345678000190</CNPJ><xNome>Posto Exemplo Ltda</xNome></emit>'
        "<det><prod><xProd>Gasolina comum</xProd></prod></det></infNFe></NFe></nfeProc>"
    ).encode()
    for mime in ("application/xml", "text/xml"):
        texto = SEM_TESSERACT.extract_sync(xml, mime).text
        assert "12345678000190" in texto and "Posto Exemplo Ltda" in texto and "Gasolina comum" in texto


def test_docx_com_paragrafos_e_cabecalho():
    ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", f"<w:document {ns}><w:body><w:p><w:r><w:t>Atestado de saúde</w:t></w:r></w:p>"
                                         f"<w:p><w:r><w:t>ocupacional</w:t></w:r></w:p></w:body></w:document>")
        z.writestr("word/header1.xml", f"<w:hdr {ns}><w:p><w:r><w:t>Clínica Modelo</w:t></w:r></w:p></w:hdr>")
    texto = SEM_TESSERACT.extract_sync(
        buf.getvalue(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ).text
    assert texto.splitlines() == ["Atestado de saúde", "ocupacional", "Clínica Modelo"]


def test_xlsx_le_todas_as_planilhas():
    from openpyxl import Workbook

    wb = Workbook()
    wb.active.title = "Extrato"
    wb.active.append(["Data", "Valor"])
    wb.active.append(["01/11/2026", 1520.75])
    wb.create_sheet("Resumo").append(["Saldo final", 98.5])
    buf = io.BytesIO()
    wb.save(buf)
    texto = SEM_TESSERACT.extract_sync(
        buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    ).text
    for trecho in ("Extrato", "1520.75", "Resumo", "Saldo final 98.5"):
        assert trecho in texto


@pytest.mark.parametrize("mime", ["text/plain", "text/csv"])
def test_texto_em_utf8_e_em_windows_1252(mime):
    assert SEM_TESSERACT.extract_sync("Razão social;São José".encode("utf-8"), mime).text == "Razão social;São José"
    assert SEM_TESSERACT.extract_sync("Razão social;São José".encode("cp1252"), mime).text == "Razão social;São José"


def test_formato_desconhecido_e_imagem_sem_tesseract_sao_falha():
    with pytest.raises(UnsupportedFormat):
        SEM_TESSERACT.extract_sync(b"\x00\x01", "application/octet-stream")
    with pytest.raises(UnsupportedFormat):
        SEM_TESSERACT.extract_sync(b"\x89PNG", "image/png")


def test_pdf_corrompido_levanta_erro_em_vez_de_texto_vazio():
    with pytest.raises(Exception):
        SEM_TESSERACT.extract_sync(b"%PDF-1.4 isto nao e um pdf", "application/pdf")


def test_limpeza_mantem_quebras_e_tira_controles():
    assert clean_text("a\x00b  c\r\n\r\n  d\t e ") == "a b c\nd e"


@pytest.mark.skipif(not get_provider().tesseract, reason="Tesseract não instalado neste ambiente")
def test_pdf_escaneado_passa_pelo_tesseract_e_gera_pdf_pesquisavel():
    from PIL import Image, ImageDraw, ImageFont

    img = Image.new("RGB", (1240, 400), "white")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", 64)
    except OSError:
        font = ImageFont.load_default(size=64)
    draw.text((40, 150), "HOLERITE NOVEMBRO", fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, format="PDF", resolution=150)
    r = get_provider().extract_sync(buf.getvalue(), "application/pdf")
    assert "HOLERITE" in r.text.upper()
    assert r.ocr_pages == 1 and r.searchable_pdf and r.searchable_pdf.startswith(b"%PDF")
