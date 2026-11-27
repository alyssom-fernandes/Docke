"""
Uso, cota e pacote de configuração por empresa (achado B4.2.8 da avaliação de
25/11/2026).

- Uso: documentos, armazenamento (arquivos atuais e versões antigas), pastas
  e pessoas, com a cota quando existe.
- Cota: limite de armazenamento por empresa, definido pelo administrador
  geral. Envio que passaria do limite é recusado com mensagem clara.
- O pacote de configuração (exportar/importar entre empresas) já existia em
  templates.py (B1.5.5) e segue lá.
"""
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService

router = APIRouter(prefix="/companies", tags=["usage"])


async def _exigir_admin(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID) -> str:
    role = await get_app_role(conn, claims)
    if role != "supremo" and not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores da empresa.")
    return role


async def uso_bytes(conn: asyncpg.Connection, company_id: UUID) -> int:
    """Bytes guardados pela empresa: arquivos atuais (inclusive lixeira) e versões antigas."""
    return int(await conn.fetchval(
        """
        SELECT COALESCE((SELECT sum(size_bytes) FROM public.documents WHERE company_id = $1 AND content_hash IS NOT NULL), 0)
             + COALESCE((SELECT sum(v.size_bytes) FROM public.document_versions v JOIN public.documents d ON d.id = v.document_id
                          WHERE d.company_id = $1 AND v.storage_key IS DISTINCT FROM d.storage_path), 0)
        """,
        company_id,
    ) or 0)


async def conferir_cota(admin_conn: asyncpg.Connection, company_id: UUID, novos_bytes: int) -> None:
    """Recusa o envio que passaria da cota da empresa (sem cota, nada muda)."""
    cota = await admin_conn.fetchval("SELECT quota_bytes FROM public.companies WHERE id = $1", company_id)
    if not cota:
        return
    usado = await uso_bytes(admin_conn, company_id)
    if usado + max(0, novos_bytes) > cota:
        gb = lambda b: f"{b / 1024 ** 3:.1f}".replace(".", ",")  # noqa: E731
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"A empresa chegou ao limite de armazenamento ({gb(usado)} GB de {gb(cota)} GB). Fale com o administrador geral.",
        )


@router.get("/{company_id}/usage")
async def uso(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    linha = await admin_conn.fetchrow(
        """
        SELECT
          (SELECT count(*) FROM public.documents WHERE company_id = $1 AND deleted_at IS NULL AND content_hash IS NOT NULL) AS documentos,
          (SELECT count(*) FROM public.documents WHERE company_id = $1 AND deleted_at IS NOT NULL) AS na_lixeira,
          (SELECT COALESCE(sum(size_bytes), 0) FROM public.documents WHERE company_id = $1 AND content_hash IS NOT NULL)::bigint AS bytes_atuais,
          (SELECT count(*) FROM public.folders WHERE company_id = $1 AND deleted_at IS NULL) AS pastas,
          (SELECT count(DISTINCT user_id) FROM public.user_company_access WHERE company_id = $1) AS pessoas,
          (SELECT quota_bytes FROM public.companies WHERE id = $1) AS cota_bytes
        """,
        company_id,
    )
    total = await uso_bytes(admin_conn, company_id)
    return dict(linha) | {"bytes_total": total, "bytes_versoes": max(0, total - int(linha["bytes_atuais"]))}


class Cota(BaseModel):
    quota_gb: float | None = Field(None, gt=0, le=100_000)


@router.put("/{company_id}/quota")
async def definir_cota(
    company_id: UUID,
    body: Cota,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if await get_app_role(conn, claims) != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador geral define a cota.")
    cota = int(body.quota_gb * 1024 ** 3) if body.quota_gb else None
    await admin_conn.execute("UPDATE public.companies SET quota_bytes = $2 WHERE id = $1", company_id, cota)
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="quota",
                                      target_id=company_id, target_name="Cota de armazenamento",
                                      metadata={"gb": body.quota_gb})
    return {"cota_bytes": cota}
