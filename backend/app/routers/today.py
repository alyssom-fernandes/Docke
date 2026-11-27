"""
"O que fazer hoje" (achados A3-01, A3-24, A3-25 e "visão do grupo" da
avaliação de 25/11/2026): uma lista única de atenção por empresa — obrigações
vencidas e a vencer, documentos cujo texto não foi lido, itens da lixeira
prestes a sumir, documentos com retenção vencida esperando revisão e links que
expiram — e o mesmo resumo para todas as empresas que a pessoa acessa.
Tudo pela conexão do usuário (RLS): cada um só vê o que já enxerga.
"""
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from app.dependencies import get_current_user, get_db
from app.services.obligations_service import period_label
from app.services import features_service

router = APIRouter(prefix="/today", tags=["today"])

_SUMMARY_SQL = """
SELECT
  (SELECT count(*) FROM public.obligation_instances i JOIN public.obligation_templates t ON t.id = i.template_id
     WHERE i.company_id = $1 AND t.archived_at IS NULL AND i.status = 'pending' AND i.due_date < CURRENT_DATE) AS obrigacoes_vencidas,
  (SELECT count(*) FROM public.obligation_instances i JOIN public.obligation_templates t ON t.id = i.template_id
     WHERE i.company_id = $1 AND t.archived_at IS NULL AND i.status = 'pending'
       AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7) AS obrigacoes_semana,
  (SELECT count(*) FROM public.obligation_instances i JOIN public.obligation_templates t ON t.id = i.template_id
     WHERE i.company_id = $1 AND t.archived_at IS NULL AND i.status = 'reviewing') AS obrigacoes_conferir,
  (SELECT count(*) FROM public.documents d
     WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL AND d.ocr_status = 'failed') AS texto_com_falha,
  (SELECT count(*) FROM public.retention_review_queue q
     WHERE q.company_id = $1 AND q.status = 'pending') AS retencao_para_revisar,
  (SELECT count(*) FROM public.shares s
     WHERE s.company_id = $1 AND s.revoked_at IS NULL AND s.expires_at BETWEEN now() AND now() + interval '3 days') AS links_vencendo
"""


async def _summary(conn: asyncpg.Connection, company_id: UUID) -> dict[str, int]:
    row = await conn.fetchrow(_SUMMARY_SQL, company_id)
    out = {k: int(v or 0) for k, v in dict(row).items()}
    # Recurso desligado não gera aviso no Início nem na navegação.
    recursos = await features_service.company_features(conn, company_id)
    if not recursos["obrigacoes"]:
        out.update(obrigacoes_vencidas=0, obrigacoes_semana=0, obrigacoes_conferir=0)
    if not recursos["links"]:
        out["links_vencendo"] = 0
    if not recursos["ocr"]:
        out["texto_com_falha"] = 0
    return out


@router.get("/company/{company_id}/resumo")
async def today_company_summary(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, int]:
    """Só os contadores, para os avisos na navegação (A2-13): consulta leve."""
    if not await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)",
        claims["sub"], company_id,
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem acesso a esta empresa.")
    return await _summary(conn, company_id)


@router.get("/company/{company_id}")
async def today_company(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if not await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2)",
        claims["sub"], company_id,
    ):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem acesso a esta empresa.")
    summary = await _summary(conn, company_id)
    recursos = await features_service.company_features(conn, company_id)
    modelos = await conn.fetchval(
        "SELECT count(*) FROM public.obligation_templates WHERE company_id = $1 AND archived_at IS NULL", company_id,
    )
    obrigacoes = [{**dict(r), "period_label": period_label(r["period"])} for r in await conn.fetch(
        """
        SELECT i.id::text, t.name, i.period, i.due_date, i.status, t.criticality,
               u.full_name AS responsavel, (CURRENT_DATE - i.due_date) AS dias_atraso
        FROM public.obligation_instances i
        JOIN public.obligation_templates t ON t.id = i.template_id
        LEFT JOIN public.users u ON u.id = i.owner_id
        WHERE i.company_id = $1 AND t.archived_at IS NULL AND i.status = 'pending' AND i.due_date <= CURRENT_DATE + 7
        ORDER BY i.due_date, t.criticality DESC
        LIMIT 8
        """,
        company_id,
    )]
    falhas = [dict(r) for r in await conn.fetch(
        """
        SELECT d.id::text, d.name, d.folder_id::text
        FROM public.documents d
        WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL AND d.ocr_status = 'failed'
        ORDER BY d.updated_at DESC
        LIMIT 5
        """,
        company_id,
    )]
    if not recursos["obrigacoes"]:
        obrigacoes, modelos = [], 0
    if not recursos["ocr"]:
        falhas = []
    return {"resumo": summary, "modelos_obrigacao": int(modelos or 0), "obrigacoes": obrigacoes, "texto_com_falha": falhas}


@router.get("/group")
async def today_group(
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """O mesmo resumo para cada empresa que a pessoa acessa (visão do grupo)."""
    companies = await conn.fetch(
        """
        SELECT DISTINCT c.id, c.name FROM public.companies c
        JOIN public.user_company_access a ON a.company_id = c.id
        WHERE a.user_id = $1 AND c.is_active
        ORDER BY c.name
        """,
        claims["sub"],
    )
    out = []
    for c in companies:
        s = await _summary(conn, c["id"])
        out.append({"company_id": str(c["id"]), "name": c["name"], **s,
                    "total": s["obrigacoes_vencidas"] + s["obrigacoes_semana"] + s["obrigacoes_conferir"]
                    + s["texto_com_falha"] + s["retencao_para_revisar"]})
    return out
