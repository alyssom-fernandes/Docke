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


class LoginRequest(BaseModel):
    email: str  # Supabase Auth valida o formato — pydantic EmailStr rejeita TLDs privados (.local, .internal)
    password: str


class LoginResponse(BaseModel):
    access_token: str
    # Renovação silenciosa (achado A1-01): o access_token vale 1 h; o
    # refresh_token troca por um novo em POST /auth/refresh sem pedir senha.
    refresh_token: str | None = None
    token_type: str = "bearer"
    expires_in: int
    user: dict[str, Any]


_CONTA_DESATIVADA = "Esta conta foi desativada. Fale com o administrador da sua empresa."


async def _account_is_active(user_id: str | None) -> bool:
    """Conta desativada pelo admin (public.users.is_active) não entra nem renova."""
    if not user_id:
        return True
    from app.dependencies import _require_pool

    try:
        active = await _require_pool().fetchval("SELECT is_active FROM public.users WHERE id = $1", user_id)
    except Exception:
        return True
    return active is not False


def _login_response(data: dict[str, Any]) -> "LoginResponse":
    return LoginResponse(
        access_token=data["access_token"],
        refresh_token=data.get("refresh_token"),
        expires_in=data.get("expires_in", 3600),
        user=data.get("user", {}),
    )


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
    return await _do_login(body, request, email_key_override=None)


async def _do_login(body: LoginRequest, request: Request, *, email_key_override: str | None) -> LoginResponse:
    # DEMO_EMAIL é público (aparece no frontend) — se o bloqueio por e-mail
    # usasse o e-mail literal também pro modo demo, um atacante anônimo
    # conseguiria travar /auth/demo-login pra todo mundo por 15min só
    # mandando 5 senhas erradas pra "demo@docke.app" via /auth/login. O modo
    # demo usa uma chave própria, isolada do bucket do e-mail público.
    email_key = f"login-email:{email_key_override or body.email.lower().strip()}"
    ip_key = f"login-ip:{rate_limit.client_ip_hash(request)}"

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
        # resp.json() chamado uma única vez (evita parse duplicado) e protegido
        # contra corpo não-JSON (ex: 502 de um proxy na frente do Supabase) —
        # sem o try, isso derrubava um 401 limpo num 500 sem detalhe nenhum.
        try:
            payload = resp.json()
            detail = payload.get("error_description") or payload.get("msg") or "Credenciais inválidas"
        except ValueError:
            detail = "Credenciais inválidas"
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=detail,
            headers={"WWW-Authenticate": "Bearer"},
        )

    data = resp.json()
    if not await _account_is_active((data.get("user") or {}).get("id")):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_CONTA_DESATIVADA)
    return _login_response(data)


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/refresh", response_model=LoginResponse)
async def refresh(body: RefreshRequest, request: Request) -> LoginResponse:
    """
    Troca o refresh_token por um par novo (o Supabase gira o refresh_token a
    cada uso). Recusa conta desativada. 401 quando o refresh_token não vale
    mais (revogado no "Sair" ou pelo admin): o cliente pede a senha de novo.
    """
    ip_key = f"refresh-ip:{rate_limit.client_ip_hash(request)}"
    if rate_limit.is_locked_out(ip_key):
        raise HTTPException(status_code=status.HTTP_423_LOCKED, detail="Muitas tentativas. Tente novamente em alguns minutos.")
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token",
            headers={"apikey": settings.SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"refresh_token": body.refresh_token},
            timeout=10.0,
        )
    if resp.status_code != 200:
        rate_limit.record_failed_attempt(ip_key, 30, 60, 5 * 60)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sua sessão terminou. Entre de novo.")
    data = resp.json()
    if not await _account_is_active((data.get("user") or {}).get("id")):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_CONTA_DESATIVADA)
    return _login_response(data)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(credentials: HTTPAuthorizationCredentials = Depends(_bearer)) -> None:
    """Encerra a sessão no Supabase Auth (o refresh_token deixa de valer). Melhor esforço."""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{settings.SUPABASE_URL}/auth/v1/logout?scope=local",
                headers={"apikey": settings.SUPABASE_ANON_KEY, "Authorization": f"Bearer {credentials.credentials}"},
                timeout=10.0,
            )
    except Exception:
        pass


class ForgotPasswordRequest(BaseModel):
    email: str
    redirect_to: str | None = None


@router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED)
async def forgot_password(body: ForgotPasswordRequest, request: Request) -> dict[str, str]:
    """
    "Esqueci a senha" (achado A1-04): o Supabase Auth manda um e-mail com o
    link de redefinição. A resposta é sempre a mesma, exista ou não a conta,
    para ninguém descobrir quais e-mails têm cadastro. Limite por IP e por
    e-mail. A conta demo não troca senha.
    """
    email = body.email.strip().lower()
    for key in (f"forgot-ip:{rate_limit.client_ip_hash(request)}", f"forgot-email:{email}"):
        if rate_limit.is_locked_out(key):
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Muitos pedidos. Tente de novo em alguns minutos.")
        rate_limit.record_failed_attempt(key, 5, 15 * 60, 15 * 60)
    resposta = {"detail": "Se este e-mail tiver cadastro, enviamos um link para criar uma senha nova. Confira também a caixa de spam."}
    if not email or email == settings.DEMO_EMAIL.lower():
        return resposta
    redirect = body.redirect_to if body.redirect_to and body.redirect_to.startswith(tuple(settings.cors_origins_list)) else None
    try:
        async with httpx.AsyncClient() as client:
            await client.post(
                f"{settings.SUPABASE_URL}/auth/v1/recover",
                params={"redirect_to": redirect} if redirect else None,
                headers={"apikey": settings.SUPABASE_ANON_KEY, "Content-Type": "application/json"},
                json={"email": email},
                timeout=10.0,
            )
    except Exception:
        pass
    return resposta


class ResetPasswordRequest(BaseModel):
    access_token: str  # o token de recuperação que vem no link do e-mail
    new_password: str


@router.post("/reset-password")
async def reset_password(body: ResetPasswordRequest) -> dict[str, str]:
    """Grava a senha nova usando o token de recuperação do link do e-mail."""
    if len(body.new_password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A nova senha deve ter no mínimo 8 caracteres.")
    async with httpx.AsyncClient() as client:
        resp = await client.put(
            f"{settings.SUPABASE_URL}/auth/v1/user",
            headers={
                "apikey": settings.SUPABASE_ANON_KEY,
                "Authorization": f"Bearer {body.access_token}",
                "Content-Type": "application/json",
            },
            json={"password": body.new_password},
            timeout=10.0,
        )
    if resp.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail='O link venceu ou já foi usado. Peça um novo em "Esqueci a senha".',
        )
    if resp.status_code != 200:
        try:
            msg = (resp.json().get("msg") or resp.json().get("error_description") or "").lower()
        except ValueError:
            msg = ""
        detail = (
            "A senha nova é igual à anterior. Escolha outra." if "different" in msg
            else "Não foi possível gravar a senha nova. Tente de novo."
        )
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)
    return {"status": "ok"}


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
    return await _do_login(
        LoginRequest(email=settings.DEMO_EMAIL, password=settings.DEMO_PASSWORD),
        request,
        email_key_override="__demo__",
    )


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
# PATCH /auth/me — Fase 10.3: atualiza o próprio perfil (só full_name por
# ora). Antes, "Salvar alterações" em Perfil.tsx era decorativo — nunca
# chamava a API, só mostrava um toast falso depois de um setTimeout.
# ---------------------------------------------------------------------------

class UpdateProfileRequest(BaseModel):
    full_name: str


@router.patch("/me")
async def update_me(
    body: UpdateProfileRequest,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    full_name = body.full_name.strip()
    if not full_name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nome completo não pode ficar vazio.")

    row = await AuthService.update_own_profile(conn, full_name=full_name)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuário não encontrado.")
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
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, str]:
    """
    Troca a senha do usuário autenticado.
    Exige a senha atual: reautentica contra o Supabase Auth antes de aceitar a
    nova senha, para não permitir troca com apenas um token de sessão roubado.

    Mesmo bloqueio por e-mail+IP do /auth/login: sem isso, alguém com um token
    de sessão válido (XSS, dispositivo roubado) mas sem a senha poderia tentar
    senhas indefinidamente contra esta rota pra descobri-la.
    """
    if len(body.new_password) < 8:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A nova senha deve ter no mínimo 8 caracteres.")

    email = await AuthService.get_current_email(conn)
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Não foi possível identificar o e-mail da conta.")

    # A conta demo é compartilhada por todos os visitantes: quem trocasse a
    # senha travaria o botão "Explorar a demonstração" para os demais até o
    # próximo reset. A senha dela só muda pelo Fly secret DEMO_PASSWORD.
    if email.lower().strip() == settings.DEMO_EMAIL.lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="A conta de demonstração não permite trocar a senha.")

    email_key = f"login-email:{email.lower().strip()}"
    ip_key = f"login-ip:{rate_limit.client_ip_hash(request)}"
    for key in (email_key, ip_key):
        locked = rate_limit.is_locked_out(key)
        if locked:
            raise HTTPException(
                status_code=status.HTTP_423_LOCKED,
                detail=f"Muitas tentativas. Tente novamente em {int(locked // 60) + 1} minuto(s).",
            )

    async with httpx.AsyncClient() as client:
        verify = await client.post(
            f"{settings.SUPABASE_URL}/auth/v1/token?grant_type=password",
            headers={"apikey": settings.SUPABASE_ANON_KEY, "Content-Type": "application/json"},
            json={"email": email, "password": body.current_password},
            timeout=10.0,
        )
        if verify.status_code != 200:
            rate_limit.record_failed_attempt(email_key, _LOGIN_ATTEMPTS, _LOGIN_WINDOW_SECS, _LOGIN_LOCKOUT_SECS)
            rate_limit.record_failed_attempt(ip_key, _LOGIN_ATTEMPTS, _LOGIN_WINDOW_SECS, _LOGIN_LOCKOUT_SECS)
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
