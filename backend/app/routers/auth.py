from typing import Any

import asyncpg
import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import settings
from app.dependencies import get_current_user, get_db

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: str  # Supabase Auth valida o formato — pydantic EmailStr rejeita TLDs privados (.local, .internal)
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: dict[str, Any]


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest) -> LoginResponse:
    """
    Autentica via Supabase Auth (não reimplementamos JWT — delegamos ao Supabase).
    Retorna o access_token que o cliente deve usar em todos os outros endpoints.
    """
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


@router.get("/me")
async def get_me(
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Retorna o usuário autenticado.
    Verifica que auth.uid() via set_config está funcionando corretamente.
    """
    row = await conn.fetchrow(
        """
        SELECT
          auth.uid()::text  AS uid_from_rls,
          u.id::text        AS user_id,
          u.username,
          u.full_name,
          u.role,
          u.is_active
        FROM public.users u
        WHERE u.id = auth.uid()
        """
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Usuário não encontrado no banco. Verifique se o cadastro foi sincronizado.",
        )
    return dict(row)
