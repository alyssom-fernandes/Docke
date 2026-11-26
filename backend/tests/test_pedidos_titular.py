"""Pedidos do titular: canal público, prazo, responsável, identidade e histórico (B3.7.2)."""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, adm, func, estranho, outra = (str(uuid.uuid4()) for _ in range(5))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Titular'), ($2, 'Outra Titular')", co, outra)
    for uid, nome in ((adm, "Admin Titular"), (func, "Func Titular"), (estranho, "Estranho Titular")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, 'usuario')", uid, f"t_{uid[:6]}", nome)
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $3, 'admin', NULL), ($2, $3, 'visualizador', NULL), ($4, $5, 'admin', NULL)",
        adm, func, co, estranho, outra)
    yield {"co": co, "adm": adm, "func": func, "estranho": estranho}
    await admin.execute("DELETE FROM public.notifications WHERE company_id = ANY($1::uuid[])", [co, outra])
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = ANY($1::uuid[])", [co, outra])
    await admin.execute("DELETE FROM public.companies WHERE id = ANY($1::uuid[])", [co, outra])
    for uid in (adm, func, estranho):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_canal_publico_e_acompanhamento(api, admin, cenario):  # noqa: F811
    pub = API + f"/public/titular/{cenario['co']}"
    pedido = {"tipo": "acesso", "titular_nome": "Maria Titular", "titular_cpf": "123.456.789-09", "contato": "maria@exemplo.test"}
    # Canal desligado: o endereço não revela a empresa.
    assert (await api.get(pub)).status_code == 404
    assert (await api.post(pub, json=pedido)).status_code == 404
    canal = API + f"/companies/{cenario['co']}/privacy/channel"
    assert (await api.put(canal, json={"enabled": True}, headers=_token(cenario["func"]))).status_code == 403
    assert (await api.put(canal, json={"enabled": True}, headers=_token(cenario["adm"]))).status_code == 200
    assert (await api.get(pub)).json()["company_name"] == "Posto Titular"

    r = await api.post(pub, json=pedido)
    assert r.status_code == 201, r.text
    proto, codigo = r.json()["protocolo"], r.json()["codigo"]
    # CPF não fica em claro.
    linha = await admin.fetchrow("SELECT titular_cpf_sha256, titular_cpf_final, canal FROM public.lgpd_requests WHERE protocolo = $1", proto)
    assert linha["titular_cpf_final"] == "09" and "12345678909" not in linha["titular_cpf_sha256"] and linha["canal"] == "formulario"
    assert await admin.fetchval("SELECT count(*) FROM public.notifications WHERE user_id = $1 AND type = 'lgpd_request'", uuid.UUID(cenario["adm"])) == 1

    st = API + "/public/titular-status"
    assert (await api.post(st, json={"protocolo": proto, "codigo": "ERRADO12"})).status_code == 404
    r = await api.post(st, json={"protocolo": proto, "codigo": codigo})
    assert r.status_code == 200 and r.json()["status"] == "recebido" and r.json()["resposta"] is None


@pytest.mark.asyncio
async def test_fluxo_de_atendimento(api, admin, cenario):  # noqa: F811
    base = API + f"/companies/{cenario['co']}/privacy/requests"
    novo = {"tipo": "eliminacao", "canal": "presencial", "titular_nome": "João Titular", "titular_cpf": "98765432100"}
    assert (await api.post(base, json=novo, headers=_token(cenario["func"]))).status_code == 403
    assert (await api.post(base, json=novo, headers=_token(cenario["estranho"]))).status_code == 403
    r = await api.post(base, json=novo, headers=_token(cenario["adm"]))
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    url = API + f"/privacy/requests/{pid}"

    # Não conclui sem identidade nem sem resposta.
    assert (await api.patch(url, json={"status": "concluido", "resposta": "Feito."}, headers=_token(cenario["adm"]))).status_code == 422
    assert (await api.patch(url, json={"identidade_verificada": True}, headers=_token(cenario["adm"]))).status_code == 422
    r = await api.patch(url, json={"identidade_verificada": True, "identidade_metodo": "RG no balcão", "responsavel_id": cenario["func"],
                                   "status": "em_andamento"}, headers=_token(cenario["adm"]))
    assert r.status_code == 200, r.text
    assert r.json()["responsavel_nome"] == "Func Titular"
    assert (await api.patch(url, json={"responsavel_id": cenario["estranho"]}, headers=_token(cenario["adm"]))).status_code == 422
    assert (await api.patch(url, json={"status": "concluido"}, headers=_token(cenario["adm"]))).status_code == 422
    r = await api.patch(url, json={"status": "concluido", "resposta": "Dados eliminados, exceto os com prazo legal de guarda."}, headers=_token(cenario["adm"]))
    assert r.status_code == 200 and r.json()["status"] == "concluido"
    tipos = [e["tipo"] for e in r.json()["eventos"]]
    assert tipos[0] == "criado" and {"identidade", "responsavel", "status", "resposta"} <= set(tipos)
    # Encerrado: só reabrindo.
    assert (await api.patch(url, json={"prazo": "2099-01-01"}, headers=_token(cenario["adm"]))).status_code == 409

    lista = (await api.get(base, headers=_token(cenario["adm"]))).json()
    assert lista[0]["id"] == pid and lista[0]["atrasado"] is False
    assert await admin.fetchval("SELECT count(*) FROM public.activity_log WHERE company_id = $1 AND action LIKE 'lgpd_request_%'", uuid.UUID(cenario["co"])) >= 3
