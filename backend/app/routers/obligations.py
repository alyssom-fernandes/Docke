"""
Fase 4.1 — Modelo de Obrigações (Obrigação → Documento comprobatório).

Gestão de templates é exclusiva de admin/supremo (mesmo bucket de config de
empresa que custom_fields.py). Instâncias (revisar status, vincular/
desvincular documento) são liberadas a admin OU operador — quem processa o
dia a dia fiscal/RH normalmente não é admin da empresa. A permissão real é
garantida pela RLS (20260723000021_obligation_model.sql); os checks aqui só
existem para devolver 403 com mensagem clara em vez de deixar a RLS silenciar
em 404/lista vazia.
"""
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator

from app.dependencies import get_app_role, get_current_user, get_db
from app.services.companies_service import CompaniesService
from app.services.obligations_service import ObligationsService

router = APIRouter(tags=["obligations"])

FREQUENCIES = ("mensal", "anual", "unica", "evento")
CRITICALITIES = ("baixa", "media", "alta", "critica")
MANUAL_STATUSES = ("reviewing", "approved", "dispensado", "cancelado")


async def _require_admin(conn: asyncpg.Connection, user_id: str, company_id: UUID, role: str) -> None:
    if role == "supremo":
        return
    if await CompaniesService.user_manages_company(conn, user_id, company_id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas admin ou supremo gerenciam obrigações.")


async def _require_operator(conn: asyncpg.Connection, user_id: str, company_id: UUID, role: str) -> None:
    if role == "supremo":
        return
    allowed = await conn.fetchval(
        """
        SELECT EXISTS (
          SELECT 1 FROM public.user_company_access
          WHERE user_id = $1 AND company_id = $2 AND folder_path IS NULL
            AND permission_level IN ('admin', 'operador')
        )
        """,
        user_id, company_id,
    )
    if not allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas admin ou operador com acesso à empresa gerenciam instâncias.")


class TemplateCreate(BaseModel):
    company_id: UUID
    name: str
    description: str | None = None
    frequency: str
    criticality: str = "media"
    department: str | None = None
    sla_days: int = 0
    weight: int = 1
    validity_months: int | None = None
    rules_json: dict[str, Any] = {}

    @field_validator("frequency")
    @classmethod
    def _valid_freq(cls, v: str) -> str:
        if v not in FREQUENCIES:
            raise ValueError(f"frequency deve ser um de: {', '.join(FREQUENCIES)}")
        return v

    @field_validator("criticality")
    @classmethod
    def _valid_crit(cls, v: str) -> str:
        if v not in CRITICALITIES:
            raise ValueError(f"criticality deve ser um de: {', '.join(CRITICALITIES)}")
        return v

    @field_validator("validity_months")
    @classmethod
    def _valid_validity(cls, v: int | None) -> int | None:
        if v is not None and v <= 0:
            raise ValueError("validity_months deve ser positivo (ou omitido/null pra 'nunca expira').")
        return v


class TemplateUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    criticality: str | None = None
    department: str | None = None
    sla_days: int | None = None
    weight: int | None = None
    validity_months: int | None = None
    clear_validity_months: bool = False
    active: bool | None = None


class InstanceCreate(BaseModel):
    template_id: UUID
    period: str
    due_date: str  # ISO yyyy-mm-dd
    owner_id: str | None = None


class InstanceStatusUpdate(BaseModel):
    status: str
    dispensa_motivo: str | None = None

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v: str) -> str:
        if v not in MANUAL_STATUSES:
            raise ValueError(f"status deve ser um de: {', '.join(MANUAL_STATUSES)}")
        return v


class DocumentLink(BaseModel):
    document_id: UUID


class DependencyCreate(BaseModel):
    template_id: UUID
    depends_on_template_id: UUID


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/obligations/templates")
async def list_templates(
    company_id: UUID,
    include_archived: bool = Query(False),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await ObligationsService.list_templates(conn, company_id, include_archived=include_archived)
    return [dict(r) for r in rows]


@router.post("/companies/{company_id}/obligations/templates", status_code=status.HTTP_201_CREATED)
async def create_template(
    company_id: UUID,
    body: TemplateCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if body.company_id != company_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="company_id do corpo não bate com a URL.")
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)

    row = await ObligationsService.create_template(
        conn, company_id=company_id, name=body.name, description=body.description, frequency=body.frequency,
        criticality=body.criticality, department=body.department, sla_days=body.sla_days, weight=body.weight,
        validity_months=body.validity_months, rules_json=body.rules_json, created_by=user_id,
    )
    return dict(row)


@router.patch("/obligations/templates/{template_id}")
async def update_template(
    template_id: UUID,
    body: TemplateUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    existing = await ObligationsService.get_template(conn, template_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], UUID(str(existing["company_id"])), role)

    row = await ObligationsService.update_template(
        conn, template_id, name=body.name, description=body.description, criticality=body.criticality,
        department=body.department, sla_days=body.sla_days, weight=body.weight,
        validity_months=body.validity_months, clear_validity_months=body.clear_validity_months, active=body.active,
    )
    return dict(row)


@router.post("/obligations/templates/{template_id}/archive", status_code=status.HTTP_204_NO_CONTENT)
async def archive_template(
    template_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    existing = await ObligationsService.get_template(conn, template_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], UUID(str(existing["company_id"])), role)
    await ObligationsService.archive_template(conn, template_id)


# ---------------------------------------------------------------------------
# Instâncias
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/obligations/instances")
async def list_instances(
    company_id: UUID,
    obligation_status: str | None = Query(None, alias="status"),
    template_id: UUID | None = Query(None),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await ObligationsService.list_instances(conn, company_id, status=obligation_status, template_id=template_id)
    return [dict(r) for r in rows]


@router.post("/companies/{company_id}/obligations/instances", status_code=status.HTTP_201_CREATED)
async def create_instance(
    company_id: UUID,
    body: InstanceCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    import datetime

    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], company_id, role)

    template = await ObligationsService.get_template(conn, body.template_id)
    if template is None or UUID(str(template["company_id"])) != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template de obrigação não encontrado nesta empresa.")

    try:
        due_date = datetime.date.fromisoformat(body.due_date)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="due_date inválida — use yyyy-mm-dd.")

    try:
        row = await ObligationsService.create_instance(
            conn, template_id=body.template_id, company_id=company_id, period=body.period,
            due_date=due_date, owner_id=body.owner_id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe uma instância deste template para esse período.")
    return dict(row)


@router.get("/obligations/instances/{instance_id}")
async def get_instance(
    instance_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    row = await ObligationsService.get_instance(conn, instance_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Instância não encontrada.")
    return dict(row)


@router.patch("/obligations/instances/{instance_id}/status")
async def update_instance_status(
    instance_id: UUID,
    body: InstanceStatusUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    existing = await ObligationsService.get_instance(conn, instance_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Instância não encontrada.")
    if body.status == "dispensado" and not body.dispensa_motivo:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Dispensar uma obrigação exige motivo (regra de ouro: sempre explicar por quê).")

    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], UUID(str(existing["company_id"])), role)

    row = await ObligationsService.set_instance_status(conn, instance_id, status=body.status, dispensa_motivo=body.dispensa_motivo)
    return dict(row)


# ---------------------------------------------------------------------------
# Documentos comprobatórios
# ---------------------------------------------------------------------------

@router.get("/obligations/instances/{instance_id}/documents")
async def list_instance_documents(
    instance_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await ObligationsService.list_instance_documents(conn, instance_id)
    return [dict(r) for r in rows]


@router.post("/obligations/instances/{instance_id}/documents", status_code=status.HTTP_201_CREATED)
async def link_document(
    instance_id: UUID,
    body: DocumentLink,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    existing = await ObligationsService.get_instance(conn, instance_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Instância não encontrada.")
    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], UUID(str(existing["company_id"])), role)

    try:
        row = await ObligationsService.link_document(conn, instance_id, body.document_id, claims["sub"])
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Documento já vinculado a esta instância.")
    except asyncpg.ForeignKeyViolationError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    return dict(row)


@router.delete("/obligations/instances/{instance_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_document(
    instance_id: UUID,
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    existing = await ObligationsService.get_instance(conn, instance_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Instância não encontrada.")
    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], UUID(str(existing["company_id"])), role)
    await ObligationsService.unlink_document(conn, instance_id, document_id)


# ---------------------------------------------------------------------------
# Dependências entre templates (Fase 4.2, parte 1)
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/obligations/dependencies")
async def list_dependencies(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await ObligationsService.list_dependencies(conn, company_id)
    return [dict(r) for r in rows]


@router.post("/companies/{company_id}/obligations/dependencies", status_code=status.HTTP_201_CREATED)
async def add_dependency(
    company_id: UUID,
    body: DependencyCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)

    for tid in (body.template_id, body.depends_on_template_id):
        t = await ObligationsService.get_template(conn, tid)
        if t is None or UUID(str(t["company_id"])) != company_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template de obrigação não encontrado nesta empresa.")

    try:
        row = await ObligationsService.add_dependency(
            conn, company_id=company_id, template_id=body.template_id,
            depends_on_template_id=body.depends_on_template_id, created_by=user_id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Essa dependência já existe.")
    except asyncpg.CheckViolationError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uma obrigação não pode depender de si mesma.")
    except asyncpg.RaiseError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    return dict(row)


@router.delete("/obligations/dependencies/{dependency_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_dependency(
    dependency_id: UUID,
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    await ObligationsService.remove_dependency(conn, dependency_id)
