"""Catálogo de obrigações recomendado pelo perfil fiscal (A9-13)."""
from app.services.obligation_catalog import APLICA, BY_KEY, CATALOG, avaliar

POSTO_PRESUMIDO = {"regime_tributario": "lucro_presumido", "faixa_funcionarios": "11_a_50",
                   "tipo_juridico": "ltda", "uf": "BA", "cnae_principal": "4731800"}
ADM_BENS_SIMPLES_SEM_EMPREGADOS = {"regime_tributario": "simples_nacional", "faixa_funcionarios": "nenhum",
                                   "tipo_juridico": "ltda", "uf": "BA", "cnae_principal": "6810202"}
MEI = {"regime_tributario": "simples_nacional", "faixa_funcionarios": "nenhum", "tipo_juridico": "mei",
       "cnae_principal": "4781400"}


def _sit(key, perfil):
    return avaliar(key, perfil)["situacao"]


def test_todo_criterio_aponta_para_um_modelo_existente():
    assert set(APLICA) <= set(BY_KEY)
    assert len({i["key"] for i in CATALOG}) == len(CATALOG)


def test_posto_no_lucro_presumido():
    p = POSTO_PRESUMIDO
    assert _sit("posto_anp", p) == "recomendado"
    assert _sit("efd_icms_ipi", p) == "recomendado"
    assert _sit("efd_contribuicoes", p) == "recomendado"
    assert _sit("fgts_digital", p) == "recomendado"
    assert _sit("das_simples", p) == "nao_se_aplica"
    assert _sit("destda", p) == "nao_se_aplica"
    assert _sit("hotel_cadastur", p) == "nao_se_aplica"
    assert avaliar("posto_anp", p)["motivos"] == ["CNAE 4731-8/00"]


def test_administradora_de_bens_proprios_no_simples_sem_empregados():
    p = ADM_BENS_SIMPLES_SEM_EMPREGADOS
    assert _sit("das_simples", p) == "recomendado"
    assert _sit("defis", p) == "recomendado"
    assert _sit("fgts_digital", p) == "nao_se_aplica"
    # Aluguel de imóvel próprio não é intermediação: sem DIMOB, sem DeSTDA (não vende mercadoria).
    assert _sit("dimob", p) == "nao_se_aplica"
    assert _sit("destda", p) == "nao_se_aplica"
    assert _sit("cnd_federal", p) == "recomendado"


def test_mei_tem_guia_e_declaracao_proprias():
    assert _sit("das_mei", MEI) == "recomendado"
    assert _sit("dasn_simei", MEI) == "recomendado"
    assert _sit("das_simples", MEI) == "nao_se_aplica"
    assert _sit("destda", MEI) == "nao_se_aplica"


def test_perfil_vazio_nao_esconde_nada():
    assert _sit("das_simples", {}) == "falta_perfil"
    assert avaliar("efd_icms_ipi", {})["motivos"] == ["depende de: regime tributário, atividade principal (CNAE)"]
    assert _sit("cnd_federal", {}) == "recomendado"
    assert avaliar("cnd_federal", None)["motivos"] == ["vale para todas as empresas"]
