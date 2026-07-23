"""
Fase 5.1-5.3 — Retenção legal: política / atribuição / hold / fila de revisão.

Nome do arquivo evita colisão com o router de retenção da lixeira já
existente (`retention` em companies.py, ADR-025/030 — dias antes da exclusão
definitiva). São conceitos relacionados mas distintos: um é sobre quanto
tempo um item FICA NA LIXEIRA depois de excluído; este é sobre quando um
documento ATIVO pode legalmente ser excluído.

Gestão de políticas/atribuições/holds é exclusiva de admin/supremo. Decisão
na fila de revisão (Aprovar/Rejeitar/Adiar) também — mas "Aprovar" aqui
APENAS marca o status; não dispara nenhuma exclusão real (isso é uma fatia
futura, combinada separadamente com o usuário).
"""
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator

from app.dependencies import get_app_role, get_current_user, get_db
from app.services.companies_service import CompaniesService
from app.services.custom_fields_service import CustomFieldsService
from app.services.retention_service import RetentionService

router = APIRouter(tags=["retention-legal"])

TRIGGER_TYPES = ("upload_date", "custom_field")
QUEUE_DECISIONS = ("approved", "rejected", "deferred")


async def _require_admin(conn: asyncpg.Connection, user_id: str, company_id: UUID, role: str) -> None:
    if role == "supremo":
        return
    if await CompaniesService.user_manages_company(conn, user_id, company_id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas admin ou supremo gerenciam retenção.")


class PolicyCreate(BaseModel):
    company_id: UUID
    name: str
    legal_basis: str | None = None
    trigger_type: str = "upload_date"
    trigger_custom_field_id: UUID | None = None
    duration_months: int | None = None
    locked: bool = False

    @field_validator("trigger_type")
    @classmethod
    def _valid_trigger(cls, v: str) -> str:
        if v not in TRIGGER_TYPES:
            raise ValueError(f"trigger_type deve ser um de: {', '.join(TRIGGER_TYPES)}")
        return v

    @field_validator("duration_months")
    @classmethod
    def _valid_duration(cls, v: int | None) -> int | None:
        if v is not None and v <= 0:
            raise ValueError("duration_months deve ser positivo (ou omitido/null pra retenção indeterminada).")
        return v


class AssignmentCreate(BaseModel):
    company_id: UUID
    folder_id: UUID | None = None  # None = empresa toda
    policy_id: UUID


class HoldCreate(BaseModel):
    company_id: UUID
    resource_type: str
    resource_id: UUID
    reason: str

    @field_validator("resource_type")
    @classmethod
    def _valid_resource_type(cls, v: str) -> str:
        if v not in ("document", "folder"):
            raise ValueError("resource_type deve ser 'document' ou 'folder'.")
        return v

    @field_validator("reason")
    @classmethod
    def _valid_reason(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("reason é obrigatório — todo hold precisa de um motivo registrado.")
        return v.strip()


class QueueDecision(BaseModel):
    status: str
    notes: str | None = None
    deferred_until: str | None = None  # ISO yyyy-mm-dd, exigido quando status='deferred'

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v: str) -> str:
        if v not in QUEUE_DECISIONS:
            raise ValueError(f"status deve ser um de: {', '.join(QUEUE_DECISIONS)}")
        return v


# ---------------------------------------------------------------------------
# Políticas
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/retention/policies")
async def list_policies(
    company_id: UUID,
    include_archived: bool = Query(False),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await RetentionService.list_policies(conn, company_id, include_archived=include_archived)
    return [dict(r) for r in rows]


@router.post("/companies/{company_id}/retention/policies", status_code=status.HTTP_201_CREATED)
async def create_policy(
    company_id: UUID,
    body: PolicyCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if body.company_id != company_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="company_id do corpo não bate com a URL.")
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)

    row = await RetentionService.create_policy(
        conn, company_id=company_id, name=body.name, legal_basis=body.legal_basis, trigger_type=body.trigger_type,
        trigger_custom_field_id=body.trigger_custom_field_id, duration_months=body.duration_months,
        locked=body.locked, created_by=user_id,
    )
    return dict(row)


@router.post("/retention/policies/{policy_id}/archive", status_code=status.HTTP_204_NO_CONTENT)
async def archive_policy(
    policy_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    existing = await RetentionService.get_policy(conn, policy_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Política não encontrada.")
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], UUID(str(existing["company_id"])), role)
    await RetentionService.archive_policy(conn, policy_id)


# ---------------------------------------------------------------------------
# Atribuições
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/retention/assignments")
async def list_assignments(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await RetentionService.list_assignments(conn, company_id)
    return [dict(r) for r in rows]


@router.post("/companies/{company_id}/retention/assignments", status_code=status.HTTP_201_CREATED)
async def create_assignment(
    company_id: UUID,
    body: AssignmentCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if body.company_id != company_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="company_id do corpo não bate com a URL.")
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)

    folder_path = await CustomFieldsService.get_folder_path(conn, body.folder_id) if body.folder_id else None
    if body.folder_id and folder_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")

    policy = await RetentionService.get_policy(conn, body.policy_id)
    if policy is None or UUID(str(policy["company_id"])) != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Política de retenção não encontrada nesta empresa.")

    try:
        row = await RetentionService.create_assignment(
            conn, company_id=company_id, folder_path=folder_path, policy_id=body.policy_id, created_by=user_id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Essa política já está atribuída a esta pasta.")
    return dict(row)


@router.delete("/retention/assignments/{assignment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_assignment(
    assignment_id: UUID,
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    await RetentionService.remove_assignment(conn, assignment_id)


# ---------------------------------------------------------------------------
# Legal holds
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/retention/holds")
async def list_holds(
    company_id: UUID,
    active_only: bool = Query(True),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await RetentionService.list_holds(conn, company_id, active_only=active_only)
    return [dict(r) for r in rows]


@router.post("/companies/{company_id}/retention/holds", status_code=status.HTTP_201_CREATED)
async def create_hold(
    company_id: UUID,
    body: HoldCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if body.company_id != company_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="company_id do corpo não bate com a URL.")
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)

    row = await RetentionService.create_hold(
        conn, company_id=company_id, resource_type=body.resource_type, resource_id=body.resource_id,
        reason=body.reason, created_by=user_id,
    )
    return dict(row)


@router.post("/retention/holds/{hold_id}/release")
async def release_hold(
    hold_id: UUID,
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    row = await RetentionService.release_hold(conn, hold_id, claims["sub"])
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Hold não encontrado ou já liberado.")
    return dict(row)


# ---------------------------------------------------------------------------
# Prazo calculado (info por documento)
# ---------------------------------------------------------------------------

@router.get("/documents/{document_id}/retention")
async def get_document_retention(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    info = await RetentionService.get_document_retention_info(conn, document_id)
    held = await RetentionService.document_is_under_hold(conn, document_id)
    if info is None:
        return {"policy_id": None, "policy_name": None, "expires_at": None, "is_indeterminate": None, "locked": False, "under_hold": held}
    return dict(info) | {"under_hold": held}


# ---------------------------------------------------------------------------
# Fila de revisão
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/retention/queue")
async def list_queue(
    company_id: UUID,
    status_filter: str | None = Query(None, alias="status"),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await RetentionService.list_queue(conn, company_id, status_filter=status_filter)
    return [dict(r) for r in rows]


@router.post("/retention/queue/{queue_id}/decision")
async def decide_queue_item(
    queue_id: UUID,
    body: QueueDecision,
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    import datetime

    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)

    if body.status == "deferred" and not body.deferred_until:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Adiar exige uma nova data de revisão (deferred_until).")

    deferred_until = None
    if body.deferred_until:
        try:
            deferred_until = datetime.date.fromisoformat(body.deferred_until)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="deferred_until inválida — use yyyy-mm-dd.")

    row = await RetentionService.decide_queue_item(
        conn, queue_id, decision=body.status, notes=body.notes, deferred_until=deferred_until, reviewed_by=claims["sub"],
    )
    return dict(row)
