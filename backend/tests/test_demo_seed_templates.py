"""
Modelos de documento do seed da demo (app.seed.demo_data.pick_template): os
quatro primeiros são um PDF por pasta raiz e o quinto é sempre a NF-e, para o
E2E de busca por "NF" não depender de sorteio. Sem banco e sem rede.
"""
import pytest

from app.seed.demo_data import DOCUMENTS, FOLDERS, NFE_TEMPLATE, pick_template


@pytest.mark.parametrize("_", range(50))
def test_um_pdf_por_pasta_e_nfe_em_seguida(_):
    for i in range(1, len(FOLDERS) + 1):
        _tmpl, ext, folder_idx = pick_template(i)
        assert ext == "pdf"
        assert folder_idx == i - 1
    tmpl, ext, _folder = pick_template(len(FOLDERS) + 1)
    assert tmpl.startswith("NF-e") and ext == "xml"


def test_demais_documentos_vem_da_lista():
    for i in range(len(FOLDERS) + 2, 18):
        assert pick_template(i) in DOCUMENTS
    assert NFE_TEMPLATE in DOCUMENTS
