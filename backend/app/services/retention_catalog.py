"""
Tabela de temporalidade pronta (achado A7-81): ponto de partida para as
políticas de guarda mais comuns. São SUGESTÕES para revisar com a
contabilidade e o jurídico; a tela avisa isso antes de criar. Onde o prazo
conta de um evento (desligamento, fim do contrato), a descrição pede para
usar um campo de data como gatilho.
"""
from typing import Any

RETENTION_CATALOG: list[dict[str, Any]] = [
    {
        "key": "fiscal_5_anos", "name": "Fiscal — 5 anos a partir do ano seguinte",
        "legal_basis": "CTN art. 173",
        "notes": "Notas fiscais, livros, SPED e comprovantes de tributos. O prazo de 5 anos conta de 1º de janeiro do ano seguinte.",
        "duration_months": 60, "start_rule": "ano_seguinte", "locked": True,
    },
    {
        "key": "trabalhista_5_anos", "name": "Folha, INSS e FGTS — 5 anos a partir do ano seguinte",
        "legal_basis": "CTN art. 173; STF ARE 709.212 (FGTS)",
        "notes": "Folhas, guias e comprovantes de recolhimento. Confira com a contabilidade se a empresa adota prazo maior.",
        "duration_months": 60, "start_rule": "ano_seguinte", "locked": True,
    },
    {
        "key": "registro_empregados", "name": "Registro de empregados — guarda permanente",
        "notes": "Ficha ou livro de registro: sem prazo de descarte.",
        "duration_months": None, "start_rule": "data", "locked": True,
    },
    {
        "key": "saude_ocupacional_20_anos", "name": "Saúde ocupacional (ASO, PCMSO) — 20 anos",
        "legal_basis": "NR-7",
        "notes": "Conta a partir do desligamento: troque o gatilho para o campo de data de desligamento, se a empresa usar um.",
        "duration_months": 240, "start_rule": "data", "locked": True,
    },
    {
        "key": "contratos_5_anos", "name": "Contratos — 5 anos após o fim",
        "legal_basis": "Código Civil art. 206",
        "notes": "Conta a partir do fim do contrato: use um campo de data de término como gatilho.",
        "duration_months": 60, "start_rule": "data", "locked": False,
    },
    {
        # B3.7.6: currículo de quem não foi contratado não deve ficar guardado
        # sem motivo (LGPD, art. 15 e 16). Prazo curto e sem trava: a empresa
        # pode guardar mais com consentimento para vagas futuras.
        "key": "candidatos_nao_contratados", "name": "Candidatos não contratados — 6 meses",
        "legal_basis": "LGPD art. 15 e 16 (fim do tratamento)",
        "notes": "Currículos e testes de quem não foi contratado. Se o candidato consentiu em ficar no banco de talentos, use um prazo maior (até 2 anos) e registre o consentimento.",
        "duration_months": 6, "start_rule": "data", "locked": False,
    },
]

RETENTION_BY_KEY = {p["key"]: p for p in RETENTION_CATALOG}
