"""
Obrigações (Obrigação → Documento comprobatório).

Modelos são configuração da empresa (admin ou supremo). Competências (vincular,
dispensar, conferir, trocar responsável) ficam com admin OU operador: quem
processa o fiscal e o RH no dia a dia normalmente não é admin. A RLS garante a
permissão; os checks aqui existem para devolver 403 com mensagem clara.

Toda ação de configuração e de conferência entra na trilha (A7-03).
"""
import datetime
import json
import re
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService
from app.services.fiscal_profile_service import VALID_FAIXAS, VALID_REGIMES, VALID_TIPOS_JURIDICOS, FiscalProfileService
from app.services.obligation_catalog import BY_KEY, CATALOG, SEGMENTOS, avaliar
from app.services.obligations_service import ObligationsService, period_label
from app.services import features_service

router = APIRouter(tags=["obligations"])

FREQUENCIES = ("mensal", "anual", "unica", "evento")
CRITICALITIES = ("baixa", "media", "alta", "critica")
MANUAL_STATUSES = ("reviewing", "approved", "dispensado", "cancelado", "pending")
CONDITIONAL_FIELDS = ("regime_tributario", "faixa_funcionarios", "uf", "tipo_juridico", "atividade")
_OPEN_EFFECTIVE = ("pending", "at_risk", "overdue", "reviewing", "blocked", "expired")
async def _require_admin(conn: asyncpg.Connection, user_id: str, company_id: UUID, role: str) -> None:
    if role == "supremo":
        return
    if await CompaniesService.user_manages_company(conn, user_id, company_id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só quem administra a empresa altera as obrigações cadastradas.")


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
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só admin ou operador com acesso à empresa toda cuidam das obrigações.")


async def _require_member(conn: asyncpg.Connection, user_id: str | None, company_id: UUID) -> None:
    """O responsável precisa ter acesso à empresa (senão nunca veria a obrigação)."""
    if user_id is None:
        return
    ok = await conn.fetchval(
        "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1::uuid AND company_id = $2)",
        user_id, company_id,
    )
    if not ok:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O responsável escolhido não tem acesso a esta empresa.")


def _validate_rules_json(v: dict[str, Any]) -> dict[str, Any]:
    naw = v.get("not_applicable_when")
    if naw is None:
        return v
    if not isinstance(naw, dict) or "field" not in naw or "in" not in naw:
        raise ValueError("not_applicable_when deve ter o formato {'field': ..., 'in': [valor, ...]}")
    if naw["field"] not in CONDITIONAL_FIELDS:
        raise ValueError(f"field deve ser um de: {', '.join(CONDITIONAL_FIELDS)}")
    if not isinstance(naw["in"], list) or len(naw["in"]) == 0:
        raise ValueError("'in' deve ser uma lista não vazia de valores")
    if "only" in naw and not isinstance(naw["only"], bool):
        raise ValueError("'only' deve ser verdadeiro ou falso")
    if naw["field"] == "atividade":
        for x in naw["in"]:
            if not isinstance(x, str) or not re.fullmatch(r"\d{2,7}", x):
                raise ValueError("Atividade: informe o começo do CNAE, de 2 a 7 dígitos (ex.: 4731 para posto).")
    return v


def _check_schedule(frequency: str | None, due_day: int | None, due_month: int | None) -> None:
    if frequency == "anual" and due_day is not None and due_month is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Obrigação anual precisa do mês de vencimento.")


def _check_period(frequency: str, period: str) -> str:
    """A7-47: competência validada pela frequência, em vez de texto livre."""
    p = (period or "").strip()
    if frequency == "mensal":
        m = re.fullmatch(r"(\d{4})-(\d{2})", p) or re.fullmatch(r"(\d{2})/(\d{4})", p)
        if not m:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Competência mensal no formato mm/aaaa (ex.: 11/2026).")
        year, month = (m.group(1), m.group(2)) if "-" in p else (m.group(2), m.group(1))
        if not 1 <= int(month) <= 12 or not 2000 <= int(year) <= 2100:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Mês ou ano da competência inválido.")
        return f"{year}-{month}"
    if frequency == "anual":
        if not re.fullmatch(r"(20\d{2}|2100)", p):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Competência anual com o ano (ex.: 2026).")
        return p
    if not p or len(p) > 60:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Descreva a competência em até 60 caracteres (ex.: Vigente, Reforma 2026).")
    return p


class TemplateFields(BaseModel):
    name: str | None = Field(None, max_length=120)
    description: str | None = Field(None, max_length=2000)
    frequency: str | None = None
    criticality: str | None = None
    department: str | None = Field(None, max_length=60)
    sla_days: int | None = Field(None, ge=0, le=365)
    weight: int | None = Field(None, ge=1, le=10)
    validity_months: int | None = Field(None, ge=1, le=240)
    rules_json: dict[str, Any] | None = None
    active: bool | None = None
    due_day: int | None = Field(None, ge=1, le=31)
    due_month_offset: int | None = Field(None, ge=0, le=12)
    due_month: int | None = Field(None, ge=1, le=12)
    default_owner_id: UUID | None = None
    requires_review: bool | None = None
    legal_basis: str | None = Field(None, max_length=200)

    @field_validator("name")
    @classmethod
    def _name(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = " ".join(v.split())
        if not v:
            raise ValueError("Dê um nome à obrigação.")
        return v

    @field_validator("frequency")
    @classmethod
    def _valid_freq(cls, v: str | None) -> str | None:
        if v is not None and v not in FREQUENCIES:
            raise ValueError(f"frequency deve ser um de: {', '.join(FREQUENCIES)}")
        return v

    @field_validator("criticality")
    @classmethod
    def _valid_crit(cls, v: str | None) -> str | None:
        if v is not None and v not in CRITICALITIES:
            raise ValueError(f"criticality deve ser um de: {', '.join(CRITICALITIES)}")
        return v

    @field_validator("rules_json")
    @classmethod
    def _valid_rules(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        return v if v is None else _validate_rules_json(v)


class TemplateCreate(TemplateFields):
    company_id: UUID
    name: str = Field(..., max_length=120)
    frequency: str


class TemplateUpdate(TemplateFields):
    clear_validity_months: bool = False


class InstanceCreate(BaseModel):
    template_id: UUID
    period: str
    due_date: datetime.date
    owner_id: UUID | None = None
    notes: str | None = Field(None, max_length=2000)


class InstanceUpdate(BaseModel):
    owner_id: UUID | None = None
    notes: str | None = Field(None, max_length=2000)
    due_date: datetime.date | None = None


class InstanceStatusUpdate(BaseModel):
    status: str
    dispensa_motivo: str | None = Field(None, max_length=1000)

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v: str) -> str:
        if v not in MANUAL_STATUSES:
            raise ValueError(f"status deve ser um de: {', '.join(MANUAL_STATUSES)}")
        return v


class ReviewDecision(BaseModel):
    decision: str
    note: str | None = Field(None, max_length=1000)

    @field_validator("decision")
    @classmethod
    def _valid(cls, v: str) -> str:
        if v not in ("approve", "return"):
            raise ValueError("decision deve ser approve ou return")
        return v


class DocumentLink(BaseModel):
    document_id: UUID
    valid_until: datetime.date | None = None


class DependencyCreate(BaseModel):
    template_id: UUID
    depends_on_template_id: UUID


class CatalogApply(BaseModel):
    keys: list[str] = Field(..., min_length=1, max_length=60)
    default_owner_id: UUID | None = None


async def _history(conn: asyncpg.Connection, instance_id: UUID, template_id: UUID) -> list[dict[str, Any]]:
    out = []
    for h in await ObligationsService.history(conn, instance_id, template_id):
        d = dict(h)
        if isinstance(d.get("metadata"), str):
            d["metadata"] = json.loads(d["metadata"])
        out.append(d)
    return out


def _instance_out(r: asyncpg.Record) -> dict[str, Any]:
    d = dict(r)
    d["period_label"] = period_label(d.get("period", ""))
    return d


# ---------------------------------------------------------------------------
# Modelos
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
    await features_service.require(conn, company_id, "obrigacoes")
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)
    _check_schedule(body.frequency, body.due_day, body.due_month)
    await _require_member(conn, str(body.default_owner_id) if body.default_owner_id else None, company_id)

    fields = body.model_dump(exclude={"company_id"}, exclude_none=True)
    if "default_owner_id" in fields:
        fields["default_owner_id"] = str(fields["default_owner_id"])
    row = await ObligationsService.create_template(conn, company_id=company_id, created_by=user_id, **fields)
    await ObligationsService.log(conn, user_id=user_id, company_id=company_id, action="obligation_create",
                                 item_id=row["id"], name=row["name"], metadata={"tipo": "modelo"})
    generated = await ObligationsService.generate_due_instances(conn, template_id=row["id"])
    return {**dict(row), "generated": generated}


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
    company_id = UUID(str(existing["company_id"]))
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)

    changes = {k: getattr(body, k) for k in body.model_fields_set if k != "clear_validity_months"}
    if body.clear_validity_months:
        changes["validity_months"] = None
    if "name" in changes and changes["name"] is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Dê um nome à obrigação.")
    for required in ("frequency", "criticality", "sla_days", "weight", "due_month_offset", "requires_review", "active", "rules_json"):
        if required in changes and changes[required] is None:
            changes.pop(required)
    if changes.get("default_owner_id") is not None:
        changes["default_owner_id"] = str(changes["default_owner_id"])
        await _require_member(conn, changes["default_owner_id"], company_id)
    _check_schedule(changes.get("frequency", existing["frequency"]), changes.get("due_day", existing["due_day"]),
                    changes.get("due_month", existing["due_month"]))

    row = await ObligationsService.update_template(conn, template_id, changes)
    antes = {k: existing[k] for k in changes if k in existing.keys() and existing[k] != row[k]}
    if antes:
        await ObligationsService.log(
            conn, user_id=claims["sub"], company_id=company_id, action="obligation_update", item_id=template_id,
            name=row["name"], metadata={"tipo": "modelo", "campos": sorted(antes)},
        )
    generated = await ObligationsService.generate_due_instances(conn, template_id=template_id)
    return {**dict(row), "generated": generated}


@router.post("/obligations/templates/{template_id}/archive", status_code=status.HTTP_204_NO_CONTENT)
async def archive_template(
    template_id: UUID,
    restore: bool = Query(False, description="true desarquiva."),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    existing = await ObligationsService.get_template(conn, template_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], UUID(str(existing["company_id"])), role)
    try:
        await ObligationsService.archive_template(conn, template_id, restore=restore)
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe outra obrigação ativa criada a partir do mesmo modelo pronto.")
    await ObligationsService.log(
        conn, user_id=claims["sub"], company_id=existing["company_id"],
        action="obligation_restore" if restore else "obligation_archive", item_id=template_id,
        name=existing["name"], metadata={"tipo": "modelo"},
    )


# ---------------------------------------------------------------------------
# Modelos prontos (A7-36) e recorrência (A7-07)
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/obligations/catalog")
async def get_catalog(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    existing = await ObligationsService.existing_catalog_keys(conn, company_id)
    perfil_row = await FiscalProfileService.get(conn, company_id)
    perfil = dict(perfil_row) if perfil_row else {}
    itens = []
    for item in CATALOG:
        av = avaliar(item["key"], perfil)
        segmentos = list(item["segmentos"])
        # "Para esta empresa": o que o perfil recomenda e o que depende de dado que falta.
        if av["situacao"] != "nao_se_aplica":
            segmentos.append("perfil")
        itens.append({**item, "segmentos": segmentos, "ja_existe": item["key"] in existing, **av})
    campos = ("regime_tributario", "faixa_funcionarios", "tipo_juridico", "cnae_principal")
    return {
        "segmentos": SEGMENTOS,
        "itens": itens,
        "perfil_incompleto": [c for c in campos if not perfil.get(c)],
    }


@router.post("/companies/{company_id}/obligations/catalog", status_code=status.HTTP_201_CREATED)
async def apply_catalog(
    company_id: UUID,
    body: CatalogApply,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await features_service.require(conn, company_id, "obrigacoes")
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_admin(conn, user_id, company_id, role)
    owner = str(body.default_owner_id) if body.default_owner_id else None
    await _require_member(conn, owner, company_id)
    unknown = [k for k in body.keys if k not in BY_KEY]
    if unknown:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Modelo pronto desconhecido: {', '.join(unknown)}.")

    existing = await ObligationsService.existing_catalog_keys(conn, company_id)
    created, skipped = [], []
    for key in dict.fromkeys(body.keys):
        if key in existing:
            skipped.append(key)
            continue
        item = BY_KEY[key]
        fields = {k: v for k, v in item.items() if k not in ("key", "segmentos", "situacao", "motivos")}
        fields["catalog_key"] = key
        if owner:
            fields["default_owner_id"] = owner
        row = await ObligationsService.create_template(conn, company_id=company_id, created_by=user_id, **fields)
        created.append(row)
        await ObligationsService.log(conn, user_id=user_id, company_id=company_id, action="obligation_create",
                                     item_id=row["id"], name=row["name"], metadata={"tipo": "modelo", "modelo_pronto": key})
    generated = await ObligationsService.generate_due_instances(conn, company_id=company_id)
    # Obrigações sem calendário (certidões, licenças) começam com uma competência "Vigente"
    # para receber o documento atual, em vez de ficarem invisíveis.
    for row in created:
        if row["frequency"] == "unica":
            await ObligationsService.create_instance(
                conn, template_id=row["id"], company_id=company_id, period="Vigente",
                due_date=datetime.date.today() + datetime.timedelta(days=max(row["sla_days"], 15)),
                owner_id=owner,
            )
            generated += 1
    return {"created": len(created), "skipped": len(skipped), "generated": generated}


@router.post("/companies/{company_id}/obligations/generate")
async def generate_now(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, int]:
    await features_service.require(conn, company_id, "obrigacoes")
    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], company_id, role)
    return {"generated": await ObligationsService.generate_due_instances(conn, company_id=company_id)}


# ---------------------------------------------------------------------------
# Competências
# ---------------------------------------------------------------------------

@router.get("/companies/{company_id}/obligations/instances")
async def list_instances(
    company_id: UUID,
    obligation_status: str | None = Query(None, alias="status"),
    template_id: UUID | None = Query(None),
    mine: bool = Query(False, description="Só as que estão comigo."),
    history: bool = Query(False, description="Inclui fechadas com mais de 13 meses."),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    rows = await ObligationsService.list_instances(
        conn, company_id, status=obligation_status, template_id=template_id,
        owner_id=claims["sub"] if mine else None, history=history,
    )
    return [_instance_out(r) for r in rows]


@router.get("/obligations/group")
async def list_group(
    mine: bool = Query(False),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Visão do grupo (A7-09): o que está aberto em todas as empresas, e o resumo por empresa."""
    rows = [_instance_out(r) for r in await ObligationsService.list_group_open(conn, claims["sub"], owner_only=mine)]
    resumo: dict[str, dict[str, Any]] = {}
    for r in rows:
        c = resumo.setdefault(r["company_id"].__str__(), {
            "company_id": str(r["company_id"]), "name": r["company_name"],
            "overdue": 0, "at_risk": 0, "reviewing": 0, "expired": 0, "approved": 0, "relevant": 0,
        })
        st = r["effective_status"]
        if st in c:
            c[st] += 1
        if st not in ("dispensado", "cancelado", "not_applicable"):
            c["relevant"] += 1
    abertas = [r for r in rows if r["effective_status"] in _OPEN_EFFECTIVE]
    return {"empresas": sorted(resumo.values(), key=lambda c: (-c["overdue"], -c["expired"], c["name"])), "instancias": abertas}


@router.post("/companies/{company_id}/obligations/instances", status_code=status.HTTP_201_CREATED)
async def create_instance(
    company_id: UUID,
    body: InstanceCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await features_service.require(conn, company_id, "obrigacoes")
    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], company_id, role)

    template = await ObligationsService.get_template(conn, body.template_id)
    if template is None or UUID(str(template["company_id"])) != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada nesta empresa.")
    period = _check_period(template["frequency"], body.period)
    owner = str(body.owner_id) if body.owner_id else (str(template["default_owner_id"]) if template["default_owner_id"] else None)
    await _require_member(conn, owner, company_id)
    try:
        row = await ObligationsService.create_instance(
            conn, template_id=body.template_id, company_id=company_id, period=period,
            due_date=body.due_date, owner_id=owner, notes=body.notes,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Já existe a competência {period_label(period)} desta obrigação.")
    await ObligationsService.log(conn, user_id=claims["sub"], company_id=company_id, action="obligation_generate",
                                 item_id=row["id"], name=f'{template["name"]} · {period_label(period)}',
                                 metadata={"tipo": "competencia", "vencimento": body.due_date.isoformat()})
    return _instance_out(await ObligationsService.get_instance(conn, row["id"]))


@router.get("/obligations/instances/{instance_id}")
async def get_instance(
    instance_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    row = await ObligationsService.get_instance(conn, instance_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    out = _instance_out(row)
    out["documents"] = [dict(d) for d in await ObligationsService.list_instance_documents(conn, instance_id)]
    out["history"] = await _history(conn, instance_id, row["template_id"])
    return out


@router.patch("/obligations/instances/{instance_id}")
async def update_instance(
    instance_id: UUID,
    body: InstanceUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Responsável, observação e vencimento (A7-08, A7-51)."""
    existing = await ObligationsService.get_instance(conn, instance_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    company_id = UUID(str(existing["company_id"]))
    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], company_id, role)
    changes = {k: getattr(body, k) for k in body.model_fields_set}
    if "due_date" in changes and changes["due_date"] is None:
        changes.pop("due_date")
    if changes.get("owner_id") is not None:
        changes["owner_id"] = str(changes["owner_id"])
        await _require_member(conn, changes["owner_id"], company_id)
    if not changes:
        return _instance_out(existing)
    await ObligationsService.update_instance(conn, instance_id, changes)
    row = await ObligationsService.get_instance(conn, instance_id)
    nome = f'{row["template_name"]} · {period_label(row["period"])}'
    if "owner_id" in changes and str(existing["owner_id"] or "") != str(row["owner_id"] or ""):
        await ObligationsService.log(conn, user_id=claims["sub"], company_id=company_id, action="obligation_assign",
                                     item_id=instance_id, name=nome,
                                     metadata={"tipo": "competencia", "de": existing["owner_name"], "para": row["owner_name"]})
    if "due_date" in changes and existing["due_date"] != row["due_date"]:
        await ObligationsService.log(conn, user_id=claims["sub"], company_id=company_id, action="obligation_update",
                                     item_id=instance_id, name=nome,
                                     metadata={"tipo": "competencia", "de": existing["due_date"], "para": row["due_date"]})
    return _instance_out(row)


_STATUS_ACTION = {"dispensado": "obligation_dispense", "cancelado": "obligation_cancel", "approved": "obligation_approve",
                  "reviewing": "obligation_reopen", "pending": "obligation_reopen"}


@router.patch("/obligations/instances/{instance_id}/status")
async def update_instance_status(
    instance_id: UUID,
    body: InstanceStatusUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    existing = await ObligationsService.get_instance(conn, instance_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    motivo = (body.dispensa_motivo or "").strip() or None
    if body.status == "dispensado" and not motivo:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Diga por que esta obrigação não precisa ser cumprida.")
    company_id = UUID(str(existing["company_id"]))
    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], company_id, role)
    if body.status == "approved":
        await _require_admin(conn, claims["sub"], company_id, role)

    await ObligationsService.set_instance_status(
        conn, instance_id, status=body.status, dispensa_motivo=motivo if body.status == "dispensado" else None,
        reviewed_by=claims["sub"] if body.status == "approved" else None,
    )
    await ObligationsService.log(
        conn, user_id=claims["sub"], company_id=company_id, action=_STATUS_ACTION[body.status], item_id=instance_id,
        name=f'{existing["template_name"]} · {period_label(existing["period"])}',
        metadata={"tipo": "competencia", "motivo": motivo} if motivo else {"tipo": "competencia"},
    )
    return _instance_out(await ObligationsService.get_instance(conn, instance_id))


@router.post("/obligations/instances/{instance_id}/review")
async def review_instance(
    instance_id: UUID,
    body: ReviewDecision,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Conferência do documento (A7-53): aprovar fecha a obrigação; devolver
    reabre com o motivo, para quem enviou trocar o documento.
    """
    existing = await ObligationsService.get_instance(conn, instance_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    company_id = UUID(str(existing["company_id"]))
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)
    if existing["status"] != "reviewing":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Esta obrigação não está esperando conferência.")
    note = (body.note or "").strip() or None
    if body.decision == "return" and not note:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Diga o que precisa ser corrigido no documento.")
    await ObligationsService.set_instance_status(
        conn, instance_id, status="approved" if body.decision == "approve" else "pending",
        dispensa_motivo=None, reviewed_by=claims["sub"], review_note=note,
    )
    await ObligationsService.log(
        conn, user_id=claims["sub"], company_id=company_id,
        action="obligation_approve" if body.decision == "approve" else "obligation_return", item_id=instance_id,
        name=f'{existing["template_name"]} · {period_label(existing["period"])}',
        metadata={"tipo": "competencia", **({"motivo": note} if note else {})},
    )
    return _instance_out(await ObligationsService.get_instance(conn, instance_id))


@router.get("/obligations/instances/{instance_id}/history")
async def instance_history(
    instance_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    row = await ObligationsService.get_instance(conn, instance_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    return await _history(conn, instance_id, row["template_id"])


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


@router.get("/documents/{document_id}/obligations")
async def list_document_obligations(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Que obrigações este documento comprova (painel de detalhes, A7-54)."""
    return [_instance_out(r) for r in await ObligationsService.list_document_obligations(conn, document_id)]


@router.post("/obligations/instances/{instance_id}/documents", status_code=status.HTTP_201_CREATED)
async def link_document(
    instance_id: UUID,
    body: DocumentLink,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    existing = await ObligationsService.get_instance(conn, instance_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    company_id = UUID(str(existing["company_id"]))
    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], company_id, role)
    doc = await conn.fetchrow(
        "SELECT id, name, company_id FROM public.documents WHERE id = $1 AND deleted_at IS NULL AND content_hash IS NOT NULL",
        body.document_id,
    )
    if doc is None or doc["company_id"] != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado nesta empresa.")

    try:
        async with conn.transaction():
            row = await ObligationsService.link_document(conn, instance_id, body.document_id, claims["sub"], body.valid_until)
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Este documento já comprova esta obrigação.")
    nome = f'{existing["template_name"]} · {period_label(existing["period"])}'
    await ObligationsService.log(
        conn, user_id=claims["sub"], company_id=company_id, action="obligation_link", item_id=instance_id, name=nome,
        metadata={"tipo": "competencia", "documento": doc["name"], **({"valido_ate": body.valid_until} if body.valid_until else {})},
    )
    after = await ObligationsService.get_instance(conn, instance_id)
    if after is not None and after["status"] == "reviewing":
        # Avisa quem confere (admins da empresa), menos quem acabou de vincular.
        await admin_conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)
            SELECT DISTINCT uca.user_id, $1::uuid, 'obligation_review', 'obligation_instance', $2::uuid, $3::text
            FROM public.user_company_access uca
            WHERE uca.company_id = $1 AND uca.folder_path IS NULL AND uca.permission_level = 'admin'
              AND uca.user_id <> $4::uuid
            """,
            company_id, instance_id, f'"{nome}": {doc["name"]} foi enviado e espera sua conferência.', claims["sub"],
        )
    return {**dict(row), "instance": _instance_out(after) if after else None}


@router.delete("/obligations/instances/{instance_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_document(
    instance_id: UUID,
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    existing = await ObligationsService.get_instance(conn, instance_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada.")
    company_id = UUID(str(existing["company_id"]))
    role = await get_app_role(conn, claims)
    await _require_operator(conn, claims["sub"], company_id, role)
    doc_name = await conn.fetchval("SELECT name FROM public.documents WHERE id = $1", document_id)
    if await ObligationsService.unlink_document(conn, instance_id, document_id):
        await ObligationsService.log(
            conn, user_id=claims["sub"], company_id=company_id, action="obligation_unlink", item_id=instance_id,
            name=f'{existing["template_name"]} · {period_label(existing["period"])}',
            metadata={"tipo": "competencia", "documento": doc_name},
        )


# ---------------------------------------------------------------------------
# Dependências entre obrigações
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

    names = {}
    for tid in (body.template_id, body.depends_on_template_id):
        t = await ObligationsService.get_template(conn, tid)
        if t is None or UUID(str(t["company_id"])) != company_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obrigação não encontrada nesta empresa.")
        names[tid] = t["name"]

    try:
        async with conn.transaction():
            row = await ObligationsService.add_dependency(
                conn, company_id=company_id, template_id=body.template_id,
                depends_on_template_id=body.depends_on_template_id, created_by=user_id,
            )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Essa dependência já existe.")
    except asyncpg.CheckViolationError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uma obrigação não pode depender de si mesma.")
    except asyncpg.RaiseError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f'"{names[body.depends_on_template_id]}" já depende, direta ou indiretamente, de "{names[body.template_id]}". '
                   "Essa dependência criaria um ciclo e as duas ficariam bloqueadas para sempre.",
        )
    await ObligationsService.log(
        conn, user_id=user_id, company_id=company_id, action="obligation_dependency_add", item_id=body.template_id,
        name=names[body.template_id], metadata={"tipo": "modelo", "depende_de": names[body.depends_on_template_id]},
    )
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
    dep = await ObligationsService.get_dependency(conn, dependency_id)
    if dep is None or dep["company_id"] != company_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dependência não encontrada.")
    await ObligationsService.remove_dependency(conn, dependency_id)
    await ObligationsService.log(
        conn, user_id=claims["sub"], company_id=company_id, action="obligation_dependency_remove",
        item_id=dep["template_id"], name=dep["template_name"], metadata={"tipo": "modelo", "depende_de": dep["depends_on_name"]},
    )

# ---------------------------------------------------------------------------
# Perfil fiscal da empresa (Fase 4.2/4.3, parte 2)
# ---------------------------------------------------------------------------

class FiscalProfileUpdate(BaseModel):
    regime_tributario: str | None = None
    faixa_funcionarios: str | None = None
    uf: str | None = None
    tipo_juridico: str | None = None
    cnae_principal: str | None = None

    @field_validator("cnae_principal")
    @classmethod
    def _valid_cnae(cls, v: str | None) -> str | None:
        if v is None:
            return None
        digitos = "".join(ch for ch in v if ch.isdigit())
        if not digitos:
            return None
        if len(digitos) != 7:
            raise ValueError("O CNAE tem 7 dígitos (ex.: 4731-8/00).")
        return digitos

    @field_validator("regime_tributario")
    @classmethod
    def _valid_regime(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_REGIMES:
            raise ValueError(f"regime_tributario deve ser um de: {', '.join(VALID_REGIMES)}")
        return v

    @field_validator("faixa_funcionarios")
    @classmethod
    def _valid_faixa(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_FAIXAS:
            raise ValueError(f"faixa_funcionarios deve ser um de: {', '.join(VALID_FAIXAS)}")
        return v

    @field_validator("tipo_juridico")
    @classmethod
    def _valid_tipo(cls, v: str | None) -> str | None:
        if v is not None and v not in VALID_TIPOS_JURIDICOS:
            raise ValueError(f"tipo_juridico deve ser um de: {', '.join(VALID_TIPOS_JURIDICOS)}")
        return v

    @field_validator("uf")
    @classmethod
    def _valid_uf(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip().upper()
            if len(v) != 2 or not v.isalpha():
                raise ValueError("uf deve ter 2 letras (ex.: SP, RJ).")
        return v


@router.get("/companies/{company_id}/fiscal-profile")
async def get_fiscal_profile(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    row = await FiscalProfileService.get(conn, company_id)
    if row is None:
        return {"company_id": str(company_id), "regime_tributario": None, "faixa_funcionarios": None, "uf": None, "tipo_juridico": None, "cnae_principal": None, "updated_at": None}
    return dict(row)


@router.put("/companies/{company_id}/fiscal-profile")
async def update_fiscal_profile(
    company_id: UUID,
    body: FiscalProfileUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = await get_app_role(conn, claims)
    await _require_admin(conn, claims["sub"], company_id, role)

    row = await FiscalProfileService.upsert(
        conn, company_id, regime_tributario=body.regime_tributario, faixa_funcionarios=body.faixa_funcionarios,
        uf=body.uf, tipo_juridico=body.tipo_juridico, updated_by=claims["sub"],
        cnae_principal=body.cnae_principal,
    )
    return dict(row)


# ---------------------------------------------------------------------------
# Calendário (B3.5.10): as obrigações em aberto em .ics (Google Agenda,
# Outlook, celular) ou CSV, de uma empresa ou de todas as que a pessoa acessa.
# ---------------------------------------------------------------------------

def _ics_texto(s: str) -> str:
    return (s or "").replace("\\", "\\\\").replace(";", r"\;").replace(",", r"\,").replace("\n", r"\n")


@router.get("/obligations/calendar")
async def obligations_calendar(
    company_id: UUID | None = Query(None),
    formato: str = Query("ics", pattern="^(ics|csv)$"),
    mine: bool = Query(False),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
):
    from fastapi.responses import Response

    rows = [_instance_out(r) for r in await ObligationsService.list_group_open(conn, claims["sub"], owner_only=mine)]
    if company_id is not None:
        rows = [r for r in rows if str(r["company_id"]) == str(company_id)]
    rows.sort(key=lambda r: (r["due_date"], r["company_name"] or "", r["template_name"] or ""))
    hoje = datetime.date.today().strftime("%Y%m%d")

    if formato == "csv":
        linhas = [["Vencimento", "Empresa", "Obrigação", "Competência", "Situação", "Responsável"]]
        for r in rows:
            linhas.append([r["due_date"].strftime("%d/%m/%Y"), r["company_name"] or "", r["template_name"] or "",
                           r["period_label"], r.get("effective_status") or r.get("status") or "", r.get("owner_name") or ""])
        corpo = "\ufeff" + "\r\n".join(";".join('"' + str(c).replace('"', '""') + '"' for c in linha) for linha in linhas)
        return Response(corpo, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="obrigacoes_{hoje}.csv"'})

    agora = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    ev = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Docke//Obrigacoes//PT-BR", "CALSCALE:GREGORIAN",
          "X-WR-CALNAME:Obrigações (Docke)", "X-WR-TIMEZONE:America/Sao_Paulo"]
    for r in rows:
        ini = r["due_date"]
        fim = ini + datetime.timedelta(days=1)
        titulo = f"{r['template_name']} · {r['period_label']}" + (f" ({r['company_name']})" if company_id is None else "")
        desc = f"Situação: {r.get('effective_status') or r.get('status')}" + (f"\nResponsável: {r['owner_name']}" if r.get("owner_name") else "")
        ev += ["BEGIN:VEVENT", f"UID:{r['id']}@docke", f"DTSTAMP:{agora}",
               f"DTSTART;VALUE=DATE:{ini.strftime('%Y%m%d')}", f"DTEND;VALUE=DATE:{fim.strftime('%Y%m%d')}",
               f"SUMMARY:{_ics_texto(titulo)}", f"DESCRIPTION:{_ics_texto(desc)}",
               "BEGIN:VALARM", "TRIGGER:-P3D", "ACTION:DISPLAY", f"DESCRIPTION:{_ics_texto(titulo)}", "END:VALARM",
               "END:VEVENT"]
    ev.append("END:VCALENDAR")
    return Response("\r\n".join(ev) + "\r\n", media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="obrigacoes_{hoje}.ics"'})


@router.get("/obligations/matrix")
async def obligations_matrix(
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Conformidade do grupo (FA-A7-04): matriz empresa × obrigação com a
    situação da competência mais recente que já venceu ou vence até o fim do
    mês corrente, em cada empresa que a pessoa acessa.
    """
    rows = [_instance_out(r) for r in await ObligationsService.list_group_open(conn, claims["sub"])]
    hoje = datetime.date.today()
    fim_mes = (hoje.replace(day=28) + datetime.timedelta(days=4)).replace(day=1) - datetime.timedelta(days=1)
    escolha: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows:
        if r["due_date"] > fim_mes or r.get("effective_status") in ("cancelado",):
            continue
        k = (str(r["company_id"]), r["template_name"])
        atual = escolha.get(k)
        if atual is None or r["due_date"] > atual["due_date"]:
            escolha[k] = r
    empresas = sorted({(str(r["company_id"]), r["company_name"]) for r in rows}, key=lambda x: x[1] or "")
    obrigacoes = sorted({r["template_name"] for r in escolha.values()})
    celulas: dict[str, dict[str, Any]] = {}
    for (cid, nome), r in escolha.items():
        celulas.setdefault(cid, {})[nome] = {
            "instance_id": str(r["id"]), "status": r.get("effective_status") or r.get("status"),
            "period_label": r["period_label"], "due_date": r["due_date"], "owner_name": r.get("owner_name"),
        }
    resumo = {}
    for cid, _ in empresas:
        st = [c["status"] for c in celulas.get(cid, {}).values()]
        relevantes = [s for s in st if s not in ("dispensado", "not_applicable")]
        resumo[cid] = {
            "em_dia": sum(1 for s in relevantes if s == "approved"),
            "total": len(relevantes),
            "atrasadas": sum(1 for s in relevantes if s in ("overdue", "expired")),
        }
    return {
        "empresas": [{"company_id": c, "name": n, **resumo[c]} for c, n in empresas],
        "obrigacoes": obrigacoes,
        "celulas": celulas,
    }
