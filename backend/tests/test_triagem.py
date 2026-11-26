"""Pasta de triagem com sugestão por regras (B1.1.8)."""
import uuid
from datetime import date

import pytest

from app.routers.inbox import competencia_no_nome, palavras
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


def test_regras_do_nome():
    assert palavras("Holerite_Maria_03-2026.pdf") == ["holerite", "maria"]
    assert competencia_no_nome("Holerite_Maria_03-2026.pdf") == date(2026, 3, 1)
    assert competencia_no_nome("DCTF 2026_11.pdf") == date(2026, 11, 1)
    assert competencia_no_nome("NF 123456.pdf") is None


@pytest.mark.asyncio
async def test_triagem_sugere_pasta_por_nome(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    # Sem pasta de triagem: vazio. Com: cria "Entrada" no topo.
    assert (await api.get(API + f"/companies/{empresa['co']}/inbox", headers=h)).json() == {"folder": None, "documents": []}
    r = await api.put(API + f"/companies/{empresa['co']}/inbox", json={}, headers=h)
    assert r.status_code == 200, r.text
    entrada = r.json()["folder_id"]
    for i in range(3):
        await _doc(admin, empresa, empresa["sub"], f"Holerite_{i}.pdf", "holerite")
    novo = await _doc(admin, empresa, entrada, "Holerite_Joao_05-2026.pdf", "holerite")
    j = (await api.get(API + f"/companies/{empresa['co']}/inbox", headers=h)).json()
    item = next(d for d in j["documents"] if d["id"] == novo)
    assert item["sugestao"]["folder_id"] == empresa["sub"] and "nome parecido" in item["sugestao"]["motivo"]
    assert item["sugestao"]["competencia"] == "2026-05-01"
    # Só uma pasta de triagem por empresa: trocar desmarca a anterior.
    assert (await api.put(API + f"/companies/{empresa['co']}/inbox", json={"folder_id": empresa["raiz"]}, headers=h)).status_code == 200
    assert await admin.fetchval("SELECT count(*) FROM public.folders WHERE company_id = $1 AND is_inbox", uuid.UUID(empresa["co"])) == 1
