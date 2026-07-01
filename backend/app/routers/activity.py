import csv
import io
from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from openpyxl import Workbook
from openpyxl.styles import Font

from app.dependencies import get_current_user, get_db, get_db_admin

router = APIRouter(prefix="/activity", tags=["activity"])

# Máximo de linhas retornadas / exportadas
_PAGE_SIZE_MAX = 200
_EXPORT_LIMIT = 5000

_ACTION_LABELS: dict[str, str] = {
    "upload": "Envio",
    "view": "Visualização",
    "move": "Movimentação",
    "rename": "Renomeação",
    "delete": "Exclusão",
    "restore": "Restauração",
    "download": "Download",
    "favorite": "Favoritado",
    "unfavorite": "Desfavoritado",
    "undo": "Desfeito",
}


# ---------------------------------------------------------------------------
# GET /activity — lista eventos com filtros
# ---------------------------------------------------------------------------

@router.get("")
async def list_activity(
    company_id: UUID = Query(...),
    user_id: UUID | None = Query(None),
    action: str | None = Query(None),
    item_type: str | None = Query(None),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=_PAGE_SIZE_MAX),
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    Lista eventos do activity_log filtrados por empresa.
    Filtros opcionais: user_id, action, item_type, date_from, date_to.
    RLS garante que só company members veem os logs da empresa.
    """
    offset = (page - 1) * page_size

    rows = await conn.fetch(
        """
        SELECT
          al.id::text,
          al.user_id::text,
          al.company_id::text,
          al.action,
          al.item_type,
          al.item_id::text,
          al.item_name_snapshot,
          al.metadata,
          al.created_at,
          u.full_name AS user_name,
          u.username  AS user_username,
          count(*) OVER () AS total_count
        FROM public.activity_log al
        LEFT JOIN public.users u ON u.id = al.user_id
        WHERE al.company_id = $1
          AND ($2::uuid IS NULL OR al.user_id    = $2)
          AND ($3::text IS NULL OR al.action     = $3)
          AND ($4::text IS NULL OR al.item_type  = $4)
          AND ($5::date IS NULL OR al.created_at >= $5::date)
          AND ($6::date IS NULL OR al.created_at <  ($6 + interval '1 day')::date)
        ORDER BY al.created_at DESC
        LIMIT $7 OFFSET $8
        """,
        company_id,
        user_id,
        action,
        item_type,
        date_from,
        date_to,
        page_size,
        offset,
    )

    total = rows[0]["total_count"] if rows else 0
    return {
        "results": [
            {k: v for k, v in dict(r).items() if k != "total_count"}
            for r in rows
        ],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


# ---------------------------------------------------------------------------
# GET /activity/export — exporta CSV (deve vir antes de /{event_id})
# ---------------------------------------------------------------------------

@router.get("/export")
async def export_activity_csv(
    company_id: UUID = Query(...),
    user_id: UUID | None = Query(None),
    action: str | None = Query(None),
    item_type: str | None = Query(None),
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    format: str = Query("csv", pattern="^(csv|xlsx)$"),
    conn: asyncpg.Connection = Depends(get_db),
) -> Response:
    """
    Exporta eventos do activity_log como CSV (padrão) ou XLSX (?format=xlsx).
    Máximo de _EXPORT_LIMIT linhas (5000).
    Retorna Content-Disposition: attachment.
    """
    rows = await conn.fetch(
        """
        SELECT
          al.id::text,
          al.created_at,
          al.action,
          al.item_type,
          al.item_name_snapshot,
          al.item_id::text,
          u.full_name AS user_name,
          u.username  AS user_username
        FROM public.activity_log al
        LEFT JOIN public.users u ON u.id = al.user_id
        WHERE al.company_id = $1
          AND ($2::uuid IS NULL OR al.user_id    = $2)
          AND ($3::text IS NULL OR al.action     = $3)
          AND ($4::text IS NULL OR al.item_type  = $4)
          AND ($5::date IS NULL OR al.created_at >= $5::date)
          AND ($6::date IS NULL OR al.created_at <  ($6 + interval '1 day')::date)
        ORDER BY al.created_at DESC
        LIMIT $7
        """,
        company_id,
        user_id,
        action,
        item_type,
        date_from,
        date_to,
        _EXPORT_LIMIT,
    )

    if format == "xlsx":
        wb = Workbook()
        ws = wb.active
        ws.title = "Atividade"
        headers = ["Data/Hora", "Ação", "Tipo", "Item", "Usuário", "Usuário (login)"]
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for r in rows:
            ws.append([
                r["created_at"].strftime("%d/%m/%Y %H:%M") if r["created_at"] else "",
                _ACTION_LABELS.get(r["action"], r["action"]),
                "Pasta" if r["item_type"] == "folder" else "Documento",
                r["item_name_snapshot"] or "",
                r["user_name"] or "",
                r["user_username"] or "",
            ])
        for col_idx, header in enumerate(headers, start=1):
            ws.column_dimensions[chr(64 + col_idx)].width = max(len(header) + 2, 18)

        buf_bytes = io.BytesIO()
        wb.save(buf_bytes)
        xlsx_bytes = buf_bytes.getvalue()
        return Response(
            content=xlsx_bytes,
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": 'attachment; filename="activity_log.xlsx"',
                "Content-Length": str(len(xlsx_bytes)),
            },
        )

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "created_at", "action", "item_type", "item_name", "item_id", "user_name", "username"])
    for r in rows:
        writer.writerow([
            r["id"],
            r["created_at"].isoformat() if r["created_at"] else "",
            r["action"],
            r["item_type"],
            r["item_name_snapshot"] or "",
            r["item_id"],
            r["user_name"] or "",
            r["user_username"] or "",
        ])

    csv_bytes = buf.getvalue().encode("utf-8-sig")  # BOM para Excel abrir corretamente
    return Response(
        content=csv_bytes,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": 'attachment; filename="activity_log.csv"',
            "Content-Length": str(len(csv_bytes)),
        },
    )


# ---------------------------------------------------------------------------
# POST /activity/undo/:id — cria evento de undo (I1: append-only)
# ---------------------------------------------------------------------------

@router.post("/undo/{event_id}", status_code=status.HTTP_201_CREATED)
async def undo_activity(
    event_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Cria um evento de undo para um evento existente.
    I1 (append-only): NUNCA edita eventos existentes — cria um novo.

    Ações reversíveis e suas contrapartidas:
      move     → undo via move de volta (metadata guarda folder original)
      rename   → undo via rename (metadata guarda nome original)
      delete   → undo via restore do item
      favorite → undo via unfavorite

    Ações não reversíveis (retorna 422):
      upload, view, download, restore, unfavorite, delete (permanente)
    """
    user_id = claims["sub"]

    event = await conn.fetchrow(
        """
        SELECT id::text, action, item_type, item_id::text, item_name_snapshot,
               company_id::text, metadata
        FROM public.activity_log
        WHERE id = $1
        """,
        event_id,
    )
    if event is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Evento não encontrado.")

    _REVERSIBLE = {"move", "rename", "delete", "favorite"}
    if event["action"] not in _REVERSIBLE:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Ação '{event['action']}' não é reversível via undo.",
        )

    # Cria evento de undo sem executar a ação (ação é responsabilidade do cliente)
    # O cliente usa o metadata retornado para saber COMO desfazer
    undo_metadata = {
        "undo_of_event_id": str(event_id),
        "original_action": event["action"],
        "original_name": event["item_name_snapshot"],
    }
    if event["metadata"]:
        import json
        original_meta = event["metadata"] if isinstance(event["metadata"], dict) else json.loads(event["metadata"])
        undo_metadata["original_metadata"] = original_meta

    row = await admin_conn.fetchrow(
        """
        INSERT INTO public.activity_log
          (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
        VALUES ($1::uuid, $2::uuid, 'undo', $3, $4::uuid, $5, $6::jsonb)
        RETURNING id::text, action, item_type, item_id::text, item_name_snapshot, metadata, created_at
        """,
        user_id,
        event["company_id"],
        event["item_type"],
        event["item_id"],
        event["item_name_snapshot"],
        __import__("json").dumps(undo_metadata),
    )

    return dict(row) | {
        "undo_of_event_id": str(event_id),
        "original_action": event["action"],
        "instructions": _undo_instructions(event),
    }


def _undo_instructions(event: dict) -> dict[str, Any]:
    """Retorna instruções para o cliente executar o undo."""
    action = event["action"]
    item_id = event["item_id"]
    meta = event.get("metadata") or {}
    if isinstance(meta, str):
        import json
        meta = json.loads(meta)

    if action == "delete":
        return {"type": "restore", "endpoint": f"POST /trash/{item_id}/restore?item_type={event['item_type']}"}
    if action == "move":
        original_folder = meta.get("original_folder_id") or meta.get("source_folder_id")
        return {"type": "move_back", "endpoint": f"POST /documents/bulk-move", "target_folder_id": original_folder}
    if action == "rename":
        original_name = meta.get("original_name") or event["item_name_snapshot"]
        return {"type": "rename_back", "name": original_name}
    if action == "favorite":
        return {"type": "unfavorite", "endpoint": f"DELETE /favorites/<favorite_id>"}
    return {}
