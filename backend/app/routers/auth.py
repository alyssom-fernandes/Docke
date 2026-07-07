import hashlib
from typing import Any

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.config import settings
from app.dependencies import get_current_user, get_db
from app.services import rate_limit
from app.services.auth_service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])
_bearer = HTTPBearer()

# Mesma janela/limite usados em shares.py (_PASSWORD_ATTEMPTS/_PASSWORD_WINDOW_SECS)
# para bloqueio de senha errada em link compartilhado — reaproveitado aqui para
# não deixar /auth/login como o único ponto de entrada sem proteção a brute-force.
_LOGIN_ATTEMPTS = 5
_LOGIN_WINDOW_SECS = 60
_LOGIN_LOCKOUT_SECS = 15 * 60


def _client_ip_hash(request: Request) -> str:
    ip = request.client.host if request.client else "unknown"
    return hashlib.sha256(ip.encode()).hexdigest()


class LoginRequest(BaseModel):
    email: str  # Supabase Auth valida o formato — pydantic EmailStr rejeita TLDs privados (.local, .internal)
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: dict[str, Any]


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, request: Request) -> LoginResponse:
    """
    Autentica via Supabase Auth (não reimplementamos JWT — delegamos ao Supabase).
    Retorna o access_token que o cliente deve usar em todos os outros endpoints.

    Bloqueio por e-mail E por IP (o que disparar primeiro) — protege tanto contra
    um atacante tentando várias senhas numa conta quanto contra um atacante
    tentando várias contas a partir do mesmo IP. Mesmos limites usados em
    shares.py para senha de link compartilhado, por consistência.
    """
    email_key = f"login-email:{body.email.lower().strip()}"
    ip_key = f"login-ip:{_client_ip_hash(request)}"

    for key in (email_key, ip_key):
        locked = rate_limit.is_locked_out(key)
        if locked:
            raise HTTPException(
                status_code=status.HTTP_423_LOCKED,
                detail=f"Muitas tentativas. Tente novamente em {int(locked // 60) + 1} minuto(s).",
            )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.SUPABASE_URL}/auth/v1/token?grant_type=password",
            headers={
                "apikey": settings.SUPABASE_ANON_KEY,
                "Content-Type": "application/json",
            },
            json={"email": body.email, "password": body.password},
            timeout=10.0,
        )

    if resp.status_code != 200:
        rate_limit.record_failed_attempt(email_key, _LOGIN_ATTEMPTS, _LOGIN_WINDOW_SECS, _LOGIN_LOCKOUT_SECS)
        rate_limit.record_failed_attempt(ip_key, _LOGIN_ATTEMPTS, _LOGIN_WINDOW_SECS, _LOGIN_LOCKOUT_SECS)
        detail = resp.json().get("error_description") or resp.json().get("msg") or "Credenciais inválidas"
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=detail,
            headers={"WWW-Authenticate": "Bearer"},
        )

    data = resp.json()
    return LoginResponse(
        access_token=data["access_token"],
        expires_in=data.get("expires_in", 3600),
        user=data.get("user", {}),
    )


@router.post("/demo-login", response_model=LoginResponse)
async def demo_login(request: Request) -> LoginResponse:
    """
    Login do modo demo — a senha nunca aparece no frontend nem em nenhum
    arquivo commitado, fica só em DEMO_PASSWORD (Fly secret). Usado pelo
    botão "Acessar modo demo" no login e pela renovação automática de sessão
    quando o token da conta demo expira.
    """
    if not settings.DEMO_PASSWORD:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Modo demo não está configurado.")
    return await login(LoginRequest(email=settings.DEMO_EMAIL, password=settings.DEMO_PASSWORD), request)


@router.get("/me")
async def get_me(
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Retorna o usuário autenticado.
    Verifica que auth.uid() via set_config está funcionando corretamente.
    """
    row = await AuthService.get_current_user_row(conn)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Usuário não encontrado no banco. Verifique se o cadastro foi sincronizado.",
        )
    return dict(row)


# ---------------------------------------------------------------------------
# POST /auth/change-password — troca de senha (ADR-015, seção Segurança)
# ---------------------------------------------------------------------------

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
async def change_password(
    body: ChangePasswordRequest,
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """
    Troca a senha do usuário autenticado.
    Exige a senha atual: reautentica contra o Supabase Auth antes de aceitar a
    nova senha, para não permitir troca com apenas um token de sessão roubado.
    """
    if len(body.new_password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A nova senha deve ter no mínimo 8 caracteres.")

    email = await AuthService.get_current_email(conn)
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Não foi possível identificar o e-mail da conta.")

    async with httpx.AsyncClient() as client:
        verify = await client.post(
            f"{settings.SUPABASE_URL}/auth/v1/token?grant_type=password",
            headers={"apikey": settings.SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"email": email, "password": body.current_password},
            timeout=10.0,
        )
        if verify.status_code != 200:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Senha atual incorreta.")

        update = await client.put(
            f"{settings.SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": settings.SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {credentials.credentials}",
                "Content-Type": "application/json",
            },
            json={"password": body.new_password},
            timeout=10.0,
        )
        if update.status_code != 200:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Não foi possível atualizar a senha.")

    return {"status": "ok"}
