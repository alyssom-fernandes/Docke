"""
Web Push sem biblioteca extra (decisão do dono 26/11: push no celular, sem
serviço pago). Implementa o que o navegador exige:

- RFC 8291: o conteúdo vai cifrado (ECDH P-256 + HKDF + AES-128-GCM,
  codificação "aes128gcm") com as chaves que o navegador deu na inscrição;
- RFC 8292 (VAPID): o servidor se identifica com um JWT ES256 assinado pela
  chave privada do Docke (VAPID_PRIVATE_KEY), cuja pública vai ao navegador.

O serviço de push (Google, Apple, Mozilla) só vê o conteúdo cifrado.
"""
import base64
import json
import os
import struct
import time
from urllib.parse import urlparse

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

_PONTO = serialization.Encoding.X962
_FORMATO = serialization.PublicFormat.UncompressedPoint
# Quem envia (VAPID "sub"): o endereço do app, sem dado pessoal.
SUB = "https://docke-two.vercel.app"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def ub64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def gerar_chaves() -> tuple[str, str]:
    """(privada, pública) em base64url: 32 bytes do escalar e o ponto não comprimido de 65 bytes."""
    k = ec.generate_private_key(ec.SECP256R1())
    priv = k.private_numbers().private_value.to_bytes(32, "big")
    return b64u(priv), b64u(k.public_key().public_bytes(_PONTO, _FORMATO))


def _hkdf(salt: bytes, ikm: bytes, info: bytes, n: int) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=n, salt=salt, info=info).derive(ikm)


def cifrar(conteudo: bytes, p256dh: str, auth: str, *, chave_servidor=None, salt: bytes | None = None) -> bytes:
    """Corpo "aes128gcm" (RFC 8291 §4 e RFC 8188). chave_servidor/salt só para teste."""
    ua_pub = ub64(p256dh)
    segredo = ub64(auth)
    as_priv = chave_servidor or ec.generate_private_key(ec.SECP256R1())
    as_pub = as_priv.public_key().public_bytes(_PONTO, _FORMATO)
    compartilhado = as_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), ua_pub))
    ikm = _hkdf(segredo, compartilhado, b"WebPush: info\x00" + ua_pub + as_pub, 32)
    salt = salt or os.urandom(16)
    cek = _hkdf(salt, ikm, b"Content-Encoding: aes128gcm\x00", 16)
    nonce = _hkdf(salt, ikm, b"Content-Encoding: nonce\x00", 12)
    cifrado = AESGCM(cek).encrypt(nonce, conteudo + b"\x02", None)  # \x02 = último registro, sem enchimento
    return salt + struct.pack(">I", 4096) + bytes([len(as_pub)]) + as_pub + cifrado


def cabecalho_vapid(endpoint: str, privada: str, publica: str) -> str:
    u = urlparse(endpoint)
    topo = b64u(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    corpo = b64u(json.dumps({"aud": f"{u.scheme}://{u.netloc}", "exp": int(time.time()) + 12 * 3600, "sub": SUB}, separators=(",", ":")).encode())
    entrada = f"{topo}.{corpo}".encode()
    chave = ec.derive_private_key(int.from_bytes(ub64(privada), "big"), ec.SECP256R1())
    r, s = decode_dss_signature(chave.sign(entrada, ec.ECDSA(hashes.SHA256())))
    return f"vapid t={entrada.decode()}.{b64u(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}, k={publica}"


async def enviar(client: httpx.AsyncClient, inscricao: dict, mensagem: dict, privada: str, publica: str) -> int:
    """Envia um aviso; devolve o status HTTP do serviço de push (404/410 = inscrição morta)."""
    corpo = cifrar(json.dumps(mensagem, ensure_ascii=False).encode(), inscricao["p256dh"], inscricao["auth"])
    r = await client.post(
        inscricao["endpoint"], content=corpo,
        headers={"Authorization": cabecalho_vapid(inscricao["endpoint"], privada, publica), "Content-Encoding": "aes128gcm",
                 "Content-Type": "application/octet-stream", "TTL": "86400", "Urgency": "normal"},
    )
    return r.status_code
