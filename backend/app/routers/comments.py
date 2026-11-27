"""
Comentários e anotações em documentos (benchmark B2.4.6, B2.4.9, B2.6.7).

Quem enxerga o documento comenta. A anotação é um comentário preso a um ponto
da página (x e y de 0 a 1, independentes do zoom), numa camada separada: o
arquivo não muda, e cada anotação lembra a versão em que foi feita. A busca
dos comentários respeita o que cada pessoa enxerga (o RLS da conexão dela).
"""
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, model_validator

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services import features_service

router = APIRouter(tags=["comments"])


async def _doc_visivel(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record:
    """O RLS da conexão da pessoa decide: se ela não enxerga, é 404."""
    doc = await conn.fetchrow(
        """
        SELECT d.id, d.company_id, d.current_version_id, d.name, f.path::text AS path
        FROM public.documents d JOIN public.folders f ON f.id = d.folder_id
        WHERE d.id = $1 AND d.deleted_at IS NULL
        """,
        document_id,
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    return doc


class ComentarioNovo(BaseModel):
    body: str = Field(..., min_length=1, max_length=2000)
    page: int | None = Field(None, ge=1, le=100000)
    x: float | None = Field(None, ge=0, le=1)
    y: float | None = Field(None, ge=0, le=1)

    @model_validator(mode="after")
    def _ponto(self) -> "ComentarioNovo":
        if (self.x is None) != (self.y is None) or (self.x is not None and self.page is None):
            raise ValueError("Anotação precisa de página, x e y juntos.")
        return self


class ComentarioMuda(BaseModel):
    resolved: bool


_COLS = """
    c.id::text, c.body, c.page, c.x, c.y, c.created_at, c.resolved_at, c.user_id::text AS user_id,
    u.full_name AS author, v.version_number
"""


@router.get("/documents/{document_id}/comments")
async def listar(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    await _doc_visivel(conn, document_id)
    rows = await admin_conn.fetch(
        f"""
        SELECT {_COLS}
        FROM public.document_comments c
        JOIN public.users u ON u.id = c.user_id
        LEFT JOIN public.document_versions v ON v.id = c.version_id
        WHERE c.document_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.page NULLS FIRST, c.created_at
        """,
        document_id,
    )
    return [{**dict(r), "mine": r["user_id"] == claims["sub"]} for r in rows]


@router.post("/documents/{document_id}/comments", status_code=status.HTTP_201_CREATED)
async def comentar(
    document_id: UUID,
    body: ComentarioNovo,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    doc = await _doc_visivel(conn, document_id)
    await features_service.require(conn, doc["company_id"], "comentarios")
    cid = await admin_conn.fetchval(
        """
        INSERT INTO public.document_comments (company_id, document_id, version_id, user_id, body, page, x, y)
        VALUES ($1, $2, $3, $4::uuid, $5, $6, $7, $8) RETURNING id
        """,
        doc["company_id"], document_id, doc["current_version_id"], claims["sub"], body.body.strip(), body.page, body.x, body.y,
    )
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
        VALUES ($1::uuid, $2, $3, 'document', $4, $5, jsonb_build_object('pagina', $6::int))
        """,
        claims["sub"], doc["company_id"], "annotation_added" if body.x is not None else "comment_added", document_id, doc["name"], body.page,
    )
    row = await admin_conn.fetchrow(
        f"""
        SELECT {_COLS} FROM public.document_comments c JOIN public.users u ON u.id = c.user_id
        LEFT JOIN public.document_versions v ON v.id = c.version_id WHERE c.id = $1
        """,
        cid,
    )
    return {**dict(row), "mine": True}


async def _comentario(conn: asyncpg.Connection, admin_conn: asyncpg.Connection, comment_id: UUID) -> tuple[asyncpg.Record, asyncpg.Record]:
    c = await admin_conn.fetchrow(
        "SELECT id, document_id, user_id::text, company_id FROM public.document_comments WHERE id = $1 AND deleted_at IS NULL", comment_id,
    )
    if c is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Comentário não encontrado.")
    return c, await _doc_visivel(conn, c["document_id"])


@router.patch("/comments/{comment_id}")
async def resolver(
    comment_id: UUID,
    body: ComentarioMuda,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    await _comentario(conn, admin_conn, comment_id)
    await admin_conn.execute(
        "UPDATE public.document_comments SET resolved_at = CASE WHEN $2 THEN now() END WHERE id = $1", comment_id, body.resolved,
    )
    return {"id": str(comment_id), "resolved": body.resolved}


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def apagar(
    comment_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    c, doc = await _comentario(conn, admin_conn, comment_id)
    if c["user_id"] != claims["sub"] and await get_app_role(conn, claims) != "supremo":
        nivel = await conn.fetchval("SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)", claims["sub"], doc["path"], doc["company_id"])
        if nivel != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só quem escreveu ou o administrador da pasta apaga o comentário.")
    await admin_conn.execute("UPDATE public.document_comments SET deleted_at = now() WHERE id = $1", comment_id)


@router.get("/companies/{company_id}/comments/search")
async def buscar(
    company_id: UUID,
    q: str = Query(..., min_length=2, max_length=200),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> list[dict[str, Any]]:
    """Comentários e anotações que citam o termo, só nos documentos que a pessoa enxerga."""
    termo = q.strip()
    rows = await admin_conn.fetch(
        """
        SELECT c.id::text, c.document_id, c.body, c.page, c.x IS NOT NULL AS anotacao, c.created_at, u.full_name AS author
        FROM public.document_comments c JOIN public.users u ON u.id = c.user_id
        WHERE c.company_id = $1 AND c.deleted_at IS NULL
          AND (to_tsvector('portuguese', c.body) @@ plainto_tsquery('portuguese', $2) OR c.body ILIKE '%' || $3 || '%')
        ORDER BY c.created_at DESC
        LIMIT 200
        """,
        company_id, termo, termo.replace("%", "").replace("_", ""),
    )
    if not rows:
        return []
    visiveis = {
        r["id"]: r for r in await conn.fetch(
            """
            SELECT d.id, d.name, d.folder_id::text,
                   (SELECT string_agg(a.name, ' / ' ORDER BY nlevel(a.path)) FROM public.folders a
                    WHERE a.company_id = f.company_id AND a.path @> f.path) AS folder_path_label
            FROM public.documents d JOIN public.folders f ON f.id = d.folder_id
            WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL
            """,
            list({r["document_id"] for r in rows}),
        )
    }
    out = []
    for r in rows:
        d = visiveis.get(r["document_id"])
        if d is None:
            continue
        out.append({"comment_id": r["id"], "document_id": str(r["document_id"]), "document_name": d["name"], "folder_id": d["folder_id"],
                    "folder_path_label": d["folder_path_label"], "body": r["body"], "page": r["page"], "anotacao": r["anotacao"],
                    "author": r["author"], "created_at": r["created_at"]})
    return out[:50]
