"""
Revisão periódica de acessos (achados A9-21, FA-A9-05, B3.1.7 e B3.7.8 da
avaliação de 25/11/2026).

Quem administra a empresa abre uma campanha com responsável e prazo. A API
tira a foto de quem acessa o quê naquele dia (acessos diretos e por grupo) e o
responsável decide, pessoa a pessoa, "manter" ou "retirar", com observação.
Retirar aqui só registra a decisão: o acesso é tirado em Pessoas e acessos,
pelo caminho de sempre (que também fica na trilha). A campanha fecha quando
todas as pessoas têm decisão; se repete, a próxima já nasce com o novo prazo.
O CSV da campanha é a evidência da revisão.
"""
import csv
import io
import json
from datetime import date, timedelta
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService

router = APIRouter(tags=["access-reviews"])

_PAPEL = {"admin": "Administrador", "operador": "Operador", "visualizador": "Visualizador"}


async def _require_admin(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID) -> None:
    role = await get_app_role(conn, claims)
    if role == "supremo":
        return
    if not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só quem administra a empresa revisa os acessos.")


def _somar_meses(d: date, meses: int) -> date:
    ano, mes = divmod(d.month - 1 + meses, 12)
    ano += d.year
    mes += 1
    dia = min(d.day, [31, 29 if ano % 4 == 0 and (ano % 100 != 0 or ano % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1])
    return date(ano, mes, dia)


async def _abrir(admin_conn: asyncpg.Connection, company_id: UUID, title: str, reviewer_id: UUID, due: date,
                 repeat: int | None, created_by: str) -> str:
    """Cria a campanha com a foto atual das pessoas e avisa o responsável."""
    pessoas = await CompaniesService.list_people(admin_conn, company_id)
    async with admin_conn.transaction():
        rid = await admin_conn.fetchval(
            """
            INSERT INTO public.access_reviews (company_id, title, reviewer_id, due_date, repeat_months, created_by)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text
            """,
            company_id, title, reviewer_id, due, repeat, created_by,
        )
        for p in pessoas:
            if not p.get("is_active", True):
                continue
            acessos = [
                {"papel": g.get("role"), "onde": g.get("folder_name") or "Empresa toda", "origem": "direto", "ate": g.get("expires_at")}
                for g in p.get("grants") or []
            ] + [
                {"papel": g.get("role"), "onde": g.get("folder_name") or "Empresa toda", "origem": f"grupo {g.get('group_name')}"}
                for g in p.get("via_groups") or []
            ]
            if not acessos:
                continue
            await admin_conn.execute(
                """
                INSERT INTO public.access_review_items (review_id, user_id, person_name, email, snapshot)
                VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING
                """,
                rid, p["user_id"], p["full_name"], p.get("email"), json.dumps(acessos, default=str),
            )
        await admin_conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
            VALUES ($1, $2, 'access_review', 'access_review', $3::uuid, $4)
            """,
            reviewer_id, company_id, rid, f'Você é o responsável pela revisão de acessos "{title}", até {due.strftime("%d/%m/%Y")}.',
        )
    return rid


class ReviewCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    reviewer_id: UUID
    due_date: date
    repeat_months: Literal[3, 6, 12] | None = None


@router.get("/companies/{company_id}/access-reviews")
async def list_reviews(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    await _require_admin(conn, claims, company_id)
    rows = await admin_conn.fetch(
        """
        SELECT r.id::text, r.title, r.due_date, r.repeat_months, r.created_at, r.closed_at,
               r.reviewer_id::text, u.full_name AS reviewer_name,
               (SELECT count(*) FROM public.access_review_items i WHERE i.review_id = r.id) AS total,
               (SELECT count(*) FROM public.access_review_items i WHERE i.review_id = r.id AND i.decision IS NOT NULL) AS decididos,
               (SELECT count(*) FROM public.access_review_items i WHERE i.review_id = r.id AND i.decision = 'retirar') AS retirar
        FROM public.access_reviews r JOIN public.users u ON u.id = r.reviewer_id
        WHERE r.company_id = $1
        ORDER BY r.closed_at NULLS FIRST, r.created_at DESC
        """,
        company_id,
    )
    return [dict(r) for r in rows]


@router.post("/companies/{company_id}/access-reviews", status_code=status.HTTP_201_CREATED)
async def create_review(
    company_id: UUID,
    body: ReviewCreate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _require_admin(conn, claims, company_id)
    if body.due_date < date.today():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O prazo não pode ser no passado.")
    eh_admin = await admin_conn.fetchval(
        """
        SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2
                       AND folder_path IS NULL AND permission_level = 'admin')
            OR EXISTS (SELECT 1 FROM public.users WHERE id = $1 AND role = 'supremo')
        """,
        body.reviewer_id, company_id,
    )
    if not eh_admin:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O responsável precisa administrar a empresa toda.")
    rid = await _abrir(admin_conn, company_id, body.title.strip(), body.reviewer_id, body.due_date, body.repeat_months, claims["sub"])
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="access_review_open",
                                      target_id=rid, target_name=body.title.strip(),
                                      metadata={"prazo": body.due_date.isoformat(), "repete_meses": body.repeat_months})
    return {"id": rid}


@router.get("/access-reviews/{review_id}")
async def get_review(
    review_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    r = await admin_conn.fetchrow(
        """
        SELECT r.id::text, r.company_id, r.title, r.due_date, r.repeat_months, r.created_at, r.closed_at,
               r.reviewer_id::text, u.full_name AS reviewer_name
        FROM public.access_reviews r JOIN public.users u ON u.id = r.reviewer_id WHERE r.id = $1
        """,
        review_id,
    )
    if r is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Revisão não encontrada.")
    await _require_admin(conn, claims, r["company_id"])
    itens = await admin_conn.fetch(
        """
        SELECT i.id::text, i.user_id::text, i.person_name, i.email, i.snapshot, i.decision, i.note, i.decided_at,
               d.full_name AS decided_by_name
        FROM public.access_review_items i LEFT JOIN public.users d ON d.id = i.decided_by
        WHERE i.review_id = $1 ORDER BY i.person_name
        """,
        review_id,
    )
    out = {k: v for k, v in dict(r).items() if k != "company_id"}
    out["company_id"] = str(r["company_id"])
    out["items"] = [{**dict(i), "snapshot": json.loads(i["snapshot"]) if isinstance(i["snapshot"], str) else i["snapshot"]} for i in itens]
    return out


class Decision(BaseModel):
    decision: Literal["manter", "retirar"]
    note: str | None = Field(default=None, max_length=500)


@router.post("/access-reviews/{review_id}/items/{item_id}")
async def decide(
    review_id: UUID,
    item_id: UUID,
    body: Decision,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    r = await admin_conn.fetchrow("SELECT company_id, title, closed_at, due_date, repeat_months, reviewer_id FROM public.access_reviews WHERE id = $1", review_id)
    if r is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Revisão não encontrada.")
    await _require_admin(conn, claims, r["company_id"])
    if r["closed_at"] is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Esta revisão já foi concluída.")
    if body.decision == "retirar" and not (body.note or "").strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Diga por que retirar (fica como evidência da revisão).")
    item = await admin_conn.fetchrow(
        """
        UPDATE public.access_review_items SET decision = $3, note = $4, decided_by = $5::uuid, decided_at = now()
        WHERE id = $1 AND review_id = $2 RETURNING person_name, user_id
        """,
        item_id, review_id, body.decision, (body.note or "").strip() or None, claims["sub"],
    )
    if item is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pessoa não encontrada nesta revisão.")
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=r["company_id"], action="access_review_decision",
                                      target_id=item["user_id"], target_name=item["person_name"],
                                      metadata={"revisao": r["title"], "decisao": body.decision, "motivo": (body.note or "").strip() or None})
    faltam = await admin_conn.fetchval("SELECT count(*) FROM public.access_review_items WHERE review_id = $1 AND decision IS NULL", review_id)
    proxima = None
    if faltam == 0:
        await admin_conn.execute("UPDATE public.access_reviews SET closed_at = now(), closed_by = $2::uuid WHERE id = $1", review_id, claims["sub"])
        await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=r["company_id"], action="access_review_close",
                                          target_id=review_id, target_name=r["title"])
        if r["repeat_months"]:
            prazo = _somar_meses(max(r["due_date"], date.today()), r["repeat_months"])
            proxima = await _abrir(admin_conn, r["company_id"], r["title"], r["reviewer_id"], prazo, r["repeat_months"], claims["sub"])
    return {"faltam": faltam, "concluida": faltam == 0, "proxima": proxima}


@router.get("/access-reviews/{review_id}/evidence.csv")
async def evidence(
    review_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> Response:
    """Evidência da revisão: o que cada pessoa tinha, a decisão, quem decidiu e quando."""
    dados = await get_review(review_id, conn, admin_conn, claims)
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["revisao", "responsavel", "prazo", "concluida_em", "pessoa", "email", "acessos_no_inicio", "decisao", "motivo", "decidido_por", "decidido_em"])
    for i in dados["items"]:
        acessos = " | ".join(f'{_PAPEL.get(a.get("papel"), a.get("papel"))} em {a.get("onde")} ({a.get("origem")})' for a in i["snapshot"])
        w.writerow([dados["title"], dados["reviewer_name"], dados["due_date"], dados["closed_at"] or "", i["person_name"], i["email"] or "",
                    acessos, i["decision"] or "pendente", i["note"] or "", i["decided_by_name"] or "", i["decided_at"] or ""])
    nome = f'revisao-de-acessos_{str(dados["due_date"])}.csv'
    return Response(content="﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{nome}"'})


# Lembrete do prazo: usado pelo worker de manutenção uma vez por dia.
async def lembrar_prazos(admin_conn: asyncpg.Connection) -> int:
    rows = await admin_conn.fetch(
        """
        SELECT r.id, r.company_id, r.title, r.reviewer_id, r.due_date
        FROM public.access_reviews r
        WHERE r.closed_at IS NULL AND r.due_date IN (CURRENT_DATE + 7, CURRENT_DATE + 1, CURRENT_DATE - 1)
          AND NOT EXISTS (SELECT 1 FROM public.notifications n WHERE n.type = 'access_review' AND n.resource_id = r.id
                          AND n.created_at::date = CURRENT_DATE)
        """
    )
    for r in rows:
        quando = "venceu ontem" if r["due_date"] < date.today() else ("vence amanhã" if r["due_date"] - date.today() == timedelta(days=1) else "vence em 7 dias")
        await admin_conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
            VALUES ($1, $2, 'access_review', 'access_review', $3, $4)
            """,
            r["reviewer_id"], r["company_id"], r["id"], f'A revisão de acessos "{r["title"]}" {quando}.',
        )
    return len(rows)
