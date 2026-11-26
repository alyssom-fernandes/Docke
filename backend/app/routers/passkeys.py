"""
Entrar com passkey (digital, rosto ou chave de segurança): B4.5.8 e B4.2.3.

Cadastro: logada, a pessoa cria a chave no aparelho (Ajustes → Segurança).
Login: o aparelho escolhe a chave e assina o desafio; conferida a assinatura,
o servidor abre a sessão do Supabase pelo link interno de administrador
(generate_link + verify, sem enviar e-mail). A sessão sai como a do login
por senha: a regra de MFA da empresa (app autenticador) continua valendo.
A conta demo não usa passkey (é compartilhada).
"""
import secrets
import time
from typing import Any
from urllib.parse import urlparse
from uuid import UUID

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.config import settings
from app.dependencies import get_current_user, get_db_admin
from app.services import mfa_service, rate_limit, webauthn

router = APIRouter(prefix="/auth/passkeys", tags=["auth"])

_TTL = 300
_desafios: dict[bytes, tuple[float, str | None]] = {}  # desafio → (vence em, user_id do cadastro)


def _origens() -> set[str]:
    return {o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()}


def _rp(request: Request) -> tuple[str, set[str]]:
    """rpId = o domínio do site que chamou, desde que seja uma origem permitida."""
    origem = request.headers.get("origin") or ""
    origens = _origens()
    if origem not in origens:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Origem não permitida para passkey.")
    return urlparse(origem).hostname or "", origens


def _novo_desafio(user_id: str | None) -> bytes:
    agora = time.time()
    for k in [k for k, (v, _) in _desafios.items() if v < agora]:
        _desafios.pop(k, None)
    d = secrets.token_bytes(32)
    _desafios[d] = (agora + _TTL, user_id)
    return d


def _usar_desafio(client_data_json: bytes, user_id: str | None) -> bytes:
    import json
    try:
        d = webauthn.ub64(json.loads(client_data_json)["challenge"])
    except Exception:
        raise HTTPException(status_code=400, detail="Resposta do aparelho inválida.")
    item = _desafios.pop(d, None)
    if item is None or item[0] < time.time() or item[1] != user_id:
        raise HTTPException(status_code=400, detail="O pedido expirou. Tente de novo.")
    return d


class RespostaCadastro(BaseModel):
    id: str = Field(..., max_length=1400)
    clientDataJSON: str = Field(..., max_length=4000)
    attestationObject: str = Field(..., max_length=20000)
    name: str | None = Field(None, max_length=80)


class RespostaLogin(BaseModel):
    id: str = Field(..., max_length=1400)
    clientDataJSON: str = Field(..., max_length=4000)
    authenticatorData: str = Field(..., max_length=4000)
    signature: str = Field(..., max_length=2000)


@router.post("/register/options")
async def opcoes_cadastro(
    request: Request,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if mfa_service.is_demo(claims):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Na demonstração não dá para cadastrar passkey: a conta é compartilhada.")
    rp_id, _ = _rp(request)
    u = await admin_conn.fetchrow("SELECT u.username, u.full_name FROM public.users u WHERE u.id = $1::uuid", claims["sub"])
    existentes = await admin_conn.fetch("SELECT credential_id FROM public.passkeys WHERE user_id = $1::uuid", claims["sub"])
    return {
        "challenge": webauthn.b64u(_novo_desafio(claims["sub"])),
        "rp": {"id": rp_id, "name": "Docke"},
        "user": {"id": webauthn.b64u(UUID(claims["sub"]).bytes), "name": u["username"] if u else claims["sub"], "displayName": (u["full_name"] if u else None) or "Docke"},
        "pubKeyCredParams": [{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -257}],
        "authenticatorSelection": {"residentKey": "required", "userVerification": "required"},
        "attestation": "none",
        "timeout": _TTL * 1000,
        "excludeCredentials": [{"type": "public-key", "id": r["credential_id"]} for r in existentes],
    }


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def cadastrar(
    body: RespostaCadastro,
    request: Request,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    rp_id, origens = _rp(request)
    cdj = webauthn.ub64(body.clientDataJSON)
    desafio = _usar_desafio(cdj, claims["sub"])
    try:
        dados = webauthn.cadastro(cdj, webauthn.ub64(body.attestationObject), desafio, rp_id, origens)
    except webauthn.ErroWebAuthn as e:
        raise HTTPException(status_code=400, detail=str(e))
    try:
        pid = await admin_conn.fetchval(
            "INSERT INTO public.passkeys (user_id, credential_id, public_key, sign_count, name) VALUES ($1::uuid, $2, $3, $4, $5) RETURNING id::text",
            claims["sub"], webauthn.b64u(dados.credential_id), dados.chave_cose, dados.sign_count, (body.name or "").strip() or "Este aparelho",
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Esta passkey já está cadastrada.")
    return {"id": pid}


@router.get("")
async def listar(admin_conn: asyncpg.Connection = Depends(get_db_admin), claims: dict[str, Any] = Depends(get_current_user)) -> list[dict[str, Any]]:
    rows = await admin_conn.fetch(
        "SELECT id::text, name, created_at, last_used_at FROM public.passkeys WHERE user_id = $1::uuid ORDER BY created_at", claims["sub"],
    )
    return [dict(r) for r in rows]


@router.delete("/{passkey_id}", status_code=status.HTTP_204_NO_CONTENT)
async def apagar(passkey_id: UUID, admin_conn: asyncpg.Connection = Depends(get_db_admin), claims: dict[str, Any] = Depends(get_current_user)) -> None:
    r = await admin_conn.execute("DELETE FROM public.passkeys WHERE id = $1 AND user_id = $2::uuid", passkey_id, claims["sub"])
    if r.endswith(" 0"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Passkey não encontrada.")


@router.post("/login/options")
async def opcoes_login(request: Request) -> dict[str, Any]:
    rp_id, _ = _rp(request)
    if not rate_limit.check_and_record(f"passkey-opt:{rate_limit.client_ip_hash(request)}", 30, 300):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Muitas tentativas. Espere alguns minutos.")
    return {"challenge": webauthn.b64u(_novo_desafio(None)), "rpId": rp_id, "userVerification": "required", "timeout": _TTL * 1000}


async def abrir_sessao(email: str) -> dict[str, Any]:
    """Sessão do Supabase sem senha: link interno de administrador conferido na hora (não manda e-mail)."""
    async with httpx.AsyncClient(timeout=10) as client:
        g = await client.post(
            f"{settings.SUPABASE_URL}/auth/v1/admin/generate_link",
            headers={"apikey": settings.SUPABASE_SERVICE_ROLE_KEY, "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}"},
            json={"type": "magiclink", "email": email},
        )
        if g.status_code != 200:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Não foi possível abrir a sessão agora. Tente de novo.")
        gd = g.json()
        hashed = gd.get("hashed_token") or (gd.get("properties") or {}).get("hashed_token")
        v = await client.post(
            f"{settings.SUPABASE_URL}/auth/v1/verify",
            headers={"apikey": settings.SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"type": "magiclink", "token_hash": hashed},
        )
    if v.status_code != 200:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Não foi possível abrir a sessão agora. Tente de novo.")
    return v.json()


@router.post("/login")
async def entrar(body: RespostaLogin, request: Request, admin_conn: asyncpg.Connection = Depends(get_db_admin)):
    from app.routers.auth import _CONTA_DESATIVADA, _login_response

    ip_key = f"passkey-ip:{rate_limit.client_ip_hash(request)}"
    if rate_limit.is_locked_out(ip_key):
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Muitas tentativas. Tente novamente em alguns minutos.")
    rp_id, origens = _rp(request)
    cdj = webauthn.ub64(body.clientDataJSON)
    desafio = _usar_desafio(cdj, None)
    pk = await admin_conn.fetchrow(
        """
        SELECT p.id, p.user_id::text, p.public_key, p.sign_count, a.email, u.is_active
        FROM public.passkeys p JOIN auth.users a ON a.id = p.user_id JOIN public.users u ON u.id = p.user_id
        WHERE p.credential_id = $1
        """,
        body.id,
    )
    if pk is None:
        rate_limit.record_failed_attempt(ip_key, 10, 900, 900)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Esta passkey não está cadastrada no Docke. Entre com a senha e cadastre em Ajustes → Segurança.")
    try:
        contador = webauthn.login(cdj, webauthn.ub64(body.authenticatorData), webauthn.ub64(body.signature), bytes(pk["public_key"]), desafio, rp_id, origens)
    except webauthn.ErroWebAuthn as e:
        rate_limit.record_failed_attempt(ip_key, 10, 900, 900)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(e))
    # Contador que volta atrás indica chave clonada (quando o aparelho usa contador).
    if contador and pk["sign_count"] and contador <= pk["sign_count"]:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Esta passkey parece copiada. Apague-a em Ajustes → Segurança e cadastre de novo.")
    if pk["is_active"] is False:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_CONTA_DESATIVADA)
    await admin_conn.execute("UPDATE public.passkeys SET sign_count = $2, last_used_at = now() WHERE id = $1", pk["id"], contador)
    return _login_response(await abrir_sessao(pk["email"]))
