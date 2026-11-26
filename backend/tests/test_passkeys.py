"""Passkey: cadastro, login com assinatura conferida e recusas (B4.5.8, B4.2.3)."""
import hashlib
import json
import struct
import uuid
from unittest.mock import AsyncMock, patch

import asyncpg
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec

from app.services.webauthn import b64u, ub64
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"
ORIGEM = "http://localhost:5173"


def _cbor(v) -> bytes:
    """Codificador CBOR mínimo para montar o atestado de teste."""
    def cab(tipo, n):
        if n < 24:
            return bytes([tipo << 5 | n])
        if n < 256:
            return bytes([tipo << 5 | 24, n])
        return bytes([tipo << 5 | 25]) + n.to_bytes(2, "big")
    if isinstance(v, int):
        return cab(0, v) if v >= 0 else cab(1, -1 - v)
    if isinstance(v, bytes):
        return cab(2, len(v)) + v
    if isinstance(v, str):
        return cab(3, len(v.encode())) + v.encode()
    if isinstance(v, dict):
        return cab(5, len(v)) + b"".join(_cbor(k) + _cbor(x) for k, x in v.items())
    raise TypeError(v)


class Aparelho:
    def __init__(self):
        self.chave = ec.generate_private_key(ec.SECP256R1())
        self.cred = uuid.uuid4().bytes
        self.contador = 0

    def cose(self) -> bytes:
        n = self.chave.public_key().public_numbers()
        return _cbor({1: 2, 3: -7, -1: 1, -2: n.x.to_bytes(32, "big"), -3: n.y.to_bytes(32, "big")})

    def auth_data(self, com_chave=False, uv=True) -> bytes:
        self.contador += 1
        flags = 0x01 | (0x04 if uv else 0) | (0x40 if com_chave else 0)
        ad = hashlib.sha256(b"localhost").digest() + bytes([flags]) + struct.pack(">I", self.contador)
        if com_chave:
            ad += bytes(16) + struct.pack(">H", len(self.cred)) + self.cred + self.cose()
        return ad

    def criar(self, desafio: str) -> dict:
        cdj = json.dumps({"type": "webauthn.create", "challenge": desafio, "origin": ORIGEM}).encode()
        att = _cbor({"fmt": "none", "attStmt": {}, "authData": self.auth_data(com_chave=True)})
        return {"id": b64u(self.cred), "clientDataJSON": b64u(cdj), "attestationObject": b64u(att), "name": "Celular"}

    def assinar(self, desafio: str, uv=True) -> dict:
        cdj = json.dumps({"type": "webauthn.get", "challenge": desafio, "origin": ORIGEM}).encode()
        ad = self.auth_data(uv=uv)
        sig = self.chave.sign(ad + hashlib.sha256(cdj).digest(), ec.ECDSA(hashes.SHA256()))
        return {"id": b64u(self.cred), "clientDataJSON": b64u(cdj), "authenticatorData": b64u(ad), "signature": b64u(sig)}


@pytest_asyncio.fixture(loop_scope="session")
async def pessoa(admin: asyncpg.Connection):
    uid = str(uuid.uuid4())
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Pessoa Passkey', 'usuario')", uid, f"k_{uid[:6]}")
    yield uid
    await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_cadastro_e_login_com_passkey(api, admin, pessoa):  # noqa: F811
    h = {**_token(pessoa), "Origin": ORIGEM}
    cel = Aparelho()
    op = (await api.post(API + "/auth/passkeys/register/options", headers=h)).json()
    assert op["rp"]["id"] == "localhost" and op["authenticatorSelection"]["userVerification"] == "required"
    r = await api.post(API + "/auth/passkeys/register", json=cel.criar(op["challenge"]), headers=h)
    assert r.status_code == 201, r.text
    # O mesmo desafio não vale duas vezes.
    assert (await api.post(API + "/auth/passkeys/register", json=cel.criar(op["challenge"]), headers=h)).status_code == 400

    sessao = {"access_token": "a", "refresh_token": "r", "expires_in": 3600, "user": {"id": pessoa}}
    with patch("app.routers.passkeys.abrir_sessao", AsyncMock(return_value=sessao)) as abrir:
        ol = (await api.post(API + "/auth/passkeys/login/options", headers={"Origin": ORIGEM})).json()
        r = await api.post(API + "/auth/passkeys/login", json=cel.assinar(ol["challenge"]), headers={"Origin": ORIGEM})
        assert r.status_code == 200, r.text
        assert r.json()["access_token"] == "a" and abrir.await_args.args[0] == f"{pessoa[:8]}@test.local"

        # Sem a digital/rosto (UV) não entra; assinatura de outra chave também não.
        ol = (await api.post(API + "/auth/passkeys/login/options", headers={"Origin": ORIGEM})).json()
        assert (await api.post(API + "/auth/passkeys/login", json=cel.assinar(ol["challenge"], uv=False), headers={"Origin": ORIGEM})).status_code == 401
        ol = (await api.post(API + "/auth/passkeys/login/options", headers={"Origin": ORIGEM})).json()
        falsa = cel.assinar(ol["challenge"])
        outro = Aparelho()
        falsa["signature"] = b64u(outro.chave.sign(b"x", ec.ECDSA(hashes.SHA256())))
        assert (await api.post(API + "/auth/passkeys/login", json=falsa, headers={"Origin": ORIGEM})).status_code == 401
    # Origem estranha é recusada.
    assert (await api.post(API + "/auth/passkeys/login/options", headers={"Origin": "https://golpe.example"})).status_code == 400
    lista = (await api.get(API + "/auth/passkeys", headers=h)).json()
    assert lista[0]["name"] == "Celular" and lista[0]["last_used_at"]
    assert ub64(b64u(b"ok")) == b"ok"
