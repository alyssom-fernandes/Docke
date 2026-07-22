"""
FastAPI dependencies — pool asyncpg + JWT → RLS.

get_db       — conexão com JWT do usuário repassado ao Postgres via set_config.
get_db_admin — conexão como superuser (bypassa RLS) para jobs administrativos.
get_current_user — valida JWT e retorna claims do usuário.
"""
import json
import uuid
from typing import AsyncGenerator, Any

import asyncpg
import httpx
from fastapi import Depends, HTTPException, Request, status
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

async def _fetch_jwks() -> dict | None:
    """Busca o JWKS atual do Supabase Auth. Retorna None em falha (chamador decide o fallback)."""
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{settings.SUPABASE_URL}/auth/v1/.well-known/jwks.json",
                timeout=5.0,
            )
            if resp.status_code == 200:
                return resp.json()
    except Exception:
        pass
    return None


async def jwks_refresh_loop(interval_secs: int = 3600) -> None:
    """
    Revalida o JWKS periodicamente (padrão: a cada 1h). Sem isso, uma rotação
    de chave no Supabase Auth (planejada ou de emergência) faz todo token ES256
    cair no fallback HS256 e falhar com 401 até o próximo redeploy — outage
    silencioso, sem nenhum sinal além dos usuários não conseguirem logar.
    """
    global _jwks
    import asyncio
    while True:
        try:
            await asyncio.sleep(interval_secs)
            fresh = await _fetch_jwks()
            if fresh is not None:
                _jwks = fresh
        except asyncio.CancelledError:
            raise
        except Exception:
            pass  # mantém o _jwks anterior; tenta de novo no próximo ciclo


async def init_db_pool() -> None:
    global _pool, _admin_pool, _jwks
    _pool = await asyncpg.create_pool(
        settings.asyncpg_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
    )
    # Busca chaves públicas do Supabase Auth para verificar tokens ES256.
    # Algumas tentativas com espera curta: se o backend sobe antes do serviço
    # de Auth estar pronto (comum em `docker compose`/`supabase start` local,
    # onde os containers não têm ordem de prontidão garantida), uma falha na
    # primeira tentativa deixava _jwks preso em None pro resto da vida do
    # processo — todo token real (ES256) passava a ser rejeitado com "alg not
    # allowed" até o próximo restart, um bug intermitente difícil de notar.
    import asyncio
    for attempt in range(3):
        fresh = await _fetch_jwks()
        if fresh is not None:
            _jwks = fresh
            break
        if attempt < 2:
            await asyncio.sleep(1.5)
    # Se todas as tentativas falharem, _jwks permanece None e o fallback HS256
    # assume — correto pra ambientes que genuinamente não usam Supabase Auth.
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


def _client_ip(request: Request) -> str:
    """IP real do cliente — mesma lógica de rate_limit.client_ip_hash, mas sem
    hashear: aqui é pra auditoria (activity_log.ip), não chave de rate-limit."""
    return request.headers.get("fly-client-ip") or (request.client.host if request.client else "unknown")


async def get_db(
    request: Request,
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

            # Fase 2.2: contexto da requisição pra activity_log — nenhum service
            # precisa saber disso, o trigger de INSERT lê daqui sozinho
            # (current_setting). correlation_id é o do header, se o chamador
            # já estiver encadeando uma operação maior; senão, é o próprio
            # request_id (a requisição é sua própria correlação raiz).
            request_id = str(uuid.uuid4())
            correlation_id = request.headers.get("x-correlation-id") or request_id
            await conn.execute("SELECT set_config('request.id', $1, true)", request_id)
            await conn.execute("SELECT set_config('request.correlation_id', $1, true)", correlation_id)
            await conn.execute("SELECT set_config('request.ip', $1, true)", _client_ip(request))
            await conn.execute("SELECT set_config('request.user_agent', $1, true)", request.headers.get("user-agent") or "")

            yield conn


async def get_db_admin(request: Request) -> AsyncGenerator[asyncpg.Connection, None]:
    """
    Conexão asyncpg como superuser (postgres).
    Bypassa RLS — use apenas para jobs do worker OCR e admin.
    Invariante I4: nunca exponha esta connection em rotas do usuário.

    Só é chamada via Depends() em rotas HTTP (workers usam _admin_pool
    diretamente, sem passar por esta função) — Request sempre existe aqui.

    Diferente de get_db, NÃO envolve isso numa transaction — várias rotas
    admin dependem do comportamento autocommit-por-statement de hoje, e
    mudar isso é um refactor à parte. Por isso o set_config aqui é
    session-scoped (false, não LOCAL) e precisa de limpeza manual no finally
    — senão o contexto desta requisição vazaria pra próxima que reusar esta
    mesma conexão do pool.
    """
    pool = _require_pool()
    async with pool.acquire() as conn:
        request_id = str(uuid.uuid4())
        correlation_id = request.headers.get("x-correlation-id") or request_id
        await conn.execute("SELECT set_config('request.id', $1, false)", request_id)
        await conn.execute("SELECT set_config('request.correlation_id', $1, false)", correlation_id)
        await conn.execute("SELECT set_config('request.ip', $1, false)", _client_ip(request))
        await conn.execute("SELECT set_config('request.user_agent', $1, false)", request.headers.get("user-agent") or "")
        try:
            yield conn
        finally:
            await conn.execute("SELECT set_config('request.id', '', false)")
            await conn.execute("SELECT set_config('request.correlation_id', '', false)")
            await conn.execute("SELECT set_config('request.ip', '', false)")
            await conn.execute("SELECT set_config('request.user_agent', '', false)")


async def get_app_role(conn: asyncpg.Connection, claims: dict[str, Any]) -> str:
    """
    Retorna o papel de aplicação (public.users.role: supremo/admin/usuario) do
    usuário autenticado. NUNCA usar claims["role"] para isso — esse campo do
    JWT do Supabase é sempre "authenticated" (o role do Postgres), não o papel
    de negócio do usuário.
    """
    role = await conn.fetchval("SELECT role FROM public.users WHERE id = $1", claims.get("sub"))
    if role is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Usuário não encontrado.")
    return role
