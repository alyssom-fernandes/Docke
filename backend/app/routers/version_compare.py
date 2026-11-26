"""
Comparação de versões por partes (benchmark B2.7.5): além do texto (feito no
navegador), diz separadamente o que mudou no arquivo (tamanho e impressão
digital), nas páginas (quantas, quais mudaram de texto, quais entraram ou
saíram), nas anotações (as de cada versão) e nos metadados (as alterações
gravadas na trilha entre uma versão e a outra; os metadados não são
versionados, então a trilha é a fonte).
"""
import asyncio
import hashlib
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies import get_db, get_db_admin
from app.services import storage_service

router = APIRouter(tags=["versions"])


def textos_por_pagina(data: bytes) -> list[str]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(data)
    try:
        out = []
        for i in range(len(pdf)):
            tp = pdf[i].get_textpage()
            try:
                out.append(" ".join(tp.get_text_range().split()))
            finally:
                tp.close()
        return out
    finally:
        pdf.close()


def comparar_paginas(a: list[str], b: list[str]) -> dict[str, Any]:
    """Compara página a página pelo texto (normalizado). Páginas a partir de 1."""
    h = lambda t: hashlib.sha256(t.encode()).hexdigest()  # noqa: E731
    comuns = min(len(a), len(b))
    return {
        "antes": len(a), "depois": len(b),
        "alteradas": [i + 1 for i in range(comuns) if h(a[i]) != h(b[i])],
        "incluidas": list(range(comuns + 1, len(b) + 1)),
        "removidas": list(range(comuns + 1, len(a) + 1)),
    }


@router.get("/documents/{document_id}/versions/compare-summary")
async def resumo_comparacao(
    document_id: UUID,
    a: UUID = Query(..., description="Uma das versões."),
    b: UUID = Query(..., description="A outra versão."),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    doc = await conn.fetchrow("SELECT id, name, content_hash FROM public.documents WHERE id = $1 AND deleted_at IS NULL", document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    vs = await admin_conn.fetch(
        """
        SELECT id, version_number, storage_key, size_bytes, created_at,
               COALESCE(sha256, CASE WHEN version_number = 1 THEN $3 END) AS sha256
        FROM public.document_versions WHERE document_id = $1 AND id = ANY($2::uuid[])
        """,
        document_id, [a, b], doc["content_hash"],
    )
    if len(vs) != 2:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Versão não encontrada.")
    antiga, nova = sorted(vs, key=lambda v: v["version_number"])

    arquivo = {
        "tamanho_antes": antiga["size_bytes"], "tamanho_depois": nova["size_bytes"],
        "identico": bool(antiga["sha256"] and antiga["sha256"] == nova["sha256"]),
    }

    paginas = None
    if doc["name"].lower().endswith(".pdf"):
        try:
            da, db = await asyncio.gather(
                asyncio.to_thread(storage_service.read_object, antiga["storage_key"]),
                asyncio.to_thread(storage_service.read_object, nova["storage_key"]),
            )
            if da and db:
                ta, tb = await asyncio.gather(asyncio.to_thread(textos_por_pagina, da), asyncio.to_thread(textos_por_pagina, db))
                paginas = comparar_paginas(ta, tb)
        except Exception:
            paginas = None  # PDF protegido ou danificado: a parte de páginas fica sem resposta

    anot = await admin_conn.fetch(
        """
        SELECT c.version_id, c.body, c.page, c.x IS NOT NULL AS ponto, u.full_name AS autor
        FROM public.document_comments c JOIN public.users u ON u.id = c.user_id
        WHERE c.document_id = $1 AND c.deleted_at IS NULL AND c.version_id = ANY($2::uuid[])
        ORDER BY c.created_at
        """,
        document_id, [antiga["id"], nova["id"]],
    )
    anotacoes = {
        "antes": [{"body": r["body"], "page": r["page"], "ponto": r["ponto"], "autor": r["autor"]} for r in anot if r["version_id"] == antiga["id"]],
        "depois": [{"body": r["body"], "page": r["page"], "ponto": r["ponto"], "autor": r["autor"]} for r in anot if r["version_id"] == nova["id"]],
    }

    meta = await admin_conn.fetch(
        """
        SELECT a.created_at, u.full_name AS autor, a.metadata->>'field_label' AS campo,
               a.metadata->>'old_value' AS antes, a.metadata->>'new_value' AS depois
        FROM public.activity_log a LEFT JOIN public.users u ON u.id = a.user_id
        WHERE a.item_id = $1 AND a.action = 'update_metadata' AND a.created_at >= $2 AND a.created_at < $3
        ORDER BY a.created_at
        LIMIT 200
        """,
        document_id, antiga["created_at"], nova["created_at"],
    )
    return {
        "versao_antes": antiga["version_number"], "versao_depois": nova["version_number"],
        "arquivo": arquivo, "paginas": paginas, "anotacoes": anotacoes,
        "metadados": [dict(m) for m in meta],
    }
