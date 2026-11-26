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
import csv
import datetime
import io
import logging
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field, field_validator

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services import storage_service
from app.services.companies_service import CompaniesService
from app.services.custom_fields_service import CustomFieldsService
from app.services.retention_catalog import RETENTION_BY_KEY, RETENTION_CATALOG
from app.services.retention_service import RetentionService, UnderHoldError

router = APIRouter(tags=["retention-legal"])
logger = logging.getLogger("docke.retention")

TRIGGER_TYPES = ("upload_date", "custom_field")
QUEUE_DECISIONS = ("approved", "rejected", "deferred")
START_RULES = ("data", "ano_seguinte")


def _duration_text(months: int | None) -> str:
    if months is None:
        return "permanente"
    if months % 12 == 0:
        anos = months // 12
        return f"{anos} {'ano' if anos == 1 else 'anos'}"
    return f"{months} {'mês' if months == 1 else 'meses'}"


async def _require_admin(conn: asyncpg.Connection, user_id: str, company_id: UUID, role: str) -> None:
    if role == "supremo":
        return
    if await CompaniesService.user_manages_company(conn, user_id, company_id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas admin ou supremo gerenciam retenção.")


class PolicyCreate(BaseModel):
    company_id: UUID
    name: str = Field(..., max_length=120)
    legal_basis: str | None = Field(None, max_length=200)
    notes: str | None = Field(None, max_length=1000)
    trigger_type: str = "upload_date"
    trigger_custom_field_id: UUID | None = None
    duration_months: int | None = Field(None, le=1200)
    start_rule: str = "data"
    locked: bool = False

    @field_validator("name")
    @classmethod
    def _valid_name(cls, v: str) -> str:
        v = " ".join(v.split())
        if not v:
            raise ValueError("Dê um nome à política.")
        return v

    @field_validator("start_rule")
    @classmethod
    def _valid_start(cls, v: str) -> str:
        if v not in START_RULES:
            raise ValueError("start_rule deve ser data ou ano_seguinte")
        return v

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


class PolicyUpdate(BaseModel):
    name: str | None = Field(None, max_length=120)
    legal_basis: str | None = Field(None, max_length=200)
    notes: str | None = Field(None, max_length=1000)
    duration_months: int | None = Field(None, gt=0, le=1200)
    indeterminate: bool = False
    start_rule: str | None = None
    trigger_type: str | None = None
    trigger_custom_field_id: UUID | None = None
    locked: bool | None = None


class CatalogApply(BaseModel):
    keys: list[str] = Field(..., min_length=1, max_length=20)


class HoldRelease(BaseModel):
    reason: str = Field(..., max_length=1000)

    @field_validator("reason")
    @classmethod
    def _valid(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Diga por que o bloqueio está sendo liberado.")
        return v.strip()


class QueueBatch(BaseModel):
    ids: list[UUID] = Field(..., min_length=1, max_length=200)
    status: str
    notes: str | None = Field(None, max_length=1000)
    deferred_until: datetime.date | None = None

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v: str) -> str:
        if v not in QUEUE_DECISIONS:
            raise ValueError(f"status deve ser um de: {', '.join(QUEUE_DECISIONS)}")
        return v


class AssignmentCreate(BaseModel):
    company_id: UUID
    folder_id: UUID | None = None  # None = empresa toda
    policy_id: UUID


class HoldCreate(BaseModel):
    company_id: UUID
    resource_type: str
    resource_id: UUID
    reason: str = Field(..., max_length=1000)
    process_number: str | None = Field(None, max_length=80)
    review_date: datetime.date | None = None

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


class QueueExecute(BaseModel):
    # Fase 5.9: "confirmação por digitação no expurgo definitivo" — não é
    # decorativo, é a defesa contra clique acidental num botão que apaga
    # de verdade. Precisa bater exatamente com o nome do documento.
    confirm_name: str


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

@router.get("/companies/{company_id}/retention/health-check")
async def retention_health_check(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Fase 14.3 — políticas sem nenhuma atribuição + documentos sem nenhuma política aplicável."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)
    return await RetentionService.health_check(conn, company_id)


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

    if body.trigger_type == "custom_field" and body.trigger_custom_field_id is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Escolha o campo de data que inicia a contagem.")
    row = await RetentionService.create_policy(
        conn, company_id=company_id, name=body.name, legal_basis=body.legal_basis, trigger_type=body.trigger_type,
        trigger_custom_field_id=body.trigger_custom_field_id, duration_months=body.duration_months,
        locked=body.locked, created_by=user_id, start_rule=body.start_rule, notes=body.notes,
    )
    await RetentionService.log(conn, user_id=user_id, company_id=company_id, action="retention_policy_create",
                               item_id=row["id"], name=row["name"],
                               metadata={"prazo": _duration_text(row["duration_months"]), "travada": row["locked"]})
    return dict(row)


@router.patch("/retention/policies/{policy_id}")
async def update_policy(
    policy_id: UUID,
    body: PolicyUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Editar política (A7-81). Travada só pode ganhar prazo: encurtar ou
    destravar exigiria descartar antes do que a regra prometeu.
    """
    existing = await RetentionService.get_policy(conn, policy_id)
    if existing is None or existing["archived_at"] is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Política não encontrada.")
    company_id = UUID(str(existing["company_id"]))
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)

    changes: dict[str, Any] = {k: getattr(body, k) for k in body.model_fields_set if k != "indeterminate"}
    if body.indeterminate:
        changes["duration_months"] = None
    for k in ("name", "start_rule", "trigger_type", "locked"):
        if k in changes and changes[k] is None:
            changes.pop(k)
    if "name" in changes:
        changes["name"] = " ".join(changes["name"].split())
        if not changes["name"]:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Dê um nome à política.")
    if changes.get("start_rule") is not None and changes["start_rule"] not in START_RULES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Início inválido.")
    if changes.get("trigger_type") is not None and changes["trigger_type"] not in TRIGGER_TYPES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Gatilho inválido.")

    if existing["locked"]:
        if changes.get("locked") is False:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Política travada não pode ser destravada. Arquive e crie outra, se o prazo mudou por lei.")
        if "duration_months" in changes and existing["duration_months"] is None and changes["duration_months"] is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Política travada e permanente não pode ganhar prazo de descarte.")
        if (
            "duration_months" in changes and changes["duration_months"] is not None
            and existing["duration_months"] is not None and changes["duration_months"] < existing["duration_months"]
        ):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Política travada só pode ter o prazo aumentado, nunca reduzido.")
        if any(k in changes and changes[k] != existing[k] for k in ("start_rule", "trigger_type", "trigger_custom_field_id")):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="O início da contagem de uma política travada não muda.")

    row = await RetentionService.update_policy(conn, policy_id, changes)
    mudou = sorted(k for k in changes if existing[k] != row[k])
    if mudou:
        await RetentionService.log(conn, user_id=claims["sub"], company_id=company_id, action="retention_policy_update",
                                   item_id=policy_id, name=row["name"],
                                   metadata={"campos": mudou, "prazo_antes": _duration_text(existing["duration_months"]),
                                             "prazo_depois": _duration_text(row["duration_months"])})
    return dict(row)


@router.get("/retention/policies/{policy_id}/impact")
async def policy_impact(
    policy_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, int]:
    """Quantos documentos têm hoje o prazo definido por esta política (prévia antes de arquivar, A7-82)."""
    existing = await RetentionService.get_policy(conn, policy_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Política não encontrada.")
    company_id = UUID(str(existing["company_id"]))
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    return {"documents": await RetentionService.winner_count(conn, company_id, policy_id)}


@router.get("/companies/{company_id}/retention/catalog")
async def retention_catalog(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    existing = await RetentionService.existing_catalog_keys(conn, company_id)
    return [{**p, "prazo": _duration_text(p["duration_months"]), "ja_existe": p["key"] in existing} for p in RETENTION_CATALOG]


@router.post("/companies/{company_id}/retention/catalog", status_code=status.HTTP_201_CREATED)
async def apply_retention_catalog(
    company_id: UUID,
    body: CatalogApply,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, int]:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)
    unknown = [k for k in body.keys if k not in RETENTION_BY_KEY]
    if unknown:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Política pronta desconhecida: {', '.join(unknown)}.")
    existing = await RetentionService.existing_catalog_keys(conn, company_id)
    created = 0
    for key in dict.fromkeys(body.keys):
        if key in existing:
            continue
        p = RETENTION_BY_KEY[key]
        row = await RetentionService.create_policy(
            conn, company_id=company_id, name=p["name"], legal_basis=p.get("legal_basis"), trigger_type="upload_date",
            trigger_custom_field_id=None, duration_months=p["duration_months"], locked=p["locked"], created_by=user_id,
            start_rule=p["start_rule"], notes=p.get("notes"), catalog_key=key,
        )
        await RetentionService.log(conn, user_id=user_id, company_id=company_id, action="retention_policy_create",
                                   item_id=row["id"], name=row["name"], metadata={"modelo_pronto": key})
        created += 1
    return {"created": created, "skipped": len(set(body.keys)) - created}


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
    afetados = await RetentionService.winner_count(conn, UUID(str(existing["company_id"])), policy_id)
    await RetentionService.archive_policy(conn, policy_id)
    await RetentionService.log(conn, user_id=claims["sub"], company_id=existing["company_id"], action="retention_policy_archive",
                               item_id=policy_id, name=existing["name"], metadata={"documentos_afetados": afetados})


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


@router.get("/companies/{company_id}/retention/assignments/simulate")
async def simulate_assignment(
    company_id: UUID,
    policy_id: UUID = Query(...),
    folder_id: UUID | None = Query(None),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Fase 14.2 — prévia de impacto ANTES de criar a atribuição de verdade."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)

    folder_path = await CustomFieldsService.get_folder_path(conn, folder_id) if folder_id else None
    if folder_id and folder_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")

    policy = await RetentionService.get_policy(conn, policy_id)
    if policy is None or UUID(str(policy["company_id"])) != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Política de retenção não encontrada nesta empresa.")

    return await RetentionService.simulate_assignment_impact(
        conn, company_id=company_id, policy_id=policy_id, folder_path=folder_path,
    )


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
    alvo = await RetentionService.get_assignment(conn, row["id"])
    await RetentionService.log(conn, user_id=user_id, company_id=company_id, action="retention_assign", item_id=body.policy_id,
                               name=policy["name"], metadata={"onde": (alvo["folder_label"] if alvo else None) or "Empresa toda"})
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
    alvo = await RetentionService.get_assignment(conn, assignment_id)
    if alvo is None or alvo["company_id"] != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Atribuição não encontrada.")
    await RetentionService.remove_assignment(conn, assignment_id)
    await RetentionService.log(conn, user_id=claims["sub"], company_id=company_id, action="retention_unassign",
                               item_id=alvo["policy_id"], name=alvo["policy_name"],
                               metadata={"onde": alvo["folder_label"] or "Empresa toda"})


@router.get("/retention/assignments/{assignment_id}/impact")
async def assignment_impact(
    assignment_id: UUID,
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Prévia antes de remover (A7-90): quantos documentos têm o prazo definido por esta atribuição."""
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    alvo = await RetentionService.get_assignment(conn, assignment_id)
    if alvo is None or alvo["company_id"] != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Atribuição não encontrada.")
    n = await RetentionService.winner_count(conn, company_id, alvo["policy_id"], str(alvo["folder_path"]) if alvo["folder_path"] else None)
    return {"documents": n, "policy_name": alvo["policy_name"], "where": alvo["folder_label"] or "Empresa toda"}


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

    nome = await RetentionService.resource_name(conn, company_id, body.resource_type, body.resource_id)
    if nome is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento ou pasta não encontrado nesta empresa.")
    row = await RetentionService.create_hold(
        conn, company_id=company_id, resource_type=body.resource_type, resource_id=body.resource_id,
        reason=body.reason, created_by=user_id, process_number=(body.process_number or "").strip() or None,
        review_date=body.review_date,
    )
    await RetentionService.log(conn, user_id=user_id, company_id=company_id, action="retention_hold_create", item_id=row["id"],
                               name=nome, metadata={"motivo": body.reason, "processo": row["process_number"],
                                                    "tipo": "pasta" if body.resource_type == "folder" else "documento"})
    return dict(row)


@router.post("/retention/holds/{hold_id}/release")
async def release_hold(
    hold_id: UUID,
    body: HoldRelease,
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Liberar exige motivo e entra na trilha (A7-106)."""
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    row = await RetentionService.release_hold(conn, hold_id, claims["sub"], body.reason)
    if row is None or row["company_id"] != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bloqueio não encontrado ou já liberado.")
    nome = await RetentionService.resource_name(conn, company_id, row["resource_type"], row["resource_id"]) or "item excluído"
    await RetentionService.log(conn, user_id=claims["sub"], company_id=company_id, action="retention_hold_release", item_id=hold_id,
                               name=nome, metadata={"motivo": body.reason, "processo": row["process_number"]})
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


@router.get("/documents/{document_id}/retention/explain")
async def explain_document_retention(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Fase 14.1 — "ver cálculo": todas as políticas candidatas e por que uma venceu."""
    return await RetentionService.explain_retention(conn, document_id)


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
    if row is None or row["company_id"] != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item da fila não encontrado.")
    await _log_decision(conn, claims["sub"], company_id, row, body.status, body.notes, deferred_until)
    return dict(row)


async def _log_decision(conn, user_id: str, company_id: UUID, row, decision: str, notes: str | None, deferred_until) -> None:
    nome = await conn.fetchval("SELECT name FROM public.documents WHERE id = $1", row["document_id"]) or "documento"
    await RetentionService.log(
        conn, user_id=user_id, company_id=company_id, action=f"retention_queue_{decision}", item_id=row["id"], name=nome,
        metadata={"nota": notes, **({"adiado_para": deferred_until} if deferred_until else {})},
    )


@router.post("/companies/{company_id}/retention/queue/decision-batch")
async def decide_queue_batch(
    company_id: UUID,
    body: QueueBatch,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, int]:
    """Decidir vários itens de uma vez (A7-70), numa transação: ou todos, ou nenhum."""
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    if body.status == "deferred" and body.deferred_until is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Adiar exige a nova data de revisão.")
    if body.deferred_until is not None and body.deferred_until <= datetime.date.today():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="A nova data de revisão precisa ser no futuro.")
    feitos = 0
    async with conn.transaction():
        for qid in dict.fromkeys(body.ids):
            row = await RetentionService.decide_queue_item(
                conn, qid, decision=body.status, notes=body.notes, deferred_until=body.deferred_until, reviewed_by=claims["sub"],
            )
            if row is None or row["company_id"] != company_id:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Um dos itens não está na fila desta empresa. Nada foi alterado.")
            await _log_decision(conn, claims["sub"], company_id, row, body.status, body.notes, body.deferred_until)
            feitos += 1
    return {"updated": feitos}


# ---------------------------------------------------------------------------
# Execução real do descarte (5.4-5.6) — passo SEPARADO de "Aprovar", com sua
# própria confirmação forte. Só admin/supremo, só item já 'approved'.
# ---------------------------------------------------------------------------

@router.post("/retention/queue/{queue_id}/execute")
async def execute_purge(
    queue_id: UUID,
    body: QueueExecute,
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)

    queue_rows = await RetentionService.list_queue(conn, company_id, status_filter="approved")
    target = next((r for r in queue_rows if r["id"] == queue_id), None)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Item não encontrado na fila com status 'approved' — só é possível executar descarte já aprovado.",
        )
    if body.confirm_name.strip() != target["document_name"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="O nome digitado não confere com o nome do documento — nada foi excluído.",
        )

    try:
        result = await RetentionService.execute_purge(conn, admin_conn, queue_id=queue_id, executed_by=claims["sub"])
    except UnderHoldError:
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail="Documento entrou sob retenção legal (legal hold) depois da aprovação — descarte bloqueado. Revise o hold antes de tentar de novo.",
        )
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Item não encontrado ou documento já não existe mais.")

    # Remoção do storage acontece DEPOIS do commit do banco — mesma ordem
    # do permanent_delete em trash.py: se falhar aqui, o registro já sumiu
    # e a evidência (certificado) já foi emitida; só vira log, não bloqueia.
    if result["storage_path"]:
        try:
            storage_service.delete_object(result["storage_path"])
        except Exception:
            logger.exception(
                "Falha ao remover objeto do storage após execução de descarte (certificado=%s, key=%s) — objeto pode ter ficado órfão.",
                result["certificate"]["id"], result["storage_path"],
            )

    return result["certificate"]


# ---------------------------------------------------------------------------
# Certificados de destruição (5.6) — evidência que sobrevive ao documento
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/retention/certificates")
async def list_certificates(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    rows = await conn.fetch(
        "SELECT * FROM public.destruction_certificates WHERE company_id = $1 ORDER BY executed_at DESC", company_id,
    )
    return [dict(r) for r in rows]


@router.get("/companies/{company_id}/retention/certificates.csv")
async def export_certificates(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> Response:
    """Certificados de destruição em CSV, para guardar fora do sistema (A7-70)."""
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    rows = await conn.fetch(
        "SELECT * FROM public.destruction_certificates WHERE company_id = $1 ORDER BY executed_at", company_id,
    )
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["certificado", "documento", "sha256", "pasta", "politica", "base_legal", "aprovado_por", "aprovado_em",
                "observacao", "executado_por", "executado_em"])
    for r in rows:
        w.writerow([r["id"], r["document_name_snapshot"], r["document_sha256"], r["folder_path_snapshot"], r["policy_name_snapshot"],
                    r["legal_basis_snapshot"], r["reviewed_by_name_snapshot"], r["reviewed_at"], r["review_notes"],
                    r["executed_by_name_snapshot"], r["executed_at"]])
    return Response(
        content="\ufeff" + buf.getvalue(), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="certificados-de-descarte.csv"'},
    )


@router.get("/companies/{company_id}/retention/summary")
async def retention_summary(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, int]:
    """Resumo no topo da tela (A7-71)."""
    row = await conn.fetchrow(
        """
        SELECT
          (SELECT count(*) FROM public.retention_policies WHERE company_id = $1 AND archived_at IS NULL AND active) AS politicas,
          (SELECT count(*) FROM public.legal_holds WHERE company_id = $1 AND released_at IS NULL) AS bloqueios,
          (SELECT count(*) FROM public.retention_review_queue WHERE company_id = $1 AND status = 'pending') AS fila,
          (SELECT count(*) FROM public.retention_review_queue WHERE company_id = $1 AND status = 'approved') AS aprovados,
          (SELECT count(*) FROM public.documents d WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL) AS documentos,
          (SELECT count(*) FROM public.documents d JOIN public.folders f ON f.id = d.folder_id
            WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.retention_policy_assignments rpa
                          JOIN public.retention_policies rp ON rp.id = rpa.policy_id
                          WHERE rpa.company_id = $1 AND rp.active AND rp.archived_at IS NULL
                            AND (rpa.folder_path IS NULL OR rpa.folder_path @> f.path))) AS cobertos
        """,
        company_id,
    )
    return {k: int(v or 0) for k, v in dict(row).items()}
