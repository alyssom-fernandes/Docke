"""
FastAPI dependencies — pool asyncpg + JWT → RLS.

get_db       — conexão com JWT do usuário repassado ao Postgres via set_config.
get_db_admin — conexão como superuser (bypassa RLS) para jobs administrativos.
get_db_share_public — conexão das rotas públicas de link, no papel docke_share_public.
get_current_user — valida JWT e retorna claims do usuário.
"""
import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
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
_jwks_lock = asyncio.Lock()  # uma busca sob demanda por vez (ver _refresh_jwks_on_demand)
_jwks_last_on_demand: float | None = None  # time.monotonic() da última busca sob demanda
_JWKS_ON_DEMAND_MIN_INTERVAL_SECS = 30

logger = logging.getLogger("docke.auth")


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
            else:
                logger.warning(
                    "Revalidação periódica do JWKS falhou; nova tentativa em %ds.",
                    interval_secs,
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            pass  # mantém o _jwks anterior; tenta de novo no próximo ciclo


def _jwks_key_count(jwks: Any) -> int:
    """Quantas chaves o JWKS tem — só para log; 0 se a resposta não tiver o formato esperado."""
    keys = jwks.get("keys") if isinstance(jwks, dict) else None
    return len(keys) if isinstance(keys, list) else 0


async def _load_jwks_at_startup(attempts: int = 3, retry_delay: float = 1.5) -> None:
    """
    Busca chaves públicas do Supabase Auth para verificar tokens ES256.
    Algumas tentativas com espera curta: se o backend sobe antes do serviço
    de Auth estar pronto (comum em `docker compose`/`supabase start` local,
    onde os containers não têm ordem de prontidão garantida), uma falha na
    primeira tentativa deixava _jwks preso em None pro resto da vida do
    processo — todo token real (ES256) passava a ser rejeitado com "alg not
    allowed" até o próximo restart, um bug intermitente difícil de notar.
    """
    global _jwks
    for attempt in range(attempts):
        fresh = await _fetch_jwks()
        if fresh is not None:
            _jwks = fresh
            logger.info("JWKS carregado na partida: %d chave(s).", _jwks_key_count(fresh))
            return
        if attempt < attempts - 1:
            await asyncio.sleep(retry_delay)
    # Se todas as tentativas falharem, _jwks permanece None e o fallback HS256
    # assume — correto pra ambientes que genuinamente não usam Supabase Auth.
    # Onde há Supabase Auth, o primeiro token ES256 busca o JWKS de novo
    # (_refresh_jwks_on_demand), sem esperar o ciclo de jwks_refresh_loop.
    logger.warning(
        "JWKS indisponível depois de %d tentativas na partida — o primeiro token ES256 vai buscá-lo de novo.",
        attempts,
    )


async def init_db_pool() -> None:
    global _pool, _admin_pool
    # Requisições (get_db e get_db_admin) e workers em pools separadas (X3-15):
    # antes os laços de fundo disputavam as mesmas 10 conexões com as rotas.
    _pool = await asyncpg.create_pool(
        settings.asyncpg_url,
        min_size=2,
        max_size=12,
        command_timeout=30,
    )
    _admin_pool = await asyncpg.create_pool(
        settings.asyncpg_url,
        min_size=1,
        max_size=4,
        command_timeout=120,  # OCR, purga e manutenção podem demorar mais que uma requisição
    )
    await _load_jwks_at_startup()


async def close_db_pool() -> None:
    global _pool, _admin_pool
    for p in (_pool, _admin_pool):
        if p is not None:
            await p.close()
    _pool = None
    _admin_pool = None


_ACQUIRE_TIMEOUT_SECS = 10


@asynccontextmanager
async def _acquire(pool: asyncpg.Pool) -> AsyncGenerator[asyncpg.Connection, None]:
    """Pega uma conexão sem esperar para sempre (X3-15): com o pool cheio por
    mais de 10 s, responde 503 com Retry-After em vez de travar a requisição."""
    try:
        conn = await pool.acquire(timeout=_ACQUIRE_TIMEOUT_SECS)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="O servidor está ocupado agora. Tente de novo em alguns segundos.",
            headers={"Retry-After": "3"},
        ) from None
    try:
        yield conn
    finally:
        await pool.release(conn)


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
    except JWTError:
        # Sem repassar o motivo da biblioteca ao cliente (assinatura, algoritmo
        # etc.) — isso só ajuda quem está tentando forjar um token.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Sessão inválida ou expirada.",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _jwks_has_key(kid: Any) -> bool:
    """O JWKS em memória tem a chave deste kid? Token sem kid: o jose tenta todas as chaves."""
    if not _jwks:
        return False
    if kid is None:
        return True
    return any(key.get("kid") == kid for key in _jwks.get("keys", []))


async def _refresh_jwks_on_demand(kid: Any) -> None:
    """
    Busca o JWKS de novo quando chega um token ES256 cuja chave não está em
    memória: o JWKS faltou na partida (o Supabase estava fora do ar, como na
    retomada do projeto em 26/10/2026) ou o Supabase Auth trocou a chave. Sem
    isso, todo login dava 401 até o próximo ciclo de jwks_refresh_loop (1h).

    O kid vem de um cabeçalho ainda não verificado, e um token forjado com kid
    inventado não pode fazer a API martelar o Supabase: no máximo uma busca a
    cada _JWKS_ON_DEMAND_MIN_INTERVAL_SECS. O lock faz requisições simultâneas
    esperarem uma única busca.
    """
    global _jwks, _jwks_last_on_demand
    async with _jwks_lock:
        if _jwks_has_key(kid):
            return  # outra requisição trouxe a chave enquanto esta esperava o lock
        now = time.monotonic()
        if _jwks_last_on_demand is not None and now - _jwks_last_on_demand < _JWKS_ON_DEMAND_MIN_INTERVAL_SECS:
            return
        _jwks_last_on_demand = now
        logger.warning("JWKS sem a chave do token (kid=%r) — buscando de novo no Supabase Auth.", str(kid)[:64])
        fresh = await _fetch_jwks()
        if fresh is None:
            logger.warning(
                "Busca do JWKS sob demanda falhou; a próxima pode sair em %ds.", _JWKS_ON_DEMAND_MIN_INTERVAL_SECS
            )
            return
        _jwks = fresh
        if _jwks_has_key(kid):
            logger.info("JWKS atualizado sob demanda: a chave do token chegou (%d chave(s)).", _jwks_key_count(fresh))
        else:
            logger.warning("JWKS atualizado sob demanda, mas ainda sem a chave do token (kid=%r).", str(kid)[:64])


async def _decode_jwt_refreshing(token: str) -> dict[str, Any]:
    """_decode_jwt, buscando antes o JWKS se a chave do token ES256 não estiver em memória."""
    try:
        header = jwt.get_unverified_header(token)
    except JWTError:
        header = {}  # token malformado: _decode_jwt responde 401
    if header.get("alg") == "ES256" and not _jwks_has_key(header.get("kid")):
        await _refresh_jwks_on_demand(header.get("kid"))
    return _decode_jwt(token)


# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

async def _sessao_viva(request: Request | None, conn: asyncpg.Connection | None, claims: dict[str, Any]) -> None:
    """
    Sessão encerrada em Ajustes → Segurança (ou pelo administrador) deixa de
    valer na hora, e não só quando o token de acesso vence (até 1 h): o token
    traz o id da sessão, que precisa continuar em auth.sessions (FA-A8-02).
    Tokens sem session_id (serviço, testes) não passam por aqui.
    """
    sid = claims.get("session_id")
    if request is None or not sid:
        return
    viva = getattr(request.state, "sessao_viva", None)
    if viva is None:
        try:
            if conn is not None:
                viva = await conn.fetchval("SELECT EXISTS (SELECT 1 FROM auth.sessions WHERE id = $1::uuid)", sid)
            else:
                async with _acquire(_require_pool()) as c:
                    viva = await c.fetchval("SELECT EXISTS (SELECT 1 FROM auth.sessions WHERE id = $1::uuid)", sid)
        except HTTPException:
            raise
        except Exception:
            logger.exception("Falha ao conferir a sessão; a requisição segue.")
            return
        request.state.sessao_viva = viva
    if not viva:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Esta sessão foi encerrada. Entre de novo.",
            headers={"WWW-Authenticate": "Bearer", "X-Docke-Code": "sessao_encerrada"},
        )


async def _exigir_mfa(request: Request | None, conn: asyncpg.Connection | None, claims: dict[str, Any]) -> None:
    """
    Verificação em duas etapas (decisão do dono, 26/11/2026): quem tem app
    autenticador cadastrado precisa ter digitado o código nesta sessão (aal2);
    quem a política da empresa obriga e ainda não cadastrou só alcança /auth.
    A resposta fica guardada na requisição (get_db e get_current_user podem
    rodar juntas na mesma rota).
    """
    from app.services import mfa_service

    if request is None or claims.get("aal") == "aal2" or not claims.get("sub") or mfa_service.rota_livre(request.url.path):
        return
    if mfa_service.is_demo(claims):
        return
    pend = getattr(request.state, "mfa_pendencia", "?")
    if pend == "?":
        try:
            if conn is not None:
                cadastrado, exigido = await mfa_service.estado(conn, claims["sub"])
            else:
                async with _acquire(_require_pool()) as c:
                    cadastrado, exigido = await mfa_service.estado(c, claims["sub"])
        except HTTPException:
            raise
        except Exception:
            logger.exception("Falha ao conferir a verificação em duas etapas; a requisição segue.")
            return
        pend = mfa_service.pendencia(claims, cadastrado, exigido)
        request.state.mfa_pendencia = pend
    if pend == "verificar":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Digite o código do app autenticador para continuar.",
            headers={"X-Docke-Code": "mfa_verificar"},
        )
    if pend == "cadastrar":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Ative a verificação em duas etapas para continuar.",
            headers={"X-Docke-Code": "mfa_cadastrar"},
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    request: Request = None,  # type: ignore[assignment]  # o FastAPI injeta; chamadas diretas (testes) passam sem
) -> dict[str, Any]:
    """Valida JWT e retorna os claims. Usado por rotas que precisam do usuário mas não do banco."""
    claims = await _decode_jwt_refreshing(credentials.credentials)
    await _sessao_viva(request, None, claims)
    await _exigir_mfa(request, None, claims)
    return claims


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
    claims = await _decode_jwt_refreshing(credentials.credentials)
    pool = _require_pool()

    async with _acquire(pool) as conn:
        # Antes de trocar para o papel authenticated: as consultas leem o esquema auth.
        await _sessao_viva(request, conn, claims)
        await _exigir_mfa(request, conn, claims)
        async with conn.transaction():
            # Replica o que o PostgREST faz internamente:
            # seta request.jwt.claims para que auth.uid() retorne claims['sub']
            await conn.execute(
                "SELECT set_config('request.jwt.claims', $1, true)",
                json.dumps(claims),
            )
            # Troca o role para que o RLS se aplique (LOCAL = apenas nesta transação)
            await conn.execute("SET LOCAL role TO authenticated")

            # Conta desativada pelo admin (achado A9-16): o token de acesso ainda
            # vale até 1 h, então a checagem é por requisição, não só no login.
            if await conn.fetchval("SELECT is_active FROM public.users WHERE id = auth.uid()") is False:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Esta conta foi desativada. Fale com o administrador da sua empresa.",
                )

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
    async with _acquire(pool) as conn:
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


async def get_db_share_public() -> AsyncGenerator[asyncpg.Connection, None]:
    """
    Conexão das rotas públicas de link (/s/{token}/...). Não há usuário logado
    para o RLS por auth.uid(), mas também não precisa do superusuário: troca
    para o papel docke_share_public (migration 20261026000002), que só alcança
    as colunas que essas rotas leem ou gravam — shares, documents, folders,
    document_versions, share_accesses e as notificações de link. Um erro de
    escopo numa rota sem autenticação deixa de expor o resto do banco (chave
    HMAC, usuários, trilha de auditoria).

    Mesmo autocommit-por-statement de get_db_admin (o log de tentativa de senha
    errada precisa ficar gravado mesmo com a resposta 401): por isso SET ROLE
    de sessão e RESET ROLE no finally, antes de a conexão voltar ao pool. O
    reset do pool (RESET ALL) não desfaz SET ROLE; se o RESET ROLE falhar, a
    conexão é encerrada em vez de voltar ao pool presa neste papel.
    """
    pool = _require_pool()
    async with _acquire(pool) as conn:
        await conn.execute("SET ROLE docke_share_public")
        try:
            yield conn
        finally:
            try:
                await conn.execute("RESET ROLE")
            except BaseException:
                conn.terminate()
                raise


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
