"""Varredura do storage: só arquivos de empresas apagadas, com mais de 1 dia."""
from datetime import datetime, timedelta, timezone

from app.workers.maintenance_worker import chaves_de_empresas_apagadas

VIVA = "11111111-1111-4111-8111-111111111111"
APAGADA = "22222222-2222-4222-8222-222222222222"
AGORA = datetime(2026, 11, 27, 12, tzinfo=timezone.utc)
LIMITE = AGORA - timedelta(days=1)
VELHO = AGORA - timedelta(days=3)
NOVO = AGORA - timedelta(hours=2)


def _escolher(objetos):
    return chaves_de_empresas_apagadas(objetos, {VIVA}, LIMITE)


def test_apaga_so_o_que_e_de_empresa_apagada_e_antigo():
    objetos = [
        (f"documents/{APAGADA}/a.pdf", VELHO),
        (f"derivatives/documents/{APAGADA}/a.pdf.thumb.webp", VELHO),
        (f"exports/{APAGADA}/job", VELHO),
        (f"company-logos/{APAGADA}.png", VELHO),
        (f"documents/{VIVA}/b.pdf", VELHO),
        (f"derivatives/documents/{VIVA}/b.pdf.ocr.pdf", VELHO),
        (f"company-logos/{VIVA}.png", VELHO),
    ]
    assert _escolher(objetos) == [
        f"documents/{APAGADA}/a.pdf",
        f"derivatives/documents/{APAGADA}/a.pdf.thumb.webp",
        f"exports/{APAGADA}/job",
        f"company-logos/{APAGADA}.png",
    ]


def test_arquivo_recente_fica_mesmo_sem_empresa():
    # Empresa criada agora pode ainda não aparecer na consulta: 1 dia de folga.
    assert _escolher([(f"documents/{APAGADA}/novo.pdf", NOVO)]) == []


def test_chave_sem_dona_reconhecivel_nunca_sai():
    objetos = [
        ("backups/2026-11-27.dump", VELHO),
        ("documents/nao-e-uuid/x.pdf", VELHO),
        ("outro/22222222-2222-4222-8222-222222222222/x", VELHO),
        (f"documents/{APAGADA}/sem-data.pdf", None),
    ]
    assert _escolher(objetos) == []
