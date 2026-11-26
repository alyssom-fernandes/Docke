"""
Pasta de triagem (benchmark B1.1.8). Uma pasta por empresa marcada como
"Entrada": o que chega sem destino certo fica nela, e o Docke sugere a pasta,
o tipo e a competência por regras simples (sem IA), explicando o motivo:

1. NF-e: a pasta onde já estão as notas do mesmo emitente (CNPJ do XML);
2. tipo fiscal: a pasta onde mais há documentos do mesmo tipo;
3. nome: a pasta cujos documentos mais compartilham palavras do nome;
4. competência: mês/ano no nome do arquivo (03-2026, 2026_03, 032026).

Confirmar é mover pelo /documents/bulk-move de sempre (permissões e trilha
normais). Nada sai da triagem sem confirmação.
"""
import re
from datetime import date
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService

router = APIRouter(tags=["inbox"])

_PARADAS = {"para", "com", "sem", "pelo", "pela", "copia", "cópia", "final", "versao", "versão", "arquivo", "documento", "scan", "digitalizado", "img", "image"}


def palavras(nome: str) -> list[str]:
    base = nome.rsplit(".", 1)[0].lower()
    return [p for p in dict.fromkeys(re.findall(r"[a-zà-ÿ]{4,}", base)) if p not in _PARADAS][:5]


def competencia_no_nome(nome: str) -> date | None:
    base = nome.rsplit(".", 1)[0]
    for padrao, ordem in ((r"(?<!\d)(0[1-9]|1[0-2])[-_./ ]?(20\d{2})(?!\d)", "ma"), (r"(?<!\d)(20\d{2})[-_./ ]?(0[1-9]|1[0-2])(?!\d)", "am")):
        m = re.search(padrao, base)
        if m:
            mes, ano = (m.group(1), m.group(2)) if ordem == "ma" else (m.group(2), m.group(1))
            return date(int(ano), int(mes), 1)
    return None


async def _caixa(conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
    return await conn.fetchrow(
        "SELECT id::text, name, path::text FROM public.folders WHERE company_id = $1 AND is_inbox AND deleted_at IS NULL", company_id,
    )


async def _rotulo(conn: asyncpg.Connection, folder_id: str) -> str | None:
    return await conn.fetchval(
        """
        SELECT string_agg(a.name, ' / ' ORDER BY nlevel(a.path)) FROM public.folders f
        JOIN public.folders a ON a.company_id = f.company_id AND a.path @> f.path WHERE f.id = $1::uuid
        """,
        folder_id,
    )


async def sugerir(conn: asyncpg.Connection, company_id: UUID, inbox_id: str, doc: asyncpg.Record) -> dict[str, Any]:
    """Sugestão de pasta com o motivo, pela conexão da pessoa (só pastas que ela enxerga)."""
    pasta, motivo = None, None
    if doc["emitente_cnpj"]:
        pasta = await conn.fetchval(
            """
            SELECT d.folder_id::text FROM public.document_nfe n JOIN public.documents d ON d.id = n.document_id
            WHERE n.company_id = $1 AND n.emitente_cnpj = $2 AND d.deleted_at IS NULL AND d.folder_id <> $3::uuid
            GROUP BY d.folder_id ORDER BY count(*) DESC LIMIT 1
            """,
            company_id, doc["emitente_cnpj"], inbox_id,
        )
        motivo = f"Notas de {doc['emitente_nome'] or 'mesmo emitente'} ficam aqui" if pasta else None
    if not pasta and doc["tipo_fiscal"]:
        pasta = await conn.fetchval(
            """
            SELECT folder_id::text FROM public.documents
            WHERE company_id = $1 AND tipo_fiscal = $2 AND deleted_at IS NULL AND folder_id <> $3::uuid
            GROUP BY folder_id ORDER BY count(*) DESC LIMIT 1
            """,
            company_id, doc["tipo_fiscal"], inbox_id,
        )
        motivo = f"A maioria dos documentos do tipo {doc['tipo_fiscal']} fica aqui" if pasta else None
    if not pasta:
        ps = palavras(doc["name"])
        if ps:
            row = await conn.fetchrow(
                """
                SELECT d.folder_id::text AS folder_id, count(*) AS n
                FROM public.documents d, unnest($3::text[]) AS p(palavra)
                WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.folder_id <> $2::uuid AND lower(d.name) LIKE '%' || p.palavra || '%'
                GROUP BY d.folder_id ORDER BY count(*) DESC LIMIT 1
                """,
                company_id, inbox_id, ps,
            )
            if row and row["n"] >= 2:
                pasta, motivo = row["folder_id"], f"{row['n']} documentos com nome parecido ficam aqui"
    comp = competencia_no_nome(doc["name"])
    return {
        "folder_id": pasta, "folder_label": await _rotulo(conn, pasta) if pasta else None, "motivo": motivo,
        "competencia": comp.isoformat() if comp and not doc["competencia"] else None,
    }


@router.get("/companies/{company_id}/inbox")
async def triagem(company_id: UUID, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, Any]:
    caixa = await _caixa(conn, company_id)
    if caixa is None:
        return {"folder": None, "documents": []}
    docs = await conn.fetch(
        """
        SELECT d.id::text, d.name, d.tipo_fiscal, d.competencia, d.created_at, u.full_name AS uploaded_by_name,
               n.emitente_cnpj, n.emitente_nome
        FROM public.documents d
        LEFT JOIN public.users u ON u.id = d.uploaded_by
        LEFT JOIN public.document_nfe n ON n.document_id = d.id AND n.reconhecida
        WHERE d.folder_id = $1::uuid AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
        ORDER BY d.created_at
        LIMIT 200
        """,
        caixa["id"],
    )
    out = []
    for d in docs:
        out.append({"id": d["id"], "name": d["name"], "tipo_fiscal": d["tipo_fiscal"], "created_at": d["created_at"],
                    "uploaded_by_name": d["uploaded_by_name"], "sugestao": await sugerir(conn, company_id, caixa["id"], d)})
    return {"folder": dict(caixa), "documents": out}


class CaixaBody(BaseModel):
    folder_id: UUID | None = None  # sem pasta: cria "Entrada" no topo


@router.put("/companies/{company_id}/inbox")
async def definir_triagem(
    company_id: UUID,
    body: CaixaBody,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if await get_app_role(conn, claims) != "supremo" and not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador da empresa escolhe a pasta de triagem.")
    async with admin_conn.transaction():
        await admin_conn.execute("UPDATE public.folders SET is_inbox = false WHERE company_id = $1 AND is_inbox", company_id)
        if body.folder_id is None:
            fid = await admin_conn.fetchval(
                "SELECT id FROM public.folders WHERE company_id = $1 AND parent_id IS NULL AND lower(name) = 'entrada' AND deleted_at IS NULL", company_id,
            )
            if fid is None:
                label = await admin_conn.fetchval("SELECT 'f' || floor(extract(epoch FROM clock_timestamp()) * 1000)::text || lpad((random()*9999)::int::text, 4, '0')")
                fid = await admin_conn.fetchval(
                    "INSERT INTO public.folders (company_id, name, path, created_by) VALUES ($1, 'Entrada', $2::ltree, $3::uuid) RETURNING id",
                    company_id, label, claims["sub"],
                )
        else:
            fid = await admin_conn.fetchval(
                "SELECT id FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL", body.folder_id, company_id,
            )
            if fid is None:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
        await admin_conn.execute("UPDATE public.folders SET is_inbox = true WHERE id = $1", fid)
    return {"folder_id": str(fid)}
