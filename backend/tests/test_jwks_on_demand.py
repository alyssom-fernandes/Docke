"""
JWKS sob demanda (_decode_jwt_refreshing em app/dependencies.py): um token
ES256 cuja chave não está em memória faz a API buscar o JWKS de novo na hora,
em vez de responder 401 até o próximo ciclo de jwks_refresh_loop (1h). Foi o
que derrubou todo login da demo depois da retomada do Supabase em 26/10/2026.
Sem banco e sem rede: a chave EC é gerada aqui e _fetch_jwks vira um falso.

O fim do arquivo confere as linhas de log da partida, da busca sob demanda e da
revalidação periódica: antes, um JWKS que faltava só aparecia como 401 para
quem tentava entrar.
"""
import asyncio
import logging
import time

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwk, jwt

from app import dependencies as deps
from app.config import settings


def _new_key(kid: str) -> tuple[str, dict]:
    """Par ES256: PEM privado (assina o token) e JWK público (vai no JWKS)."""
    private = ec.generate_private_key(ec.SECP256R1())
    private_pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = private.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    public_jwk = jwk.construct(public_pem, "ES256").to_dict()
    public_jwk["kid"] = kid
    return private_pem, public_jwk


def _claims() -> dict:
    return {"sub": "usuario-teste", "role": "authenticated", "exp": int(time.time()) + 300}


def _es256_token(private_pem: str, kid: str) -> str:
    return jwt.encode(_claims(), private_pem, algorithm="ES256", headers={"kid": kid})


async def _validate(token: str) -> dict:
    return await deps.get_current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials=token))


class _FakeFetch:
    """Substitui _fetch_jwks: conta as buscas e devolve o JWKS dado (None = Supabase fora do ar)."""

    def __init__(self, jwks: dict | None, delay: float = 0.0):
        self.jwks = jwks
        self.delay = delay
        self.calls = 0

    async def __call__(self) -> dict | None:
        self.calls += 1
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.jwks


@pytest.fixture(autouse=True)
def _clean_jwks_state(monkeypatch):
    monkeypatch.setattr(deps, "_jwks", None)
    monkeypatch.setattr(deps, "_jwks_last_on_demand", None)
    monkeypatch.setattr(deps, "_jwks_lock", asyncio.Lock())


@pytest.mark.asyncio
async def test_missing_jwks_is_fetched_and_token_accepted(monkeypatch):
    private_pem, public_jwk = _new_key("k1")
    fetch = _FakeFetch({"keys": [public_jwk]})
    monkeypatch.setattr(deps, "_fetch_jwks", fetch)

    claims = await _validate(_es256_token(private_pem, "k1"))

    assert claims["sub"] == "usuario-teste"
    assert fetch.calls == 1


@pytest.mark.asyncio
async def test_rotated_key_triggers_a_new_fetch(monkeypatch):
    _, old_jwk = _new_key("antiga")
    new_pem, new_jwk = _new_key("nova")
    monkeypatch.setattr(deps, "_jwks", {"keys": [old_jwk]})
    fetch = _FakeFetch({"keys": [old_jwk, new_jwk]})
    monkeypatch.setattr(deps, "_fetch_jwks", fetch)

    claims = await _validate(_es256_token(new_pem, "nova"))

    assert claims["sub"] == "usuario-teste"
    assert fetch.calls == 1


@pytest.mark.asyncio
async def test_supabase_down_answers_401_without_hammering(monkeypatch):
    private_pem, _ = _new_key("k1")
    fetch = _FakeFetch(None)
    monkeypatch.setattr(deps, "_fetch_jwks", fetch)

    for _ in range(3):
        with pytest.raises(HTTPException) as exc:
            await _validate(_es256_token(private_pem, "k1"))
        assert exc.value.status_code == 401
    assert fetch.calls == 1  # as outras caíram dentro do intervalo mínimo

    # Passado o intervalo mínimo, tenta de novo
    monkeypatch.setattr(
        deps, "_jwks_last_on_demand", time.monotonic() - deps._JWKS_ON_DEMAND_MIN_INTERVAL_SECS - 1
    )
    with pytest.raises(HTTPException):
        await _validate(_es256_token(private_pem, "k1"))
    assert fetch.calls == 2


@pytest.mark.asyncio
async def test_simultaneous_logins_share_one_fetch(monkeypatch):
    private_pem, public_jwk = _new_key("k1")
    fetch = _FakeFetch({"keys": [public_jwk]}, delay=0.05)
    monkeypatch.setattr(deps, "_fetch_jwks", fetch)

    results = await asyncio.gather(*(_validate(_es256_token(private_pem, "k1")) for _ in range(5)))

    assert all(r["sub"] == "usuario-teste" for r in results)
    assert fetch.calls == 1


@pytest.mark.asyncio
async def test_known_key_and_hs256_token_do_not_fetch(monkeypatch):
    private_pem, public_jwk = _new_key("k1")
    monkeypatch.setattr(deps, "_jwks", {"keys": [public_jwk]})
    fetch = _FakeFetch({"keys": [public_jwk]})
    monkeypatch.setattr(deps, "_fetch_jwks", fetch)

    await _validate(_es256_token(private_pem, "k1"))
    await _validate(jwt.encode(_claims(), settings.JWT_SECRET, algorithm="HS256"))

    assert fetch.calls == 0


@pytest.mark.asyncio
async def test_malformed_token_answers_401_without_fetching(monkeypatch):
    fetch = _FakeFetch(None)
    monkeypatch.setattr(deps, "_fetch_jwks", fetch)

    with pytest.raises(HTTPException) as exc:
        await _validate("isto-nao-e-um-jwt")

    assert exc.value.status_code == 401
    assert fetch.calls == 0


# ---------------------------------------------------------------------------
# Linhas de log
# ---------------------------------------------------------------------------

def _auth_messages(caplog, level: int) -> list[str]:
    return [r.getMessage() for r in caplog.records if r.name == "docke.auth" and r.levelno == level]


@pytest.mark.asyncio
async def test_startup_without_jwks_logs_warning(monkeypatch, caplog):
    fetch = _FakeFetch(None)
    monkeypatch.setattr(deps, "_fetch_jwks", fetch)

    await deps._load_jwks_at_startup(retry_delay=0)

    assert deps._jwks is None
    assert fetch.calls == 3
    assert any("depois de 3 tentativas" in m for m in _auth_messages(caplog, logging.WARNING))


@pytest.mark.asyncio
async def test_startup_with_jwks_logs_info(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="docke.auth")
    _, public_jwk = _new_key("k1")
    fetch = _FakeFetch({"keys": [public_jwk]})
    monkeypatch.setattr(deps, "_fetch_jwks", fetch)

    await deps._load_jwks_at_startup(retry_delay=0)

    assert deps._jwks == {"keys": [public_jwk]}
    assert fetch.calls == 1
    assert any("JWKS carregado na partida: 1 chave(s)" in m for m in _auth_messages(caplog, logging.INFO))
    assert not _auth_messages(caplog, logging.WARNING)


@pytest.mark.parametrize("payload", [["nao", "e", "um", "jwks"], {"keys": "nao e lista"}, {}])
def test_key_count_tolerates_unexpected_payloads(payload):
    assert deps._jwks_key_count(payload) == 0


@pytest.mark.asyncio
async def test_on_demand_fetch_logs_when_the_key_arrives(monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger="docke.auth")
    private_pem, public_jwk = _new_key("k1")
    monkeypatch.setattr(deps, "_fetch_jwks", _FakeFetch({"keys": [public_jwk]}))

    await _validate(_es256_token(private_pem, "k1"))

    assert any("a chave do token chegou" in m for m in _auth_messages(caplog, logging.INFO))


@pytest.mark.asyncio
async def test_on_demand_fetch_failure_logs_warning(monkeypatch, caplog):
    private_pem, _ = _new_key("k1")
    monkeypatch.setattr(deps, "_fetch_jwks", _FakeFetch(None))

    with pytest.raises(HTTPException):
        await _validate(_es256_token(private_pem, "k1"))

    assert any("sob demanda falhou" in m for m in _auth_messages(caplog, logging.WARNING))


@pytest.mark.asyncio
async def test_on_demand_fetch_without_the_key_logs_warning(monkeypatch, caplog):
    private_pem, _ = _new_key("inventada")
    _, other_jwk = _new_key("outra")
    monkeypatch.setattr(deps, "_fetch_jwks", _FakeFetch({"keys": [other_jwk]}))

    with pytest.raises(HTTPException):
        await _validate(_es256_token(private_pem, "inventada"))

    assert any("ainda sem a chave do token" in m for m in _auth_messages(caplog, logging.WARNING))


@pytest.mark.asyncio
async def test_periodic_refresh_failure_logs_warning(monkeypatch, caplog):
    class _FailOnceThenStop:
        """Falha na primeira volta do laço; na segunda, cancela para o teste terminar."""

        def __init__(self):
            self.calls = 0

        async def __call__(self) -> dict | None:
            self.calls += 1
            if self.calls > 1:
                raise asyncio.CancelledError
            return None

    monkeypatch.setattr(deps, "_fetch_jwks", _FailOnceThenStop())

    with pytest.raises(asyncio.CancelledError):
        await deps.jwks_refresh_loop(interval_secs=0)

    assert any("Revalidação periódica do JWKS falhou" in m for m in _auth_messages(caplog, logging.WARNING))
