"""Exames ocupacionais (ASO) por colaborador com matriz (FA-A7-05)."""
import uuid
from datetime import date, timedelta

import asyncpg
import pytest
import pytest_asyncio

from app.routers.employees import situacao
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"
HOJE = date(2026, 11, 27)


def test_situacao_regras():
    emp = {"admission_date": date(2025, 1, 10), "termination_date": None, "periodic_months": 12}
    # Sem nenhum exame: admissional atrasado, periódico pendente, demissional não se aplica.
    s = situacao(emp, [], HOJE)
    assert (s["admissional"]["estado"], s["periodico"]["estado"], s["demissional"]["estado"]) == ("atrasado", "pendente", "nao_se_aplica")
    # Admissional feito há quase 2 anos: periódico venceu.
    s = situacao(emp, [{"kind": "admissional", "exam_date": date(2025, 1, 8)}], HOJE)
    assert s["admissional"]["estado"] == "ok" and s["periodico"]["estado"] == "atrasado" and s["periodico"]["prazo"] == date(2026, 1, 8)
    # Periódico recente que vence em 20 dias: aviso.
    s = situacao(emp, [{"kind": "admissional", "exam_date": date(2025, 1, 8)}, {"kind": "periodico", "exam_date": date(2025, 12, 17)}], HOJE)
    assert s["periodico"]["estado"] == "vence_logo"
    # Desligado há 15 dias sem demissional: atrasado; periódico deixa de valer.
    desl = {**emp, "termination_date": HOJE - timedelta(days=15)}
    s = situacao(desl, [{"kind": "admissional", "exam_date": date(2025, 1, 8)}], HOJE)
    assert s["demissional"]["estado"] == "atrasado" and s["periodico"]["estado"] == "nao_se_aplica"
    # Fim de mês: 31/01 + 1 mês cai no último dia de fevereiro.
    s = situacao({**emp, "periodic_months": 1}, [{"kind": "admissional", "exam_date": date(2026, 1, 31)}], date(2026, 2, 1))
    assert s["periodico"]["prazo"] == date(2026, 2, 28)


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, adm, operador = (str(uuid.uuid4()) for _ in range(3))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto ASO')", co)
    for uid, nome in ((adm, "Admin ASO"), (operador, "Operador ASO")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"a_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $3, 'admin', NULL), ($2, $3, 'operador', NULL)",
        adm, operador, co)
    yield {"co": co, "adm": adm, "operador": operador}
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", uuid.UUID(co))
    await admin.execute("DELETE FROM public.companies WHERE id = $1", uuid.UUID(co))
    for uid in (adm, operador):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_colaborador_exames_e_matriz(api, admin, cenario):  # noqa: F811
    base = API + f"/companies/{cenario['co']}/employees"
    corpo = {"name": "Maria Frentista", "role_title": "Frentista", "admission_date": "2026-01-05"}
    # Dado de saúde: operador não vê nem cadastra.
    assert (await api.post(base, json=corpo, headers=_token(cenario["operador"]))).status_code == 403
    assert (await api.get(base, headers=_token(cenario["operador"]))).status_code == 403
    r = await api.post(base, json=corpo, headers=_token(cenario["adm"]))
    assert r.status_code == 201, r.text
    eid = r.json()["id"]

    m = (await api.get(base, headers=_token(cenario["adm"]))).json()
    assert m["colaboradores"][0]["situacao"]["admissional"]["estado"] == "atrasado"
    r = await api.post(API + f"/employees/{eid}/exams", json={"kind": "admissional", "exam_date": "2026-01-02"}, headers=_token(cenario["adm"]))
    assert r.status_code == 201, r.text
    linha = (await api.get(base, headers=_token(cenario["adm"]))).json()["colaboradores"][0]
    assert linha["situacao"]["admissional"]["estado"] == "ok" and linha["situacao"]["periodico"]["prazo"] == "2027-01-02"

    # Desligamento: pede o demissional; desligamento antes da admissão é recusado.
    assert (await api.patch(API + f"/employees/{eid}", json={"termination_date": "2025-12-01"}, headers=_token(cenario["adm"]))).status_code == 422
    assert (await api.patch(API + f"/employees/{eid}", json={"termination_date": date.today().isoformat()}, headers=_token(cenario["adm"]))).status_code == 200
    linha = (await api.get(base, headers=_token(cenario["adm"]))).json()["colaboradores"][0]
    assert linha["situacao"]["demissional"]["estado"] == "pendente"
    # A trilha guarda o tipo do exame, não o resultado.
    meta = await admin.fetchval("SELECT metadata::text FROM public.activity_log WHERE action = 'aso_registered' AND company_id = $1", uuid.UUID(cenario["co"]))
    assert "admissional" in meta and "apto" not in meta
