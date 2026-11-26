"""
Privacidade (LGPD) — X2-17, B3.7.1, B3.7.3, B3.7.5.

- Classificar uma pasta como "dado pessoal" ou "dado sensível" (vale para as
  subpastas). Pasta com dado sensível não aceita link público.
- Atender pedido do titular: achar os documentos que citam um CPF ou nome,
  com a pasta e a classificação, e registrar a consulta na trilha (o CPF não
  é gravado em claro, só um resumo SHA-256).
"""
import hashlib
import json
import re
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService
from app.services.folders_service import FoldersService
from app.services.search_service import SearchService

router = APIRouter(tags=["privacy"])

_LABELS = {"normal": "sem classificação", "pessoal": "dado pessoal", "sensivel": "dado sensível"}


class SensitivityBody(BaseModel):
    sensitivity: str
    # B3.7.6: base legal (LGPD art. 7º/11) e finalidade do tratamento, opcionais.
    legal_basis: str | None = None
    purpose: str | None = None


BASES_LEGAIS = (
    "Cumprimento de obrigação legal ou regulatória",
    "Execução de contrato",
    "Exercício regular de direitos",
    "Proteção da vida ou da saúde",
    "Tutela da saúde",
    "Legítimo interesse",
    "Consentimento do titular",
)


@router.get("/folders/{folder_id}/privacy")
async def folder_privacy(folder_id: UUID, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, Any]:
    row = await conn.fetchrow(
        "SELECT sensitivity, legal_basis, purpose, public.folder_effective_sensitivity(id) AS effective FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
        folder_id,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    return {"sensitivity": row["sensitivity"], "effective": row["effective"], "inherited": row["effective"] != row["sensitivity"],
            "legal_basis": row["legal_basis"], "purpose": row["purpose"], "bases_legais": list(BASES_LEGAIS)}


@router.put("/folders/{folder_id}/privacy")
async def set_folder_privacy(
    folder_id: UUID,
    body: SensitivityBody,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if body.sensitivity not in _LABELS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Use normal, pessoal ou sensivel.")
    folder = await FoldersService.get_folder_for_move(conn, folder_id)
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    permission = await FoldersService.check_permission(conn, claims["sub"], folder["path"], folder["company_id"])
    if permission != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores classificam pastas.")
    old = await conn.fetchval("SELECT sensitivity FROM public.folders WHERE id = $1", folder_id)
    base = (body.legal_basis or "").strip()[:120] or None
    finalidade = (body.purpose or "").strip()[:500] or None
    await conn.execute("UPDATE public.folders SET sensitivity = $2, legal_basis = $3, purpose = $4 WHERE id = $1",
                       folder_id, body.sensitivity, base if body.sensitivity != "normal" else None,
                       finalidade if body.sensitivity != "normal" else None)
    if old != body.sensitivity:
        await FoldersService.log_activity(
            conn, folder_id=folder_id, company_id=folder["company_id"], action="privacy_set", name=folder["name"],
            metadata=json.dumps({"de": _LABELS[old], "para": _LABELS[body.sensitivity]}, ensure_ascii=False),
        )
    effective = await conn.fetchval("SELECT public.folder_effective_sensitivity($1)", folder_id)
    return {"sensitivity": body.sensitivity, "effective": effective, "inherited": effective != body.sensitivity,
            "legal_basis": base if body.sensitivity != "normal" else None, "purpose": finalidade if body.sensitivity != "normal" else None}


@router.get("/companies/{company_id}/privacy/folders")
async def sensitive_folders(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Pastas classificadas da empresa (o inventário começa por elas)."""
    rows = await conn.fetch(
        """
        SELECT f.id::text, f.name, f.sensitivity, f.path::text AS path, f.legal_basis, f.purpose,
               (SELECT count(*) FROM public.documents d JOIN public.folders s ON s.id = d.folder_id
                 WHERE s.company_id = f.company_id AND s.path <@ f.path AND d.deleted_at IS NULL) AS documentos
        FROM public.folders f
        WHERE f.company_id = $1 AND f.deleted_at IS NULL AND f.sensitivity <> 'normal'
        ORDER BY f.sensitivity DESC, f.name
        """,
        company_id,
    )
    return [dict(r) for r in rows]


@router.get("/companies/{company_id}/privacy/titular")
async def titular_search(
    company_id: UUID,
    q: str = Query(..., min_length=3, max_length=120, description="CPF (com ou sem pontuação) ou nome do titular."),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Pedido do titular (LGPD art. 18): documentos que citam o CPF ou o nome,
    com pasta e classificação. Só administradores da empresa. A consulta fica
    na trilha com o resumo SHA-256 do termo, nunca o CPF em claro.
    """
    role = await get_app_role(conn, claims)
    if role != "supremo" and not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores da empresa atendem pedidos do titular.")
    termo = q.strip()
    normalized = SearchService.normalize_query(termo)
    if not normalized and not SearchService.digits_pattern(termo):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Informe um CPF ou um nome.")
    result = await SearchService.search(
        conn, q=termo, normalized=normalized or termo, company_id=company_id, folder_id=None,
        sector=None, file_type=None, page=1, page_size=100,
    )
    docs = result.get("results", [])
    ids = [UUID(d["id"]) for d in docs if d.get("id")]
    sens = {}
    if ids:
        for r in await conn.fetch(
            "SELECT d.id::text, public.folder_effective_sensitivity(d.folder_id) AS s FROM public.documents d WHERE d.id = ANY($1::uuid[])", ids,
        ):
            sens[r["id"]] = r["s"]
    for d in docs:
        d["sensitivity"] = sens.get(d.get("id"), "normal")

    digits = re.sub(r"\D", "", termo)
    resumo = hashlib.sha256((digits if len(digits) >= 11 else termo.lower()).encode()).hexdigest()[:16]
    await conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata, severity)
        VALUES ($1, $2, 'lgpd_titular_search', 'config', $2, 'Pedido do titular', $3::jsonb, 'warning')
        """,
        claims["sub"], company_id, json.dumps({"termo_sha256": resumo, "encontrados": result.get("total", len(docs))}),
    )
    return {"total": result.get("total", len(docs)), "results": docs}


@router.get("/companies/{company_id}/privacy/report")
async def dpo_report(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
):
    """
    Relatório para o encarregado de dados (B3.7.7), em CSV: quem acessa as
    pastas com dado pessoal ou sensível, os links públicos que apontam para
    elas e as consultas de pedidos do titular. Só administradores; a emissão
    fica na trilha.
    """
    from datetime import date

    from fastapi.responses import Response

    role = await get_app_role(conn, claims)
    if role != "supremo" and not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores da empresa emitem o relatório de privacidade.")

    pastas = await admin_conn.fetch(
        """
        SELECT f.id, f.name, f.path, public.folder_effective_sensitivity(f.id) AS s, f.legal_basis, f.purpose
        FROM public.folders f
        WHERE f.company_id = $1 AND f.deleted_at IS NULL
        ORDER BY f.path
        """,
        company_id,
    )
    marcadas = [p for p in pastas if p["s"] in ("pessoal", "sensivel")]
    # Raiz de cada trecho marcado (as subpastas herdam): uma linha por pasta marcada de fato.
    raizes = [p for p in marcadas if not any(o is not p and str(p["path"]).startswith(str(o["path"]) + ".") for o in marcadas)]
    pessoas = await admin_conn.fetch(
        """
        SELECT DISTINCT u.id, u.full_name, u.is_active
        FROM public.users u
        WHERE u.id IN (
          SELECT user_id FROM public.user_company_access WHERE company_id = $1
          UNION SELECT gm.user_id FROM public.group_member gm JOIN public.group_access ga ON ga.group_id = gm.group_id WHERE ga.company_id = $1
        )
        ORDER BY u.full_name
        """,
        company_id,
    )
    linhas: list[list[str]] = [["Seção", "Pasta ou item", "Classificação", "Pessoa ou detalhe", "Papel ou situação", "Data"]]
    rotulo = {"pessoal": "Dado pessoal", "sensivel": "Dado sensível"}
    for p in raizes:
        if p["legal_basis"] or p["purpose"]:
            linhas.append(["Base legal e finalidade", p["name"], rotulo[p["s"]], p["legal_basis"] or "—", p["purpose"] or "—", ""])
        for u in pessoas:
            papel = await admin_conn.fetchval("SELECT public.user_has_access($1, $2, $3)", u["id"], p["path"], company_id)
            if papel:
                linhas.append(["Quem acessa", p["name"], rotulo[p["s"]], u["full_name"],
                               papel + ("" if u["is_active"] else " (conta desativada)"), ""])

    links = await admin_conn.fetch(
        """
        SELECT s.resource_type, coalesce(d.name, f.name) AS nome, s.created_at, s.expires_at, s.view_count,
               s.password_hash IS NOT NULL AS com_senha, u.full_name AS criado_por,
               public.folder_effective_sensitivity(coalesce(d.folder_id, f.id)) AS s
        FROM public.shares s
        LEFT JOIN public.documents d ON s.resource_type = 'document' AND d.id = s.resource_id
        LEFT JOIN public.folders f ON s.resource_type = 'folder' AND f.id = s.resource_id
        LEFT JOIN public.users u ON u.id = s.created_by
        WHERE s.company_id = $1 AND s.revoked_at IS NULL AND s.expired_at IS NULL
          AND (s.expires_at IS NULL OR s.expires_at > now())
        ORDER BY s.created_at DESC
        """,
        company_id,
    )
    for lk in links:
        if lk["s"] not in ("pessoal", "sensivel"):
            continue
        detalhe = f"criado por {lk['criado_por'] or '—'}; {'com senha' if lk['com_senha'] else 'sem senha'}; {lk['view_count'] or 0} aberturas"
        validade = lk["expires_at"].strftime("%d/%m/%Y") if lk["expires_at"] else "sem validade"
        linhas.append(["Link público ativo", lk["nome"] or "item", rotulo[lk["s"]], detalhe, f"vale até {validade}",
                       lk["created_at"].strftime("%d/%m/%Y")])

    pedidos = await admin_conn.fetch(
        """
        SELECT a.created_at, u.full_name, a.metadata->>'termo_sha256' AS resumo, a.metadata->>'encontrados' AS docs
        FROM public.activity_log a LEFT JOIN public.users u ON u.id = a.user_id
        WHERE a.company_id = $1 AND a.action = 'lgpd_titular_search'
        ORDER BY a.created_at DESC
        LIMIT 500
        """,
        company_id,
    )
    for pd in pedidos:
        linhas.append(["Pedido do titular (consulta)", f"termo {pd['resumo'] or '—'} (resumo SHA-256)", "",
                       pd["full_name"] or "—", f"{pd['docs'] or '?'} documentos achados", pd["created_at"].strftime("%d/%m/%Y %H:%M")])
    if len(linhas) == 1:
        linhas.append(["Sem registros", "Nenhuma pasta marcada como dado pessoal ou sensível nesta empresa.", "", "", "", ""])

    await conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
        VALUES ($1::uuid, $2, 'lgpd_report', 'config', $2, 'Relatório de privacidade', $3::jsonb)
        """,
        claims["sub"], company_id, json.dumps({"linhas": len(linhas) - 1}),
    )
    corpo = "\ufeff" + "\r\n".join(";".join('"' + str(c).replace('"', '""') + '"' for c in linha) for linha in linhas)
    return Response(corpo, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="privacidade_{date.today().isoformat()}.csv"'})
