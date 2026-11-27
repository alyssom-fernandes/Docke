"""
Modelos prontos de obrigações (achado A7-36): ponto de partida para empresas
em geral e para postos, restaurantes e hotéis, em vez de cadastrar tudo do
zero. São SUGESTÕES: a tela pede para conferir prazos e validades com a
contabilidade antes de criar, e tudo pode ser editado depois. Onde o prazo ou
a validade varia por estado ou município, o campo fica vazio e a descrição
diz isso, em vez de inventar um número.

Campos seguem obligation_templates; `segmentos` decide em qual aba aparece.
"""
from typing import Any

_SIMPLES_NAO = {"not_applicable_when": {"field": "regime_tributario", "in": ["lucro_presumido", "lucro_real"]}}
_SO_SIMPLES_NAO = {"not_applicable_when": {"field": "regime_tributario", "in": ["simples_nacional"]}}

CATALOG: list[dict[str, Any]] = [
    # --- Todas as empresas: fiscal e trabalhista -------------------------
    {
        "key": "das_simples", "segmentos": ["geral"], "name": "DAS do Simples Nacional",
        "description": "Guia mensal de tributos do Simples. Prova: guia e comprovante de pagamento.",
        "legal_basis": "LC 123/2006", "frequency": "mensal", "criticality": "alta", "department": "Fiscal",
        "due_day": 20, "due_month_offset": 1, "sla_days": 5, "rules_json": _SIMPLES_NAO,
    },
    {
        "key": "fgts_digital", "segmentos": ["geral"], "name": "FGTS Digital",
        "description": "Recolhimento mensal do FGTS dos empregados. Prova: guia e comprovante.",
        "legal_basis": "Lei 8.036/1990", "frequency": "mensal", "criticality": "alta", "department": "RH",
        "due_day": 20, "due_month_offset": 1, "sla_days": 5,
    },
    {
        "key": "esocial_folha", "segmentos": ["geral"], "name": "eSocial — fechamento da folha",
        "description": "Eventos periódicos da folha do mês. Prova: recibo de entrega.",
        "legal_basis": "Decreto 8.373/2014", "frequency": "mensal", "criticality": "alta", "department": "RH",
        "due_day": 15, "due_month_offset": 1, "sla_days": 5,
    },
    {
        "key": "dctfweb", "segmentos": ["geral"], "name": "DCTFWeb",
        "description": "Declaração das contribuições previdenciárias do mês. Prova: recibo e DARF pago. Confira o prazo vigente com a contabilidade.",
        "legal_basis": "IN RFB 2.005/2021", "frequency": "mensal", "criticality": "alta", "department": "Fiscal",
        "due_day": 15, "due_month_offset": 1, "sla_days": 5,
    },
    {
        "key": "efd_reinf", "segmentos": ["geral"], "name": "EFD-Reinf",
        "description": "Retenções e informações fiscais do mês. Prova: recibo de entrega.",
        "legal_basis": "IN RFB 2.043/2021", "frequency": "mensal", "criticality": "media", "department": "Fiscal",
        "due_day": 15, "due_month_offset": 1, "sla_days": 5,
    },
    {
        "key": "folha_pagamento", "segmentos": ["geral"], "name": "Pagamento da folha (holerites)",
        "description": "Holerites assinados e comprovantes de pagamento. O prazo legal é o 5º dia útil do mês seguinte.",
        "legal_basis": "CLT art. 459", "frequency": "mensal", "criticality": "alta", "department": "RH",
        "due_day": 5, "due_month_offset": 1, "sla_days": 3,
    },
    {
        "key": "defis", "segmentos": ["geral"], "name": "DEFIS (Simples Nacional)",
        "description": "Declaração anual do Simples, referente ao ano anterior. Prova: recibo.",
        "legal_basis": "LC 123/2006", "frequency": "anual", "criticality": "alta", "department": "Fiscal",
        "due_day": 31, "due_month": 3, "sla_days": 30, "rules_json": _SIMPLES_NAO,
    },
    {
        "key": "ecd", "segmentos": ["geral"], "name": "ECD (escrituração contábil digital)",
        "description": "Livros contábeis do ano anterior. Prova: recibo do SPED. Confira o prazo do ano com a contabilidade.",
        "legal_basis": "IN RFB 2.003/2021", "frequency": "anual", "criticality": "alta", "department": "Contábil",
        "due_day": 31, "due_month": 5, "sla_days": 30, "rules_json": _SO_SIMPLES_NAO,
    },
    {
        "key": "ecf", "segmentos": ["geral"], "name": "ECF (escrituração contábil fiscal)",
        "description": "IRPJ e CSLL do ano anterior. Prova: recibo do SPED. Confira o prazo do ano com a contabilidade.",
        "legal_basis": "IN RFB 2.004/2021", "frequency": "anual", "criticality": "alta", "department": "Contábil",
        "due_day": 31, "due_month": 7, "sla_days": 30, "rules_json": _SO_SIMPLES_NAO,
    },
    {
        "key": "cnd_federal", "segmentos": ["geral"], "name": "Certidão negativa federal (CND/CPEN)",
        "description": "Certidão de débitos federais e da dívida ativa. Vale 180 dias: o Docke avisa antes de vencer.",
        "legal_basis": "Portaria Conjunta RFB/PGFN 1.751/2014", "frequency": "unica", "criticality": "alta",
        "department": "Fiscal", "validity_months": 6, "sla_days": 15,
    },
    {
        "key": "crf_fgts", "segmentos": ["geral"], "name": "Certificado de regularidade do FGTS (CRF)",
        "description": "Emitido pela Caixa, vale 30 dias. Pedido em licitações, financiamentos e por grandes clientes.",
        "legal_basis": "Lei 8.036/1990", "frequency": "unica", "criticality": "media", "department": "Fiscal",
        "validity_months": 1, "sla_days": 5,
    },
    {
        "key": "cnd_estadual", "segmentos": ["geral"], "name": "Certidão negativa estadual",
        "description": "Débitos de ICMS com o estado. A validade varia por estado: informe a data impressa ao vincular.",
        "frequency": "unica", "criticality": "media", "department": "Fiscal", "sla_days": 15,
    },
    {
        "key": "cnd_municipal", "segmentos": ["geral"], "name": "Certidão negativa municipal",
        "description": "Débitos com a prefeitura (ISS, IPTU, taxas). A validade varia: informe a data impressa ao vincular.",
        "frequency": "unica", "criticality": "media", "department": "Fiscal", "sla_days": 15,
    },
    {
        "key": "alvara_funcionamento", "segmentos": ["geral", "posto", "restaurante", "hotel"], "name": "Alvará de funcionamento",
        "description": "Licença da prefeitura para funcionar no endereço. Renovação e validade variam por município.",
        "frequency": "unica", "criticality": "critica", "department": "Administrativo", "sla_days": 30,
    },
    {
        "key": "avcb", "segmentos": ["geral", "posto", "restaurante", "hotel"], "name": "AVCB / certificado do Corpo de Bombeiros",
        "description": "Vistoria de prevenção de incêndio. A validade depende do estado e do porte: informe a data do certificado.",
        "frequency": "unica", "criticality": "critica", "department": "Administrativo", "sla_days": 60,
    },
    {
        "key": "pgr", "segmentos": ["geral"], "name": "PGR — programa de gerenciamento de riscos",
        "description": "Inventário de riscos e plano de ação de segurança do trabalho. Revisão a cada 2 anos ou quando o ambiente muda.",
        "legal_basis": "NR-1", "frequency": "unica", "criticality": "alta", "department": "RH",
        "validity_months": 24, "sla_days": 60,
    },
    # --- Postos de combustível -------------------------------------------
    {
        "key": "posto_licenca_ambiental", "segmentos": ["posto"], "name": "Licença de operação ambiental",
        "description": "Exigida para postos pela Resolução CONAMA 273/2000, emitida pelo órgão ambiental do estado. Informe a validade impressa.",
        "legal_basis": "CONAMA 273/2000", "frequency": "unica", "criticality": "critica", "department": "Ambiental", "sla_days": 120,
    },
    {
        "key": "posto_anp", "segmentos": ["posto"], "name": "Autorização da ANP para revenda",
        "description": "Autorização de revendedor varejista de combustíveis. Mantenha o cadastro atualizado a cada mudança.",
        "frequency": "unica", "criticality": "critica", "department": "Administrativo", "sla_days": 30,
    },
    {
        "key": "posto_estanqueidade", "segmentos": ["posto"], "name": "Teste de estanqueidade dos tanques",
        "description": "Laudo do sistema de armazenamento subterrâneo (SASC). A periodicidade vem da licença ambiental.",
        "legal_basis": "CONAMA 273/2000", "frequency": "unica", "criticality": "critica", "department": "Ambiental", "sla_days": 60,
    },
    {
        "key": "posto_inmetro_bombas", "segmentos": ["posto"], "name": "Verificação das bombas medidoras (Inmetro)",
        "description": "Verificação metrológica periódica das bombas. Prova: certificado ou selo do órgão metrológico.",
        "frequency": "unica", "criticality": "alta", "department": "Operação", "validity_months": 12, "sla_days": 30,
    },
    {
        "key": "posto_oleo_usado", "segmentos": ["posto"], "name": "Certificado de coleta de óleo lubrificante usado",
        "description": "Cada coleta por empresa autorizada gera um certificado: guarde todos.",
        "legal_basis": "CONAMA 362/2005", "frequency": "evento", "criticality": "media", "department": "Ambiental", "sla_days": 0,
    },
    # --- Restaurantes ----------------------------------------------------
    {
        "key": "restaurante_licenca_sanitaria", "segmentos": ["restaurante", "hotel"], "name": "Licença sanitária",
        "description": "Licença da Vigilância Sanitária para manipular alimentos. Validade e renovação variam por município.",
        "frequency": "unica", "criticality": "critica", "department": "Operação", "sla_days": 60,
    },
    {
        "key": "restaurante_caixa_dagua", "segmentos": ["restaurante", "hotel"], "name": "Higienização da caixa d'água",
        "description": "Limpeza do reservatório a cada 6 meses, com registro ou laudo da empresa contratada.",
        "legal_basis": "RDC Anvisa 216/2004", "frequency": "unica", "criticality": "alta", "department": "Operação",
        "validity_months": 6, "sla_days": 15,
    },
    {
        "key": "restaurante_pragas", "segmentos": ["restaurante", "hotel"], "name": "Controle de pragas (dedetização)",
        "description": "Certificado da empresa controladora de pragas. A frequência vem do contrato e da licença sanitária.",
        "legal_basis": "RDC Anvisa 216/2004", "frequency": "unica", "criticality": "alta", "department": "Operação", "sla_days": 15,
    },
    {
        "key": "restaurante_boas_praticas", "segmentos": ["restaurante"], "name": "Manual de Boas Práticas e POPs",
        "description": "Manual e procedimentos operacionais padronizados, revisados quando o processo muda.",
        "legal_basis": "RDC Anvisa 216/2004", "frequency": "unica", "criticality": "media", "department": "Operação", "sla_days": 0,
    },
    # --- Hotéis ----------------------------------------------------------
    {
        "key": "hotel_cadastur", "segmentos": ["hotel"], "name": "Cadastur (Ministério do Turismo)",
        "description": "Cadastro obrigatório de meios de hospedagem. O certificado vale 2 anos.",
        "legal_basis": "Lei 11.771/2008", "frequency": "unica", "criticality": "alta", "department": "Administrativo",
        "validity_months": 24, "sla_days": 60,
    },
]

# --- Mais modelos que dependem do regime, da atividade ou do porte ---------
CATALOG += [
    {
        "key": "das_mei", "segmentos": ["geral"], "name": "DAS do MEI",
        "description": "Guia mensal fixa do microempreendedor individual. Prova: guia e comprovante.",
        "legal_basis": "LC 123/2006, art. 18-A", "frequency": "mensal", "criticality": "alta", "department": "Fiscal",
        "due_day": 20, "due_month_offset": 1, "sla_days": 5,
    },
    {
        "key": "dasn_simei", "segmentos": ["geral"], "name": "DASN-SIMEI (declaração anual do MEI)",
        "description": "Faturamento do ano anterior do MEI. Prova: recibo da declaração.",
        "legal_basis": "LC 123/2006", "frequency": "anual", "criticality": "alta", "department": "Fiscal",
        "due_day": 31, "due_month": 5, "sla_days": 30,
    },
    {
        "key": "destda", "segmentos": ["geral"], "name": "DeSTDA (Simples, ICMS)",
        "description": "Substituição tributária, diferencial de alíquota e antecipação do ICMS de quem está no Simples e vende mercadorias. Prova: recibo. Confira com a contabilidade se o seu estado exige.",
        "legal_basis": "Ajuste SINIEF 12/2015", "frequency": "mensal", "criticality": "media", "department": "Fiscal",
        "due_day": 28, "due_month_offset": 1, "sla_days": 5,
    },
    {
        "key": "efd_icms_ipi", "segmentos": ["geral"], "name": "EFD ICMS/IPI (SPED Fiscal)",
        "description": "Escrituração mensal do ICMS e do IPI de quem está fora do Simples e vende ou fabrica mercadorias. O prazo é definido por cada estado: informe o do seu ao cadastrar.",
        "legal_basis": "Ajuste SINIEF 2/2009", "frequency": "mensal", "criticality": "alta", "department": "Fiscal",
        "due_month_offset": 1, "sla_days": 5,
    },
    {
        "key": "efd_contribuicoes", "segmentos": ["geral"], "name": "EFD-Contribuições (PIS e Cofins)",
        "description": "Escrituração mensal do PIS e da Cofins. O prazo é o 10º dia útil do segundo mês seguinte: confira o dia exato com a contabilidade.",
        "legal_basis": "IN RFB 1.252/2012", "frequency": "mensal", "criticality": "alta", "department": "Fiscal",
        "due_month_offset": 2, "sla_days": 5,
    },
    {
        "key": "dimob", "segmentos": ["geral"], "name": "DIMOB (atividades imobiliárias)",
        "description": "Declaração anual de quem incorpora, intermedia ou administra imóveis de terceiros. Prazo: último dia útil de fevereiro.",
        "legal_basis": "IN RFB 1.115/2010", "frequency": "anual", "criticality": "alta", "department": "Fiscal",
        "due_day": 28, "due_month": 2, "sla_days": 30,
    },
    {
        "key": "pcmso", "segmentos": ["geral"], "name": "PCMSO — relatório analítico anual",
        "description": "Programa de saúde ocupacional e relatório anual dos exames (ASO) dos empregados.",
        "legal_basis": "NR-7", "frequency": "unica", "criticality": "alta", "department": "RH",
        "validity_months": 12, "sla_days": 30,
    },
]

# Quando cada modelo vale (A9-13). Critérios, todos precisam valer:
#   regimes: regime tributário em uma destas opções
#   tipos: tipo jurídico em uma destas opções; tipos_fora: fora destas
#   com_empregados: True = só com empregados
#   cnae: atividade principal começando por um destes prefixos
#   setores: "mercadorias" = indústria (CNAE 10 a 33) ou comércio (45 a 47)
# Sem critério, o modelo vale para todas as empresas.
_COM_EMPREGADOS = {"com_empregados": True}
_NAO_MEI = {"tipos_fora": ["mei"]}
APLICA: dict[str, dict[str, Any]] = {
    "das_simples": {"regimes": ["simples_nacional"], **_NAO_MEI},
    "defis": {"regimes": ["simples_nacional"], **_NAO_MEI},
    "das_mei": {"tipos": ["mei"]},
    "dasn_simei": {"tipos": ["mei"]},
    "fgts_digital": _COM_EMPREGADOS,
    "esocial_folha": _COM_EMPREGADOS,
    "dctfweb": _COM_EMPREGADOS,
    "folha_pagamento": _COM_EMPREGADOS,
    "pgr": _COM_EMPREGADOS,
    "pcmso": _COM_EMPREGADOS,
    "ecd": {"regimes": ["lucro_presumido", "lucro_real"]},
    "ecf": {"regimes": ["lucro_presumido", "lucro_real"]},
    "efd_contribuicoes": {"regimes": ["lucro_presumido", "lucro_real"]},
    "efd_icms_ipi": {"regimes": ["lucro_presumido", "lucro_real"], "setores": "mercadorias"},
    "destda": {"regimes": ["simples_nacional"], "setores": "mercadorias", **_NAO_MEI},
    "dimob": {"cnae": ["4110", "6821", "6822"]},
    "posto_licenca_ambiental": {"cnae": ["4731"]},
    "posto_anp": {"cnae": ["4731"]},
    "posto_estanqueidade": {"cnae": ["4731"]},
    "posto_inmetro_bombas": {"cnae": ["4731"]},
    "posto_oleo_usado": {"cnae": ["4731", "4520", "4530"]},
    "restaurante_licenca_sanitaria": {"cnae": ["5611", "5612", "5620", "5510", "5590", "1091", "4721"]},
    "restaurante_caixa_dagua": {"cnae": ["5611", "5612", "5620", "5510", "5590", "1091"]},
    "restaurante_pragas": {"cnae": ["5611", "5612", "5620", "5510", "5590", "1091", "4721"]},
    "restaurante_boas_praticas": {"cnae": ["5611", "5612", "5620", "1091"]},
    "hotel_cadastur": {"cnae": ["5510", "5590"]},
}

_REGIME_LABEL = {"simples_nacional": "Simples Nacional", "lucro_presumido": "Lucro Presumido", "lucro_real": "Lucro Real"}


def _cnae_fmt(cnae: str) -> str:
    return f"{cnae[:4]}-{cnae[4]}/{cnae[5:7]}" if len(cnae) == 7 else cnae


def avaliar(key: str, perfil: dict[str, Any] | None) -> dict[str, Any]:
    """
    Diz se o modelo vale para a empresa pelo perfil fiscal:
      "recomendado"  — todos os critérios conferem com o perfil;
      "nao_se_aplica" — algum critério informado não confere;
      "falta_perfil" — depende de um dado que o perfil não tem.
    `motivos` explica com o dado do perfil (ex.: "Simples Nacional", "CNAE 4731-8/00").
    """
    perfil = perfil or {}
    criterios = APLICA.get(key, {})
    motivos: list[str] = []
    faltam: list[str] = []
    regime = perfil.get("regime_tributario")
    tipo = perfil.get("tipo_juridico")
    faixa = perfil.get("faixa_funcionarios")
    cnae = (perfil.get("cnae_principal") or "").strip()

    def nao(motivo: str) -> dict[str, Any]:
        return {"situacao": "nao_se_aplica", "motivos": [motivo]}

    if "regimes" in criterios:
        if not regime:
            faltam.append("regime tributário")
        elif regime not in criterios["regimes"]:
            return nao(f"não vale para {_REGIME_LABEL.get(regime, regime)}")
        else:
            motivos.append(_REGIME_LABEL.get(regime, regime))
    if "tipos" in criterios:
        if not tipo:
            faltam.append("tipo jurídico")
        elif tipo not in criterios["tipos"]:
            return nao("só para MEI" if criterios["tipos"] == ["mei"] else "não vale para este tipo jurídico")
        else:
            motivos.append("MEI" if tipo == "mei" else tipo)
    if "tipos_fora" in criterios and tipo in criterios["tipos_fora"]:
        return nao("o MEI tem guia e declaração próprias")
    if criterios.get("com_empregados"):
        if not faixa:
            faltam.append("quantidade de funcionários")
        elif faixa == "nenhum":
            return nao("só para quem tem empregados")
        else:
            motivos.append("tem empregados")
    if "cnae" in criterios or "setores" in criterios:
        if not cnae:
            faltam.append("atividade principal (CNAE)")
        else:
            if "cnae" in criterios and not any(cnae.startswith(p) for p in criterios["cnae"]):
                return nao(f"não vale para a atividade {_cnae_fmt(cnae)}")
            if criterios.get("setores") == "mercadorias":
                divisao = int(cnae[:2]) if cnae[:2].isdigit() else -1
                if not (10 <= divisao <= 33 or 45 <= divisao <= 47):
                    return nao("só para quem fabrica ou vende mercadorias")
            motivos.append(f"CNAE {_cnae_fmt(cnae)}")
    if faltam:
        return {"situacao": "falta_perfil", "motivos": [f"depende de: {', '.join(faltam)}"]}
    if not criterios:
        motivos.append("vale para todas as empresas")
    return {"situacao": "recomendado", "motivos": motivos}


BY_KEY = {item["key"]: item for item in CATALOG}

SEGMENTOS = [
    {"id": "perfil", "label": "Para esta empresa"},
    {"id": "geral", "label": "Todas as empresas"},
    {"id": "posto", "label": "Posto de combustível"},
    {"id": "restaurante", "label": "Restaurante"},
    {"id": "hotel", "label": "Hotel"},
]
