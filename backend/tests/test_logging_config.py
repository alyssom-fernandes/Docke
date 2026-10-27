"""
Logging do app (app/main.py): os logger.info de docke.* — fim do reset da
demo, partida do worker de OCR, purgas por retenção — precisam chegar ao log
da Fly; sem configuração, o Python descarta tudo abaixo de WARNING. As
bibliotecas seguem em WARNING (o httpx registraria cada requisição em INFO).
Sem banco e sem rede.
"""
import logging

import pytest

import app.main  # noqa: F401 — a configuração do logging roda na importação


@pytest.mark.parametrize("name", ["docke.demo_reset", "docke.ocr_worker", "docke.maintenance_worker"])
def test_loggers_do_app_liberam_info(name):
    assert logging.getLogger(name).isEnabledFor(logging.INFO)


def test_bibliotecas_seguem_em_warning():
    assert not logging.getLogger("httpx").isEnabledFor(logging.INFO)
