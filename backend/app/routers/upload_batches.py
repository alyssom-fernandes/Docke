"""
Lotes de envio consultáveis depois (achados B1.1.9 e B4.3.7 da avaliação de
25/11/2026). O navegador abre o lote ao começar e fecha com o resultado; se a
aba fechar no meio, o lote fica "interrompido". A lista e o relatório (CSV)
ficam disponíveis na central de tarefas, e quem enviou recebe um aviso com o
resumo ao terminar.
"""
import csv
import io
import json
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field

from app.dependencies import get_current_user, get_db, get_db_admin

router = APIRouter(prefix="/upload-batches", tags=["upload-batches"])

# Sem notícia do navegador por este tempo, o lote aberto é dado como interrompido.
_INTERROMPIDO = "interval '2 hours'"


class BatchStart(BaseModel):
    company_id: UUID
    folder_id: UUID | None = None
    folder_name: str | None = Field(None, max_length=300)
    total: int = Field(..., ge=1, le=100_000)
    data_original: bool = False


class Falha(BaseModel):
    nome: str = Field(..., max_length=600)
    motivo: str = Field(..., max_length=600)


class BatchUpdate(BaseModel):
    ok: int = Field(..., ge=0)
    falhas: list[Falha] = Field(default_factory=list, max_length=100_000)
    concluido: bool = False


@router.post("", status_code=status.HTTP_201_CREATED)
async def abrir_lote(
    body: BatchStart,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, str]:
    membro = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = auth.uid() AND company_id = $1)", body.company_id,
    )
    if not membro:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem acesso a esta empresa.")
    lote = await admin_conn.fetchval(
        """
        INSERT INTO public.upload_batches (company_id, user_id, folder_id, folder_name, total, data_original)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text
        """,
        body.company_id, claims["sub"], body.folder_id, body.folder_name, body.total, body.data_original,
    )
    return {"id": lote}


@router.patch("/{batch_id}")
async def atualizar_lote(
    batch_id: UUID,
    body: BatchUpdate,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    lote = await admin_conn.fetchrow(
        "SELECT company_id, total, folder_name, finished_at FROM public.upload_batches WHERE id = $1 AND user_id = $2",
        batch_id, claims["sub"],
    )
    if lote is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lote não encontrado.")
    if lote["finished_at"] is not None:
        return {"status": "ja_concluido"}
    await admin_conn.execute(
        """
        UPDATE public.upload_batches SET ok = $2, falhas = $3::jsonb, finished_at = CASE WHEN $4 THEN now() ELSE NULL END
        WHERE id = $1
        """,
        batch_id, min(body.ok, lote["total"]), json.dumps([f.model_dump() for f in body.falhas]), body.concluido,
    )
    if body.concluido:
        n_falhas = len(body.falhas)
        onde = f' para "{lote["folder_name"]}"' if lote["folder_name"] else ""
        msg = f"Envio{onde} concluído: {body.ok} {'disponível' if body.ok == 1 else 'disponíveis'}"
        msg += f", {n_falhas} {'precisa' if n_falhas == 1 else 'precisam'} de atenção." if n_falhas else "."
        await admin_conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
            VALUES ($1, $2, 'upload_batch', 'upload_batch', $3, $4)
            """,
            claims["sub"], lote["company_id"], batch_id, msg,
        )
    return {"status": "ok"}


@router.get("")
async def listar_lotes(
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await conn.fetch(
        f"""
        SELECT id::text, folder_id::text, folder_name, total, ok, jsonb_array_length(falhas) AS n_falhas,
               data_original, started_at, finished_at,
               CASE WHEN finished_at IS NOT NULL THEN 'concluido'
                    WHEN started_at < now() - {_INTERROMPIDO} THEN 'interrompido'
                    ELSE 'em_andamento' END AS situacao
        FROM public.upload_batches
        WHERE user_id = auth.uid() AND company_id = $1
        ORDER BY started_at DESC LIMIT 30
        """,
        company_id,
    )
    return [dict(r) for r in rows]


@router.get("/{batch_id}/relatorio")
async def relatorio_lote(batch_id: UUID, conn: asyncpg.Connection = Depends(get_db)) -> Response:
    lote = await conn.fetchrow(
        "SELECT folder_name, total, ok, falhas, started_at, finished_at FROM public.upload_batches WHERE id = $1 AND user_id = auth.uid()",
        batch_id,
    )
    if lote is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Lote não encontrado.")
    falhas = lote["falhas"] if isinstance(lote["falhas"], list) else json.loads(lote["falhas"] or "[]")
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Pasta", lote["folder_name"] or ""])
    w.writerow(["Começou", lote["started_at"].strftime("%d/%m/%Y %H:%M")])
    w.writerow(["Terminou", lote["finished_at"].strftime("%d/%m/%Y %H:%M") if lote["finished_at"] else "não terminou (aba fechada no meio?)"])
    w.writerow(["Arquivos", lote["total"]])
    w.writerow(["Entraram", lote["ok"]])
    w.writerow(["Não entraram", len(falhas)])
    w.writerow(["Sem resposta", max(0, lote["total"] - lote["ok"] - len(falhas))])
    w.writerow([])
    w.writerow(["Arquivo", "Motivo"])
    for f in falhas:
        w.writerow([f.get("nome", ""), f.get("motivo", "")])
    return Response(
        content="﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="relatorio-do-envio.csv"'},
    )
