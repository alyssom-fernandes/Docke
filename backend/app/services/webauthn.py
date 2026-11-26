"""
WebAuthn (passkey: digital, rosto ou chave de segurança) sem biblioteca extra
(decisão do dono 26/11, B4.5.8 e B4.2.3). Só o necessário para o Docke:

- cadastro com atestado "none" (não pedimos o fabricante do aparelho);
- chaves ES256 (alg -7) e RS256 (alg -257), que cobrem Android, iPhone,
  Windows Hello e chaves físicas;
- login sem digitar e-mail (credencial "descoberta" pelo aparelho).

O que se confere: tipo e desafio no clientDataJSON, origem permitida, hash do
rpId, presença e verificação do usuário (flags UP e UV) e a assinatura sobre
authenticatorData || SHA-256(clientDataJSON) com a chave guardada no cadastro.
"""
import base64
import hashlib
import json
import struct
from dataclasses import dataclass

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa


class ErroWebAuthn(ValueError):
    pass


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def ub64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# --- CBOR mínimo (RFC 8949): inteiros, bytes, texto, listas, mapas e simples --

def _cbor(data: bytes, i: int = 0):
    ini = data[i]
    tipo, info = ini >> 5, ini & 0x1F
    i += 1
    if info < 24:
        n = info
    elif info in (24, 25, 26, 27):
        tam = {24: 1, 25: 2, 26: 4, 27: 8}[info]
        n = int.from_bytes(data[i:i + tam], "big")
        i += tam
    else:
        raise ErroWebAuthn("CBOR com tamanho indefinido não é aceito.")
    if tipo == 0:
        return n, i
    if tipo == 1:
        return -1 - n, i
    if tipo == 2:
        return data[i:i + n], i + n
    if tipo == 3:
        return data[i:i + n].decode(), i + n
    if tipo == 4:
        out = []
        for _ in range(n):
            v, i = _cbor(data, i)
            out.append(v)
        return out, i
    if tipo == 5:
        out = {}
        for _ in range(n):
            k, i = _cbor(data, i)
            v, i = _cbor(data, i)
            out[k] = v
        return out, i
    if tipo == 7:
        return {20: False, 21: True, 22: None}.get(info), i
    raise ErroWebAuthn("CBOR com tipo não suportado.")


def cbor(data: bytes):
    return _cbor(data, 0)[0]


@dataclass
class DadosAutenticador:
    rp_id_hash: bytes
    flags: int
    sign_count: int
    credential_id: bytes | None = None
    chave_cose: bytes | None = None


def ler_auth_data(ad: bytes) -> DadosAutenticador:
    if len(ad) < 37:
        raise ErroWebAuthn("authenticatorData curto demais.")
    out = DadosAutenticador(ad[:32], ad[32], struct.unpack(">I", ad[33:37])[0])
    if out.flags & 0x40:  # AT: dados da credencial anexados (cadastro)
        n = struct.unpack(">H", ad[53:55])[0]
        out.credential_id = ad[55:55 + n]
        _, fim = _cbor(ad, 55 + n)
        out.chave_cose = ad[55 + n:fim]
    return out


def _cliente(client_data_json: bytes, tipo: str, desafio: bytes, origens: set[str]) -> str:
    try:
        cd = json.loads(client_data_json)
    except ValueError:
        raise ErroWebAuthn("clientDataJSON inválido.")
    if cd.get("type") != tipo:
        raise ErroWebAuthn("Tipo de operação inesperado.")
    if cd.get("challenge") != b64u(desafio):
        raise ErroWebAuthn("Desafio não confere (expirou ou foi trocado).")
    if cd.get("origin") not in origens:
        raise ErroWebAuthn("Origem não permitida.")
    return cd["origin"]


def _conferir_flags(dados: DadosAutenticador, rp_id: str) -> None:
    if dados.rp_id_hash != hashlib.sha256(rp_id.encode()).digest():
        raise ErroWebAuthn("A chave é de outro site.")
    if not dados.flags & 0x01:
        raise ErroWebAuthn("Sem presença do usuário.")
    if not dados.flags & 0x04:
        raise ErroWebAuthn("O aparelho não confirmou a digital, o rosto ou o PIN.")


def cadastro(client_data_json: bytes, attestation_object: bytes, desafio: bytes, rp_id: str, origens: set[str]) -> DadosAutenticador:
    _cliente(client_data_json, "webauthn.create", desafio, origens)
    att = cbor(attestation_object)
    dados = ler_auth_data(att["authData"])
    _conferir_flags(dados, rp_id)
    if not dados.credential_id or not dados.chave_cose:
        raise ErroWebAuthn("O aparelho não devolveu a chave.")
    chave_publica(dados.chave_cose)  # recusa algoritmo não suportado já no cadastro
    return dados


def chave_publica(cose: bytes):
    k = cbor(cose)
    alg = k.get(3)
    if k.get(1) == 2 and alg == -7 and k.get(-1) == 1:
        return ec.EllipticCurvePublicNumbers(int.from_bytes(k[-2], "big"), int.from_bytes(k[-3], "big"), ec.SECP256R1()).public_key()
    if k.get(1) == 3 and alg == -257:
        return rsa.RSAPublicNumbers(int.from_bytes(k[-2], "big"), int.from_bytes(k[-1], "big")).public_key()
    raise ErroWebAuthn("Tipo de chave não suportado (use ES256 ou RS256).")


def login(client_data_json: bytes, auth_data: bytes, assinatura: bytes, cose: bytes, desafio: bytes, rp_id: str, origens: set[str]) -> int:
    """Confere o login; devolve o novo contador de assinaturas."""
    _cliente(client_data_json, "webauthn.get", desafio, origens)
    dados = ler_auth_data(auth_data)
    _conferir_flags(dados, rp_id)
    mensagem = auth_data + hashlib.sha256(client_data_json).digest()
    chave = chave_publica(cose)
    try:
        if isinstance(chave, ec.EllipticCurvePublicKey):
            chave.verify(assinatura, mensagem, ec.ECDSA(hashes.SHA256()))
        else:
            chave.verify(assinatura, mensagem, padding.PKCS1v15(), hashes.SHA256())
    except InvalidSignature:
        raise ErroWebAuthn("Assinatura não confere.")
    return dados.sign_count
