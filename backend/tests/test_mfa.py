"""
Verificação em duas etapas (decisão do dono em 26/11/2026; achados X2-12,
FA-A1-02, FA-A8-01, B4.2.3): quem tem app autenticador precisa do código na
sessão (aal2); a política da empresa obriga administradores e quem acessa
pasta com dado pessoal/sensível; só o administrador geral muda a regra e zera
o app de alguém. O cadastro e a conferência do código conversam com o Supabase
Auth e ficam para a conferência ao vivo; aqui entra a regra da API.
"""
import uuid

import asyncpg
import pytest
import pytest_asyncio

from app.config import settings
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co = str(uuid.uuid4())
    chefe, adm, leitor, rh, comum = (str(uuid.uuid4()) for _ in range(5))
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto MFA')", co)
    for uid, nome, papel in ((chefe, "Chefe MFA", "supremo"), (adm, "Admin MFA", "usuario"), (leitor, "Leitor MFA", "usuario"),
                             (rh, "RH MFA", "usuario"), (comum, "Comum MFA", "usuario")):
        await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
        await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, $3, $4)",
                            uid, f"m_{uid[:6]}", nome, papel)
    await admin.execute(
        "INSERT INTO public.folders (company_id, name, path, sensitivity) VALUES ($1, 'RH', 'rh', 'pessoal'), ($1, 'Fiscal', 'fiscal', 'normal')",
        co,
    )
    await admin.execute(
        """
        INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES
          ($1, $5, 'admin', NULL), ($2, $5, 'visualizador', 'fiscal'), ($3, $5, 'visualizador', 'rh'), ($4, $5, 'visualizador', 'fiscal')
        """,
        adm, leitor, rh, comum, co,
    )
    yield {"co": co, "chefe": chefe, "adm": adm, "leitor": leitor, "rh": rh, "comum": comum}
    await admin.execute("DELETE FROM auth.mfa_factors WHERE user_id = ANY($1::uuid[])", [chefe, adm, leitor, rh, comum])
    await admin.execute("DELETE FROM public.activity_log WHERE company_id = $1", co)
    await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
    for uid in (chefe, adm, leitor, rh, comum):
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


async def _fator(admin: asyncpg.Connection, user_id: str) -> str:
    return str(await admin.fetchval(
        """
        INSERT INTO auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
        VALUES (gen_random_uuid(), $1, 'App de teste ' || gen_random_uuid(), 'totp', 'verified', now(), now())
        RETURNING id
        """,
        user_id,
    ))


@pytest.mark.asyncio
async def test_politica_obriga_admins_e_quem_acessa_dado_pessoal(api, cenario):  # noqa: F811
    co = cenario["co"]
    # Sem o app cadastrado e sem código: admin, quem acessa o RH e o administrador geral ficam presos ao cadastro.
    for quem in ("adm", "rh", "chefe"):
        r = await api.get(API + f"/companies/{co}/mfa-policy", headers=_token(cenario[quem], aal="aal1"))
        assert r.status_code == 403, (quem, r.text)
        assert r.json()["code"] == "mfa_cadastrar"
        me = await api.get(API + "/auth/me", headers=_token(cenario[quem], aal="aal1"))
        assert me.status_code == 200 and me.json()["mfa_pendente"] == "cadastrar"
    # Quem só vê a pasta Fiscal não é obrigado.
    r = await api.get(API + f"/companies/{co}/mfa-policy", headers=_token(cenario["comum"], aal="aal1"))
    assert r.status_code == 200, r.text
    assert r.json() == {"policy": "admins_sensiveis", "can_edit": False}


@pytest.mark.asyncio
async def test_quem_tem_app_precisa_do_codigo_na_sessao(api, admin, cenario):  # noqa: F811
    co, leitor = cenario["co"], cenario["leitor"]
    await _fator(admin, leitor)  # ativou por conta própria, sem ser obrigado
    r = await api.get(API + f"/companies/{co}/mfa-policy", headers=_token(leitor, aal="aal1"))
    assert r.status_code == 403 and r.json()["code"] == "mfa_verificar"
    st = await api.get(API + "/auth/mfa", headers=_token(leitor, aal="aal1"))
    assert st.status_code == 200
    assert st.json()["ativada"] is True and st.json()["pendente"] == "verificar" and len(st.json()["fatores"]) == 1
    # Com o código conferido (aal2), passa.
    assert (await api.get(API + f"/companies/{co}/mfa-policy", headers=_token(leitor))).status_code == 200


@pytest.mark.asyncio
async def test_so_o_administrador_geral_muda_a_regra_e_zera_o_app(api, admin, cenario):  # noqa: F811
    co = cenario["co"]
    r = await api.put(API + f"/companies/{co}/mfa-policy", json={"policy": "desligada"}, headers=_token(cenario["adm"]))
    assert r.status_code == 403
    r = await api.put(API + f"/companies/{co}/mfa-policy", json={"policy": "qualquer"}, headers=_token(cenario["chefe"]))
    assert r.status_code == 422

    # Com a regra desligada, o admin sem app passa; o administrador geral continua obrigado.
    r = await api.put(API + f"/companies/{co}/mfa-policy", json={"policy": "desligada"}, headers=_token(cenario["chefe"]))
    assert r.status_code == 200, r.text
    assert (await api.get(API + f"/companies/{co}/mfa-policy", headers=_token(cenario["adm"], aal="aal1"))).status_code == 200
    r = await api.get(API + f"/companies/{co}/mfa-policy", headers=_token(cenario["chefe"], aal="aal1"))
    assert r.status_code == 403 and r.json()["code"] == "mfa_cadastrar"
    await api.put(API + f"/companies/{co}/mfa-policy", json={"policy": "admins_sensiveis"}, headers=_token(cenario["chefe"]))

    # Zerar o app de alguém: só o administrador geral, e fica na trilha.
    await _fator(admin, cenario["rh"])
    r = await api.post(API + f"/companies/{co}/members/{cenario['rh']}/reset-mfa", headers=_token(cenario["adm"]))
    assert r.status_code == 403
    pessoas = await api.get(API + f"/companies/{co}/people", headers=_token(cenario["adm"]))
    assert next(p for p in pessoas.json() if p["user_id"] == cenario["rh"])["mfa_enabled"] is True
    acoes = await admin.fetch("SELECT action FROM public.activity_log WHERE company_id = $1", co)
    assert "mfa_policy" in {a["action"] for a in acoes}


@pytest.mark.asyncio
async def test_demo_nao_e_obrigada(api, admin):  # noqa: F811
    from jose import jwt

    co, uid = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name, mfa_policy) VALUES ($1, 'Demo MFA', 'todos')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Demo', 'usuario')", uid, f"d_{uid[:6]}")
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", uid, co)
    try:
        claims = {"sub": uid, "role": "authenticated", "aud": "authenticated", "aal": "aal1", "email": settings.DEMO_EMAIL}
        h = {"Authorization": f"Bearer {jwt.encode(claims, settings.JWT_SECRET, algorithm='HS256')}"}
        assert (await api.get(API + f"/companies/{co}/mfa-policy", headers=h)).status_code == 200
        r = await api.get(API + f"/companies/{co}/mfa-policy", headers=_token(uid, aal="aal1"))
        assert r.status_code == 403 and r.json()["code"] == "mfa_cadastrar"
    finally:
        await admin.execute("DELETE FROM public.companies WHERE id = $1", co)
        await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)
