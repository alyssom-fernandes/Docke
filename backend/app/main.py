import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any

import asyncpg
from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import settings
from pydantic import BaseModel, Field
from app.routers import (
    activity,
    admin,
    auth,
    companies,
    custom_fields,
    documents,
    favorites,
    folders,
    notifications,
    obligations,
    retention_legal,
    search,
    shares,
    today,
    trash,
    upload_requests,
    versions,
    privacy,
    templates,
    lgpd_requests,
    views,
    pages,
    comments,
    employees,
    version_compare,
    inbox,
    push,
    passkeys,
    security_incidents,
    features,
    access_reviews,
)

# Sem configuração, o Python descarta tudo abaixo de WARNING, e o que passa sai
# sem nível nem nome: os logger.info de docke.* (fim do reset da demo, partida
# do worker de OCR, purgas por retenção) nunca chegavam ao log da Fly. O uvicorn
# configura só os loggers dele; aqui o root ganha um handler e o INFO fica
# liberado só para o app — bibliotecas como o httpx seguem em WARNING.
logging.basicConfig(format="%(levelname)s %(name)s: %(message)s")
logging.getLogger("docke").setLevel(logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.dependencies import init_db_pool, close_db_pool, jwks_refresh_loop
    settings.assert_safe_for_production()
    await init_db_pool()
    # As tarefas de fundo ficam guardadas e são canceladas no desligamento
    # (X3-15): antes ficavam soltas e o pool fechava com elas ainda rodando.
    from app.services.erros import HandlerSentry
    logging.getLogger().addHandler(HandlerSentry())
    tasks = [asyncio.create_task(jwks_refresh_loop())]
    if settings.ENABLE_OCR_WORKER:
        from app.workers.ocr_worker import ocr_worker_loop
        tasks.append(asyncio.create_task(ocr_worker_loop()))
        from app.workers.thumbnail_worker import thumbnail_worker_loop
        tasks.append(asyncio.create_task(thumbnail_worker_loop()))
    from app.workers.maintenance_worker import maintenance_worker_loop, push_worker_loop, stats_refresh_loop
    tasks.append(asyncio.create_task(maintenance_worker_loop()))
    tasks.append(asyncio.create_task(stats_refresh_loop()))
    tasks.append(asyncio.create_task(push_worker_loop()))
    from app.workers.export_worker import export_worker_loop
    tasks.append(asyncio.create_task(export_worker_loop()))
    from app.services.busy import keepalive_loop
    tasks.append(asyncio.create_task(keepalive_loop()))
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await close_db_pool()


app = FastAPI(
    title="Docke API",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Total-Count", "X-Next-Cursor"],
)

_MENSAGEM_BLOQUEIO = {
    "legal_hold": (
        'O documento "{nome}" está sob retenção legal (legal hold) e não pode ser excluído. '
        "Para excluí-lo, libere o hold em Ajustes → Retenção."
    ),
    "retencao": (
        'O documento "{nome}" tem retenção obrigatória (política travada) ainda em vigor e não pode '
        "ser excluído antes do prazo. O prazo aparece em Detalhes → Retenção."
    ),
}


# Erros com código estável (achado X3-16): o corpo segue o formato
# problem+json (RFC 9457) e mantém o "detail" de sempre, que o frontend mostra.
_CODIGOS_HTTP = {
    400: "requisicao_invalida", 401: "nao_autenticado", 403: "sem_permissao", 404: "nao_encontrado",
    405: "metodo_nao_permitido", 409: "conflito", 410: "expirado", 413: "grande_demais",
    415: "formato_nao_aceito", 422: "dados_invalidos", 423: "bloqueado", 429: "muitas_tentativas",
    500: "erro_interno", 502: "servico_externo", 503: "indisponivel", 504: "tempo_esgotado",
}


def _problema(status_code: int, detail: Any, headers: dict | None = None) -> JSONResponse:
    from http import HTTPStatus

    try:
        titulo = HTTPStatus(status_code).phrase
    except ValueError:
        titulo = "Erro"
    corpo = {
        "type": "about:blank", "title": titulo, "status": status_code,
        "code": (headers or {}).get("X-Docke-Code") or _CODIGOS_HTTP.get(status_code, f"http_{status_code}"), "detail": detail,
    }
    return JSONResponse(status_code=status_code, content=corpo, headers=headers, media_type="application/problem+json")


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    return _problema(exc.status_code, exc.detail, getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    return _problema(422, jsonable_encoder(exc.errors()))


@app.exception_handler(asyncpg.exceptions.RaiseError)
async def exclusao_bloqueada_handler(request: Request, exc: asyncpg.exceptions.RaiseError):
    """
    Os triggers da migration 20261125000001 recusam excluir (ou mandar para a
    lixeira) documento sob legal hold ou com retenção travada vigente, venha o
    pedido de onde vier. Aqui o erro do banco vira 423 com um texto que diz o
    que fazer; qualquer outro RAISE segue como erro interno.
    """
    mensagem = str(exc)
    if not mensagem.startswith("DOCKE_EXCLUSAO_BLOQUEADA:"):
        raise exc
    _, motivo, nome = (mensagem.split(":", 2) + ["", ""])[:3]
    texto = _MENSAGEM_BLOQUEIO.get(motivo, _MENSAGEM_BLOQUEIO["legal_hold"]).format(nome=nome or "selecionado")
    return JSONResponse(status_code=423, content={"detail": texto, "code": "exclusao_bloqueada", "motivo": motivo})


@app.exception_handler(Exception)
async def erro_nao_previsto_handler(request: Request, exc: Exception):
    """Erro não previsto: vai ao Sentry (sem corpo, cabeçalhos nem dados pessoais) e volta como 500 em JSON."""
    from app.services import erros

    rota = request.scope.get("route")
    erros.relatar(erros.montar_evento(exc, rota=getattr(rota, "path", None) or request.url.path, metodo=request.method))
    return JSONResponse(status_code=500, content={"detail": "Algo deu errado do nosso lado. Já fomos avisados; tente de novo em instantes.", "code": "erro_interno"})


PREFIX = "/api/v1"

app.include_router(auth.router, prefix=PREFIX)
app.include_router(companies.router, prefix=PREFIX)
app.include_router(folders.router, prefix=PREFIX)
# custom_fields precisa vir ANTES de documents: documents.router tem uma rota
# catch-all GET /{document_id} que, se registrada primeiro, intercepta
# /documents/field-values (bulk) tratando "field-values" como um document_id.
app.include_router(custom_fields.router, prefix=PREFIX)
app.include_router(documents.router, prefix=PREFIX)
app.include_router(search.router, prefix=PREFIX)
app.include_router(favorites.router, prefix=PREFIX)
app.include_router(activity.router, prefix=PREFIX)
app.include_router(trash.router, prefix=PREFIX)
app.include_router(admin.router, prefix=PREFIX)
app.include_router(versions.router, prefix=PREFIX)
app.include_router(shares.router, prefix=PREFIX)
app.include_router(shares.public_router, prefix=PREFIX)
app.include_router(upload_requests.router, prefix=PREFIX)
app.include_router(notifications.router, prefix=PREFIX)
app.include_router(obligations.router, prefix=PREFIX)
app.include_router(retention_legal.router, prefix=PREFIX)
app.include_router(today.router, prefix=PREFIX)
app.include_router(privacy.router, prefix=PREFIX)
app.include_router(templates.router, prefix=PREFIX)
app.include_router(lgpd_requests.router, prefix=PREFIX)
app.include_router(security_incidents.router, prefix=PREFIX)
app.include_router(views.router, prefix=PREFIX)
app.include_router(pages.router, prefix=PREFIX)
app.include_router(comments.router, prefix=PREFIX)
app.include_router(employees.router, prefix=PREFIX)
app.include_router(version_compare.router, prefix=PREFIX)
app.include_router(inbox.router, prefix=PREFIX)
app.include_router(push.router, prefix=PREFIX)
app.include_router(passkeys.router, prefix=PREFIX)
app.include_router(features.router, prefix=PREFIX)
app.include_router(access_reviews.router, prefix=PREFIX)


class ErroDoNavegador(BaseModel):
    message: str = Field(..., max_length=1000)
    stack: str | None = Field(None, max_length=8000)
    path: str | None = Field(None, max_length=300)


@app.post(PREFIX + "/client-errors", status_code=204, tags=["health"])
async def erro_do_navegador(body: ErroDoNavegador, request: Request) -> None:
    """Erros de JavaScript do app vão ao Sentry por aqui (sem script de terceiro no navegador)."""
    from app.services import erros, rate_limit

    if not rate_limit.check_and_record(f"client-err:{rate_limit.client_ip_hash(request)}", 20, 300):
        return
    erros.relatar(erros.montar_evento(None, mensagem=body.message, rota=(body.path or "").split("?")[0][:200], origem="web",
                                      extra={"pilha": (body.stack or "")[:4000]}))


@app.get("/health", tags=["health"])
async def health_check():
    return {"status": "ok"}


@app.get("/health/workers", tags=["health"])
async def health_workers():
    """Estado dos workers em segundo plano (X3-11): ok, atrasado ou parado."""
    from app.services.heartbeat import snapshot
    return snapshot()


@app.get("/health/db", tags=["health"])
async def health_db():
    """
    Toca o banco com uma consulta trivial. Usado pelo keep-alive diário
    (.github/workflows/keep-alive.yml): o plano Free do Supabase pausa o
    projeto depois de 7 dias com pouca atividade, e a demo cai junto.
    """
    from fastapi import HTTPException
    from app.dependencies import _require_pool
    try:
        await _require_pool().fetchval("SELECT count(*) FROM public.companies")
    except Exception:
        raise HTTPException(status_code=503, detail="Banco indisponível.")
    return {"status": "ok", "db": "ok"}
