import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.routers import (
    activity,
    admin,
    auth,
    companies,
    documents,
    favorites,
    folders,
    notifications,
    search,
    shares,
    trash,
    versions,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.dependencies import init_db_pool, close_db_pool
    await init_db_pool()
    if settings.ENABLE_OCR_WORKER:
        from app.workers.ocr_worker import ocr_worker_loop
        asyncio.create_task(ocr_worker_loop())
    from app.workers.maintenance_worker import maintenance_worker_loop
    asyncio.create_task(maintenance_worker_loop())
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

PREFIX = "/api/v1"

app.include_router(auth.router, prefix=PREFIX)
app.include_router(companies.router, prefix=PREFIX)
app.include_router(folders.router, prefix=PREFIX)
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


@app.get("/health", tags=["health"])
async def health_check():
    return {"status": "ok"}
