"""
FastAPI dependencies — pool asyncpg + JWT → RLS.

get_db       — conexão com JWT do usuário repassado ao Postgres via set_config.
get_db_admin — conexão como superuser (bypassa RLS) para jobs administrativos.
get_current_user — valida JWT e retorna claims do usuário.
"""
import json
from typing import AsyncGenerator, Any

import asyncpg
import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import settings

_bearer = HTTPBearer()
_pool: asyncpg.Pool | None = None
_admin_pool: asyncpg.Pool | None = None  # alias para o worker OCR (service_role, mesma pool)
_jwks: dict | None = None  # JWKS do Supabase Auth (ES256)


# ---------------------------------------------------------------------------
# Pool lifecycle — chamado pelo lifespan de main.py
# ---------------------------------------------------------------------------

async def init_db_pool() -> None:
    global _pool, _admin_pool, _jwks
    _pool = await asyncpg.create_pool(
        settings.asyncpg_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
    )
    # Busca chaves públicas do Supabase Auth para verificar tokens ES256
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{settings.SUPABASE_URL}/auth/v1/.well-known/jwks.json",
                timeout=5.0,
            )
            if resp.status_code == 200:
                _jwks = resp.json()
    except Exception:
        _jwks = None  # Supabase não disponível — fallback para HS256
    _admin_pool = _pool  # mesma pool — worker usa service_role sem SET LOCAL role


async def close_db_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None


def _require_pool() -> asyncpg.Pool:
    if _pool is None:
        raise RuntimeError("Pool asyncpg não inicializado. init_db_pool() não foi chamado.")
    return _pool


# ---------------------------------------------------------------------------
# JWT validation — suporta ES256 (Supabase Auth) e HS256 (tokens de teste)
# ---------------------------------------------------------------------------

def _decode_jwt(token: str) -> dict[str, Any]:
    """
    Valida e decodifica o JWT do Supabase.
    Tenta ES256 via JWKS primeiro (tokens emitidos pelo Supabase Auth).
    Fallback para HS256 com JWT_SECRET (tokens de serviço e testes locais).
    """
    # Tenta ES256 via JWKS (tokens de usuário do Supabase Auth)
    if _jwks:
        try:
            return jwt.decode(
                token,
                _jwks,
                algorithms=["ES256"],
                options={"verify_aud": False},
            )
        except JWTError:
            pass

    # Fallback: HS256 com JWT_SECRET (service role, anon key, tokens de teste)
    try:
        return jwt.decode(
            token,
            settings.JWT_SECRET,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
    except JWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Token inválido: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict[str, Any]:
    """Valida JWT e retorna os claims. Usado por rotas que precisam do usuário mas não do banco."""
    return _decode_jwt(credentials.credentials)


async def get_db(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> AsyncGenerator[asyncpg.Connection, None]:
    """
    Conexão asyncpg com identidade do usuário injetada via set_config.
    O Postgres passa esses valores para auth.uid() dentro das RLS policies.

    SET LOCAL e set_config(local=true) só persistem dentro de uma transação
    explícita — por isso toda a request é envolvida em uma transaction.
    """
    claims = _decode_jwt(credentials.credentials)
    pool = _require_pool()

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Replica o que o PostgREST faz internamente:
            # seta request.jwt.claims para que auth.uid() retorne claims['sub']
            await conn.execute(
                "SELECT set_config('request.jwt.claims', $1, true)",
                json.dumps(claims),
            )
            # Troca o role para que o RLS se aplique (LOCAL = apenas nesta transação)
            await conn.execute("SET LOCAL role TO authenticated")
            yield conn


async def get_db_admin() -> AsyncGenerator[asyncpg.Connection, None]:
    """
    Conexão asyncpg como superuser (postgres).
    Bypassa RLS — use apenas para jobs do worker OCR e admin.
    Invariante I4: nunca exponha esta connection em rotas do usuário.
    """
    pool = _require_pool()
    async with pool.acquire() as conn:
        yield conn
