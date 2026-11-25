import asyncio
import logging
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
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
    trash,
    versions,
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
    asyncio.create_task(jwks_refresh_loop())
    if settings.ENABLE_OCR_WORKER:
        from app.workers.ocr_worker import ocr_worker_loop
        asyncio.create_task(ocr_worker_loop())
    from app.workers.maintenance_worker import maintenance_worker_loop, stats_refresh_loop
    asyncio.create_task(maintenance_worker_loop())
    asyncio.create_task(stats_refresh_loop())
    from app.workers.export_worker import export_worker_loop
    asyncio.create_task(export_worker_loop())
    from app.services.busy import keepalive_loop
    asyncio.create_task(keepalive_loop())
    yield
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
app.include_router(notifications.router, prefix=PREFIX)
app.include_router(obligations.router, prefix=PREFIX)
app.include_router(retention_legal.router, prefix=PREFIX)


@app.get("/health", tags=["health"])
async def health_check():
    return {"status": "ok"}


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
