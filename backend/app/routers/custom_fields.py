"""
Metadados personalizados (ADENDO-08) — catálogo, aplicação na árvore, e
valores por documento.

Gestão do catálogo/aplicação é exclusiva de admin/supremo (mesmo padrão de
_can_manage_company em companies.py) — preencher valores é liberado a quem já
pode editar o documento (checado via RLS de document_field_value, que espelha
documents_update).
"""
import re
import unicodedata
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, field_validator

from app.dependencies import get_app_role, get_current_user, get_db
from app.services.companies_service import CompaniesService
from app.services.custom_fields_service import VALID_TYPES, CustomFieldsService

router = APIRouter(tags=["custom-fields"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _require_company_admin(conn: asyncpg.Connection, user_id: str, company_id: UUID, role: str) -> None:
    """Espelha _can_manage_company de companies.py: supremo administra tudo;
    qualquer outro usuário precisa de permission_level='admin' NAQUELA empresa."""
    if role == "supremo":
        return
    if await CompaniesService.user_manages_company(conn, user_id, company_id):
        return
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas admin ou supremo gerenciam metadados.")


def _slugify(label: str) -> str:
    """'Instituição Financeira' -> 'instituicao_financeira' — chave estável para a coluna."""
    normalized = unicodedata.normalize("NFKD", label).encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-z0-9]+", "_", normalized.lower()).strip("_")
    return slug or "campo"


def _validate_cpf(digits: str) -> bool:
    if len(digits) != 11 or digits == digits[0] * 11:
        return False
    def _dv(base: str) -> str:
        s = sum(int(d) * w for d, w in zip(base, range(len(base) + 1, 1, -1)))
        r = (s * 10) % 11
        return "0" if r == 10 else str(r)
    return digits[9] == _dv(digits[:9]) and digits[10] == _dv(digits[:10])


def _validate_cnpj(digits: str) -> bool:
    if len(digits) != 14 or digits == digits[0] * 14:
        return False
    def _dv(base: str) -> str:
        weights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2][-len(base):]
        s = sum(int(d) * w for d, w in zip(base, weights))
        r = s % 11
        return "0" if r < 2 else str(11 - r)
    return digits[12] == _dv(digits[:12]) and digits[13] == _dv(digits[:13])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class CustomFieldCreate(BaseModel):
    company_id: UUID
    label: str
    type: str
    format_config: dict[str, Any] = {}

    @field_validator("type")
    @classmethod
    def _valid_type(cls, v: str) -> str:
        if v not in VALID_TYPES:
            raise ValueError(f"Tipo inválido. Use um de: {', '.join(VALID_TYPES)}")
        return v


class CustomFieldUpdate(BaseModel):
    label: str | None = None
    format_config: dict[str, Any] | None = None


class CustomFieldCopy(BaseModel):
    source_company_id: UUID
    target_company_id: UUID


class FolderFieldUpsert(BaseModel):
    company_id: UUID
    folder_id: UUID | None = None  # None = aplica na raiz (empresa toda)
    custom_field_id: UUID
    mode: str = "apply"  # 'apply' | 'exclude'
    required: bool = False
    display_order: int = 0
    column_width: int | None = None

    @field_validator("mode")
    @classmethod
    def _valid_mode(cls, v: str) -> str:
        if v not in ("apply", "exclude"):
            raise ValueError("mode deve ser 'apply' ou 'exclude'.")
        return v


class DocumentFieldValueSet(BaseModel):
    custom_field_id: UUID
    value: str  # bruto do usuário; validado/normalizado conforme o tipo do campo


# ---------------------------------------------------------------------------
# Catálogo — GET /custom-fields, POST, PATCH, POST /archive, POST /copy
# ---------------------------------------------------------------------------

@router.get("/custom-fields")
async def list_custom_fields(
    company_id: UUID = Query(...),
    include_archived: bool = Query(False),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await CustomFieldsService.list_fields(conn, company_id=company_id, include_archived=include_archived)
    return [dict(r) for r in rows]


@router.post("/custom-fields", status_code=status.HTTP_201_CREATED)
async def create_custom_field(
    body: CustomFieldCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, user_id, body.company_id, role)

    field_key = _slugify(body.label)
    try:
        row = await CustomFieldsService.create_field(
            conn, company_id=body.company_id, label=body.label, field_key=field_key,
            type=body.type, format_config=body.format_config, created_by=user_id,
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe um campo com esse nome nesta empresa.")
    return dict(row)


@router.patch("/custom-fields/{field_id}")
async def update_custom_field(
    field_id: UUID,
    body: CustomFieldUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    existing = await CustomFieldsService.get_field(conn, field_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado.")
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, claims["sub"], UUID(existing["company_id"]), role)

    row = await CustomFieldsService.update_field(conn, field_id, label=body.label, format_config=body.format_config)
    return dict(row)


@router.post("/custom-fields/{field_id}/archive", status_code=status.HTTP_204_NO_CONTENT)
async def archive_custom_field(
    field_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """Soft-delete: some das colunas/formulários; valores já preenchidos ficam preservados no histórico."""
    existing = await CustomFieldsService.get_field(conn, field_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado.")
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, claims["sub"], UUID(existing["company_id"]), role)

    await CustomFieldsService.archive_field(conn, field_id)


@router.post("/custom-fields/copy")
async def copy_custom_fields(
    body: CustomFieldCopy,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Copia o catálogo de uma empresa para outra (§5.3 — não copia a aplicação
    na árvore, só as definições). Requer admin/supremo NAS DUAS empresas."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, user_id, body.source_company_id, role)
    await _require_company_admin(conn, user_id, body.target_company_id, role)

    rows = await CustomFieldsService.copy_fields_from_company(
        conn, source_company_id=body.source_company_id, target_company_id=body.target_company_id, created_by=user_id,
    )
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Aplicação na árvore — GET (resolvido) e GET (regras próprias), PUT, DELETE
# ---------------------------------------------------------------------------

@router.get("/folder-fields/resolved")
async def get_resolved_folder_fields(
    company_id: UUID = Query(...),
    folder_id: UUID | None = Query(None, description="Pasta alvo; omitir = raiz da empresa."),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Campos efetivos para uma pasta, já com herança/override resolvidos —
    usado pelo formulário de upload/edição e pelas colunas da tabela."""
    folder_path = await CustomFieldsService.get_folder_path(conn, folder_id) if folder_id else None
    if folder_id and folder_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    rows = await CustomFieldsService.resolve_for_folder(conn, company_id=company_id, folder_path=folder_path)
    return [dict(r) for r in rows]


@router.get("/folder-fields/rules")
async def get_folder_field_rules(
    company_id: UUID = Query(...),
    folder_id: UUID | None = Query(None),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Regras cruas aplicadas EXATAMENTE nesta pasta (não inclui herdadas) —
    usado pela tela de aplicação para distinguir "próprio daqui" de "herdado"."""
    folder_path = await CustomFieldsService.get_folder_path(conn, folder_id) if folder_id else None
    if folder_id and folder_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    rows = await CustomFieldsService.list_folder_field_rules(conn, company_id=company_id, folder_path=folder_path)
    return [dict(r) for r in rows]


@router.put("/folder-fields")
async def upsert_folder_field(
    body: FolderFieldUpsert,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Aplica (ou exclui) um campo numa pasta. Idempotente: reaplicar na mesma
    pasta substitui a regra anterior (UPSERT por company_id+folder_path+campo)."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, user_id, body.company_id, role)

    folder_path = await CustomFieldsService.get_folder_path(conn, body.folder_id) if body.folder_id else None
    if body.folder_id and folder_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")

    row = await CustomFieldsService.upsert_folder_field(
        conn, company_id=body.company_id, folder_path=folder_path, custom_field_id=body.custom_field_id,
        mode=body.mode, required=body.required, display_order=body.display_order,
        column_width=body.column_width, created_by=user_id,
    )
    return dict(row)


@router.delete("/folder-fields/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder_field_rule(
    rule_id: UUID,
    company_id: UUID = Query(...),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """Remove a regra própria desta pasta — ela volta a herdar do ancestral (se houver)."""
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, claims["sub"], company_id, role)
    await CustomFieldsService.remove_folder_field_rule(conn, rule_id)


# ---------------------------------------------------------------------------
# Valores por documento — GET, PUT (upsert em lote)
# ---------------------------------------------------------------------------

@router.get("/documents/field-values")
async def get_bulk_document_field_values(
    document_ids: str = Query(..., description="IDs separados por vírgula"),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Busca em lote — usado pela tabela de Documentos pra montar as colunas de
    metadado sem uma requisição por linha (M-H)."""
    try:
        ids = [UUID(x) for x in document_ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="document_ids inválido.")
    rows = await CustomFieldsService.get_values_for_documents(conn, ids)
    return [dict(r) for r in rows]


@router.get("/documents/{document_id}/field-values")
async def get_document_field_values(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await CustomFieldsService.get_document_values(conn, document_id)
    return [dict(r) for r in rows]


@router.put("/documents/{document_id}/field-values")
async def set_document_field_values(
    document_id: UUID,
    company_id: UUID = Query(...),
    body: list[DocumentFieldValueSet] = ...,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """
    Grava um lote de valores para o documento. Validação de formato por tipo
    (CPF/CNPJ com dígito verificador, data, número) acontece aqui — RLS só
    garante QUEM pode escrever, não a forma do valor.
    """
    user_id = claims["sub"]
    results = []
    for item in body:
        field = await CustomFieldsService.get_field(conn, item.custom_field_id)
        if field is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado.")

        value_text = item.value.strip()
        value_date = None
        value_number = None

        if field["type"] == "cpf":
            digits = re.sub(r"\D", "", value_text)
            if not _validate_cpf(digits):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"CPF inválido em '{field['label']}'.")
            value_text = f"{digits[:3]}.{digits[3:6]}.{digits[6:9]}-{digits[9:]}"
        elif field["type"] == "cnpj":
            digits = re.sub(r"\D", "", value_text)
            if not _validate_cnpj(digits):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"CNPJ inválido em '{field['label']}'.")
            value_text = f"{digits[:2]}.{digits[2:5]}.{digits[5:8]}/{digits[8:12]}-{digits[12:]}"
        elif field["type"] == "data":
            import datetime
            try:
                d = datetime.datetime.strptime(value_text, "%d/%m/%Y").date()
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Data inválida em '{field['label']}' — use dd/mm/aaaa.")
            value_date = d
            value_text = d.strftime("%d/%m/%Y")
        elif field["type"] == "competencia":
            import datetime
            try:
                d = datetime.datetime.strptime(value_text, "%m/%Y").date().replace(day=1)
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Competência inválida em '{field['label']}' — use mm/aaaa.")
            value_date = d
            value_text = d.strftime("%m/%Y")
        elif field["type"] == "numero":
            try:
                n = float(value_text.replace(",", "."))
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Número inválido em '{field['label']}'.")
            decimals = (field["format_config"] or {}).get("decimals", 2)
            value_number = round(n, decimals)
            value_text = f"{value_number:.{decimals}f}"
        elif field["type"] == "selecao":
            options = (field["format_config"] or {}).get("options", [])
            if options and value_text not in options:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Valor fora das opções permitidas em '{field['label']}'.")

        row = await CustomFieldsService.upsert_document_value(
            conn, document_id=document_id, company_id=company_id, custom_field_id=item.custom_field_id,
            value_text=value_text, value_date=value_date, value_number=value_number, updated_by=user_id,
        )
        results.append(dict(row))
    return results
