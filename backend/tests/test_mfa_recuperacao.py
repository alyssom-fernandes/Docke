"""FA-A8-01: códigos de recuperação da verificação em duas etapas."""
import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_retencao_v2 import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_codigos_de_recuperacao_valem_uma_vez(api, admin, empresa):  # noqa: F811
    user = empresa["user"]
    # Gerar pede a sessão verificada.
    r = await api.post(API + "/auth/mfa/recovery-codes", headers=_token(user, aal="aal1"))
    assert r.status_code == 403
    r = await api.post(API + "/auth/mfa/recovery-codes", headers=_token(user))
    assert r.status_code == 200, r.text
    codigos = r.json()["codigos"]
    assert len(codigos) == 10 and len(set(codigos)) == 10
    # Só o HMAC fica no banco.
    guardados = await admin.fetch("SELECT code_hash FROM public.mfa_recovery_codes WHERE user_id = $1", user)
    assert len(guardados) == 10 and all(c not in {g["code_hash"] for g in guardados} for c in codigos)
    assert (await api.get(API + "/auth/mfa", headers=_token(user))).json()["codigos_restantes"] == 10

    # Na entrada (sessão ainda sem a 2ª etapa): código errado não passa.
    assert (await api.post(API + "/auth/mfa/recover", json={"code": "aaaaa-aaaaa"}, headers=_token(user, aal="aal1"))).status_code == 401
    # O certo passa, mesmo digitado em maiúsculas e sem o hífen.
    r = await api.post(API + "/auth/mfa/recover", json={"code": codigos[3].upper().replace("-", "")}, headers=_token(user, aal="aal1"))
    assert r.status_code == 200, r.text
    # Vale uma vez, e os outros deixam de valer (eram do app antigo).
    assert (await api.post(API + "/auth/mfa/recover", json={"code": codigos[3]}, headers=_token(user, aal="aal1"))).status_code == 401
    assert (await api.post(API + "/auth/mfa/recover", json={"code": codigos[4]}, headers=_token(user, aal="aal1"))).status_code == 401
    assert (await api.get(API + "/auth/mfa", headers=_token(user))).json()["codigos_restantes"] == 0
