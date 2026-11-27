"""
Obrigação por colaborador: exames ocupacionais (ASO) com matriz colaborador ×
exame (FA-A7-05).

Para cada colaborador a matriz diz, por exame:
- admissional: feito, ou pendente/atrasado em relação à data de admissão;
- periódico: o próximo vence `periodic_months` depois do último exame
  (admissional, periódico, retorno ou mudança de risco); avisa 30 dias antes;
- demissional: só depois do desligamento, com prazo padrão de 10 dias
  (ajustável no PCMSO da empresa; aqui é só o aviso).
Exame é dado de saúde: só o admin da empresa (ou o administrador geral) vê e
registra. A trilha guarda o tipo do exame, nunca o resultado.
"""
from datetime import date, timedelta
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService
from app.services import features_service

router = APIRouter(tags=["employees"])

AVISO_DIAS = 30
PRAZO_DEMISSIONAL_DIAS = 10
Exame = Literal["admissional", "periodico", "retorno", "mudanca_risco", "demissional"]


async def _exigir_admin(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID | str) -> None:
    if await get_app_role(conn, claims) == "supremo":
        return
    if not await CompaniesService.user_manages_company(conn, claims["sub"], UUID(str(company_id))):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Exames ocupacionais são dado de saúde: só o administrador da empresa vê e registra.")


def _somar_meses(d: date, meses: int) -> date:
    ano, mes = divmod(d.month - 1 + meses, 12)
    ano, mes = d.year + ano, mes + 1
    dias = [31, 29 if ano % 4 == 0 and (ano % 100 != 0 or ano % 400 == 0) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mes - 1]
    return date(ano, mes, min(d.day, dias))


def situacao(emp: dict[str, Any], exames: list[dict[str, Any]], hoje: date) -> dict[str, Any]:
    """Estado de cada exame do colaborador. Função pura (testada sem banco)."""
    por_tipo: dict[str, list[date]] = {}
    for e in exames:
        por_tipo.setdefault(e["kind"], []).append(e["exam_date"])
    deslig = emp.get("termination_date")
    desligado = deslig is not None and deslig <= hoje

    adm = max(por_tipo.get("admissional", []), default=None)
    if adm:
        admissional = {"estado": "ok", "data": adm}
    else:
        admissional = {"estado": "atrasado" if emp["admission_date"] <= hoje else "pendente", "prazo": emp["admission_date"]}

    bases = [d for k in ("admissional", "periodico", "retorno", "mudanca_risco") for d in por_tipo.get(k, [])]
    ultimo = max(bases, default=None)
    if desligado:
        periodico = {"estado": "nao_se_aplica"}
    elif ultimo is None:
        periodico = {"estado": "pendente", "motivo": "sem exame admissional"}
    else:
        proximo = _somar_meses(ultimo, emp["periodic_months"])
        estado = "atrasado" if proximo < hoje else "vence_logo" if (proximo - hoje).days <= AVISO_DIAS else "ok"
        periodico = {"estado": estado, "ultimo": ultimo, "prazo": proximo}

    if deslig is None:
        demissional = {"estado": "nao_se_aplica"}
    elif por_tipo.get("demissional"):
        demissional = {"estado": "ok", "data": max(por_tipo["demissional"])}
    else:
        prazo = deslig + timedelta(days=PRAZO_DEMISSIONAL_DIAS)
        demissional = {"estado": "atrasado" if prazo < hoje else "pendente", "prazo": prazo}
    return {"admissional": admissional, "periodico": periodico, "demissional": demissional}


class ColaboradorBody(BaseModel):
    name: str = Field(..., min_length=2, max_length=200)
    registration: str | None = Field(None, max_length=40)
    role_title: str | None = Field(None, max_length=120)
    admission_date: date
    termination_date: date | None = None
    periodic_months: int = Field(12, ge=1, le=60)


class ColaboradorMuda(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=200)
    registration: str | None = Field(None, max_length=40)
    role_title: str | None = Field(None, max_length=120)
    admission_date: date | None = None
    termination_date: date | None = None
    limpar_desligamento: bool = False
    periodic_months: int | None = Field(None, ge=1, le=60)


class ExameBody(BaseModel):
    kind: Exame
    exam_date: date
    result: Literal["apto", "apto_restricao", "inapto"] = "apto"
    document_id: UUID | None = None
    notes: str | None = Field(None, max_length=500)


async def _trilha(admin_conn: asyncpg.Connection, *, user_id: str, company_id: str, action: str, item_id: str, nome: str, meta: dict[str, Any]) -> None:
    import json
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
        VALUES ($1::uuid, $2::uuid, $3, 'config', $4::uuid, $5, 'config', $6::jsonb)
        """,
        user_id, company_id, action, item_id, nome[:200], json.dumps(meta, default=str),
    )


@router.get("/companies/{company_id}/employees")
async def matriz(
    company_id: UUID,
    incluir_desligados: bool = Query(False),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    hoje = date.today()
    emps = await admin_conn.fetch(
        """
        SELECT id::text, name, registration, role_title, admission_date, termination_date, periodic_months
        FROM public.employees
        WHERE company_id = $1 AND archived_at IS NULL
          AND ($2 OR termination_date IS NULL OR termination_date + $3::int >= current_date - 60)
        ORDER BY lower(name)
        """,
        company_id, incluir_desligados, PRAZO_DEMISSIONAL_DIAS,
    )
    exames = await admin_conn.fetch(
        """
        SELECT e.employee_id::text, e.id::text, e.kind, e.exam_date, e.result, e.document_id::text, d.name AS document_name, d.folder_id::text
        FROM public.employee_exams e LEFT JOIN public.documents d ON d.id = e.document_id AND d.deleted_at IS NULL
        WHERE e.company_id = $1 ORDER BY e.exam_date DESC
        """,
        company_id,
    )
    por_emp: dict[str, list[dict[str, Any]]] = {}
    for e in exames:
        por_emp.setdefault(e["employee_id"], []).append(dict(e))
    linhas, resumo = [], {"atrasado": 0, "vence_logo": 0, "pendente": 0}
    for emp in emps:
        sit = situacao(dict(emp), por_emp.get(emp["id"], []), hoje)
        for v in sit.values():
            if v["estado"] in resumo:
                resumo[v["estado"]] += 1
        linhas.append({**dict(emp), "situacao": sit, "exames": por_emp.get(emp["id"], [])[:20]})
    return {"colaboradores": linhas, "resumo": resumo, "aviso_dias": AVISO_DIAS, "prazo_demissional_dias": PRAZO_DEMISSIONAL_DIAS}


@router.post("/companies/{company_id}/employees", status_code=status.HTTP_201_CREATED)
async def cadastrar(
    company_id: UUID,
    body: ColaboradorBody,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    await features_service.require(conn, company_id, "exames")
    if body.termination_date and body.termination_date < body.admission_date:
        raise HTTPException(status_code=422, detail="O desligamento não pode ser antes da admissão.")
    eid = await admin_conn.fetchval(
        """
        INSERT INTO public.employees (company_id, name, registration, role_title, admission_date, termination_date, periodic_months, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid) RETURNING id::text
        """,
        company_id, body.name.strip(), (body.registration or "").strip() or None, (body.role_title or "").strip() or None,
        body.admission_date, body.termination_date, body.periodic_months, claims["sub"],
    )
    await _trilha(admin_conn, user_id=claims["sub"], company_id=str(company_id), action="employee_created", item_id=eid, nome=body.name, meta={})
    return {"id": eid}


async def _colaborador(admin_conn: asyncpg.Connection, employee_id: UUID) -> asyncpg.Record:
    row = await admin_conn.fetchrow(
        "SELECT id::text, company_id::text, name, admission_date, termination_date FROM public.employees WHERE id = $1 AND archived_at IS NULL", employee_id,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Colaborador não encontrado.")
    return row


@router.patch("/employees/{employee_id}")
async def alterar(
    employee_id: UUID,
    body: ColaboradorMuda,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    emp = await _colaborador(admin_conn, employee_id)
    await _exigir_admin(conn, claims, emp["company_id"])
    adm = body.admission_date or emp["admission_date"]
    deslig = None if body.limpar_desligamento else (body.termination_date or emp["termination_date"])
    if deslig and deslig < adm:
        raise HTTPException(status_code=422, detail="O desligamento não pode ser antes da admissão.")
    await admin_conn.execute(
        """
        UPDATE public.employees SET name = COALESCE($2, name), registration = COALESCE($3, registration),
               role_title = COALESCE($4, role_title), admission_date = $5, termination_date = $6,
               periodic_months = COALESCE($7, periodic_months)
        WHERE id = $1
        """,
        employee_id, body.name.strip() if body.name else None, body.registration, body.role_title, adm, deslig, body.periodic_months,
    )
    await _trilha(admin_conn, user_id=claims["sub"], company_id=emp["company_id"], action="employee_updated", item_id=emp["id"], nome=body.name or emp["name"],
                  meta={"desligamento": deslig})
    return {"id": emp["id"]}


@router.delete("/employees/{employee_id}", status_code=status.HTTP_204_NO_CONTENT)
async def arquivar(
    employee_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    emp = await _colaborador(admin_conn, employee_id)
    await _exigir_admin(conn, claims, emp["company_id"])
    await admin_conn.execute("UPDATE public.employees SET archived_at = now() WHERE id = $1", employee_id)
    await _trilha(admin_conn, user_id=claims["sub"], company_id=emp["company_id"], action="employee_archived", item_id=emp["id"], nome=emp["name"], meta={})


@router.post("/employees/{employee_id}/exams", status_code=status.HTTP_201_CREATED)
async def registrar_exame(
    employee_id: UUID,
    body: ExameBody,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    emp = await _colaborador(admin_conn, employee_id)
    await _exigir_admin(conn, claims, emp["company_id"])
    await features_service.require(conn, emp["company_id"], "exames")
    if body.exam_date > date.today() + timedelta(days=1):
        raise HTTPException(status_code=422, detail="A data do exame não pode estar no futuro.")
    if body.document_id is not None and not await admin_conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM public.documents WHERE id = $1 AND company_id = $2::uuid AND deleted_at IS NULL)", body.document_id, emp["company_id"],
    ):
        raise HTTPException(status_code=422, detail="O ASO escolhido não é um documento desta empresa.")
    xid = await admin_conn.fetchval(
        """
        INSERT INTO public.employee_exams (employee_id, company_id, kind, exam_date, result, document_id, notes, created_by)
        VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8::uuid) RETURNING id::text
        """,
        employee_id, emp["company_id"], body.kind, body.exam_date, body.result, body.document_id, (body.notes or "").strip() or None, claims["sub"],
    )
    await _trilha(admin_conn, user_id=claims["sub"], company_id=emp["company_id"], action="aso_registered", item_id=emp["id"], nome=emp["name"],
                  meta={"exame": body.kind, "data": body.exam_date})
    return {"id": xid}


@router.delete("/employee-exams/{exam_id}", status_code=status.HTTP_204_NO_CONTENT)
async def apagar_exame(
    exam_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    x = await admin_conn.fetchrow(
        "SELECT x.company_id::text, x.kind, x.employee_id::text, e.name FROM public.employee_exams x JOIN public.employees e ON e.id = x.employee_id WHERE x.id = $1",
        exam_id,
    )
    if x is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Exame não encontrado.")
    await _exigir_admin(conn, claims, x["company_id"])
    await admin_conn.execute("DELETE FROM public.employee_exams WHERE id = $1", exam_id)
    await _trilha(admin_conn, user_id=claims["sub"], company_id=x["company_id"], action="aso_removed", item_id=x["employee_id"], nome=x["name"], meta={"exame": x["kind"]})
