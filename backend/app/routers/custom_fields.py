"""
Metadados personalizados (ADENDO-08) — catálogo, aplicação na árvore, e
valores por documento.

Gestão do catálogo/aplicação é exclusiva de admin/supremo (mesmo padrão de
_can_manage_company em companies.py) — preencher valores é liberado a quem já
pode editar o documento (checado via RLS de document_field_value, que espelha
documents_update).
"""
import json
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


def _value_error(field: Any, raw: str) -> str | None:
    """
    Mesma regra do valor do documento, para o valor padrão da pasta (A8-20):
    um padrão inválido pré-preenchia documentos novos e falhava depois.
    """
    import datetime as _dt
    from decimal import Decimal, InvalidOperation

    v = (raw or "").strip()
    if not v:
        return None
    t = field["type"]
    digits = re.sub(r"\D", "", v)
    if t == "cpf" and not _validate_cpf(digits):
        return "CPF inválido."
    if t == "cnpj" and not _validate_cnpj(digits):
        return "CNPJ inválido."
    if t == "data":
        try:
            _dt.datetime.strptime(v, "%d/%m/%Y")
        except ValueError:
            return "Data inválida: use dd/mm/aaaa."
    if t == "competencia":
        try:
            _dt.datetime.strptime("01/" + v, "%d/%m/%Y")
        except ValueError:
            return "Competência inválida: use mm/aaaa."
    if t == "numero":
        try:
            Decimal(v.replace(".", "").replace(",", ".") if "," in v else v)
        except InvalidOperation:
            return "Número inválido."
    if t in _EXTRAS:
        try:
            _normalize_extra(t, v)
        except ValueError as exc:
            return str(exc)
    if t == "multipla":
        cfg = field["format_config"]
        if isinstance(cfg, str):
            import json as _json
            cfg = _json.loads(cfg or "{}")
        try:
            _multipla(v, (cfg or {}).get("options", []))
        except ValueError as exc:
            return str(exc)
    if t == "selecao":
        cfg = field["format_config"]
        if isinstance(cfg, str):
            import json as _json
            cfg = _json.loads(cfg or "{}")
        if v not in (cfg or {}).get("options", []):
            return "O valor padrão precisa ser uma das opções do campo."
    return None


# Tipos validados por _normalize_extra (B1.3.2).
_EXTRAS = ("moeda", "email", "telefone", "cep", "booleano", "texto_longo", "data_hora", "url")


def _multipla(v: str, options: list[str]) -> str:
    """Múltipla escolha: "A; B" com cada item entre as opções, na ordem das opções."""
    escolhidas = [x.strip() for x in re.split(r"[;\n]", v) if x.strip()]
    fora = [x for x in escolhidas if options and x not in options]
    if fora:
        raise ValueError(f"Fora das opções: {', '.join(fora)}")
    ordem = [o for o in options if o in escolhidas] if options else escolhidas
    return "; ".join(dict.fromkeys(ordem))


def _normalize_extra(t: str, v: str):
    """
    Tipos novos (B1.3.2). Devolve (texto exibido, número ou None) ou levanta
    ValueError com a mensagem para quem preenche.
    """
    from decimal import Decimal, InvalidOperation

    v = v.strip()
    if t == "moeda":
        limpo = re.sub(r"[R$\s]", "", v)
        if "," in limpo:
            limpo = limpo.replace(".", "").replace(",", ".")
        try:
            n = Decimal(limpo).quantize(Decimal("0.01"))
        except InvalidOperation:
            raise ValueError("Valor em reais inválido: use 1.234,56.")
        inteiro, cent = f"{abs(n):.2f}".split(".")
        inteiro = f"{int(inteiro):,}".replace(",", ".")
        return f"{'-' if n < 0 else ''}R$ {inteiro},{cent}", n
    if t == "email":
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", v):
            raise ValueError("E-mail inválido.")
        return v.lower(), None
    if t == "telefone":
        d = re.sub(r"\D", "", v)
        if d.startswith("55") and len(d) in (12, 13):
            d = d[2:]
        if len(d) == 11:
            return f"({d[:2]}) {d[2:7]}-{d[7:]}", None
        if len(d) == 10:
            return f"({d[:2]}) {d[2:6]}-{d[6:]}", None
        raise ValueError("Telefone inválido: use DDD + número.")
    if t == "cep":
        d = re.sub(r"\D", "", v)
        if len(d) != 8:
            raise ValueError("CEP inválido: são 8 dígitos.")
        return f"{d[:5]}-{d[5:]}", None
    if t == "texto_longo":
        if len(v) > 2000:
            raise ValueError("Texto longo tem até 2.000 caracteres.")
        return v, None
    if t == "url":
        u = v if re.match(r"^https?://", v, re.I) else f"https://{v}"
        if not re.fullmatch(r"https?://[^\s/$.?#][^\s]*\.[^\s]+", u, re.I):
            raise ValueError("Endereço inválido: use algo como https://site.com.br/página.")
        return u, None
    if t == "data_hora":
        import datetime as _dth
        for fmt in ("%d/%m/%Y %H:%M", "%d/%m/%Y %Hh%M", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M"):
            try:
                return _dth.datetime.strptime(v, fmt).strftime("%d/%m/%Y %H:%M"), None
            except ValueError:
                continue
        raise ValueError("Data e hora inválidas: use dd/mm/aaaa hh:mm.")
    if t == "booleano":
        low = v.lower()
        if low in ("sim", "s", "true", "1", "yes"):
            return "Sim", None
        if low in ("não", "nao", "n", "false", "0", "no"):
            return "Não", None
        raise ValueError("Use Sim ou Não.")
    return v, None


async def _log_config(conn: asyncpg.Connection, user_id: str, company_id: UUID | str, action: str, item_id: UUID | str, name: str, meta: dict[str, Any] | None = None) -> None:
    """Mudanças nos campos e nas regras por pasta entram na trilha (A8-T2)."""
    import json as _json
    await conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
        VALUES ($1::uuid, $2::uuid, $3, 'config', $4::uuid, $5, 'config', $6::jsonb)
        """,
        user_id, str(company_id), action, str(item_id), name, _json.dumps(meta or {}, default=str),
    )


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class CustomFieldCreate(BaseModel):
    company_id: UUID
    label: str
    type: str
    format_config: dict[str, Any] = {}
    # Fase 8.4: campo condicional — só aparece no formulário quando
    # condition_field_id tem valor igual a condition_value.
    condition_field_id: UUID | None = None
    condition_value: str | None = None

    @field_validator("type")
    @classmethod
    def _valid_type(cls, v: str) -> str:
        if v not in VALID_TYPES:
            raise ValueError(f"Tipo inválido. Use um de: {', '.join(VALID_TYPES)}")
        return v


class CustomFieldUpdate(BaseModel):
    label: str | None = None
    format_config: dict[str, Any] | None = None
    condition_field_id: UUID | None = None
    condition_value: str | None = None
    clear_condition: bool = False


class CustomFieldCopy(BaseModel):
    source_company_id: UUID
    target_company_id: UUID


class CustomFieldCopySelected(CustomFieldCopy):
    # A8-28: quais campos (None = todos) e se a aplicação nas pastas vai junto.
    field_ids: list[UUID] | None = None
    include_tree: bool = False


class FolderRulesCopy(BaseModel):
    company_id: UUID
    source_folder_id: UUID
    target_folder_id: UUID


class FolderFieldUpsert(BaseModel):
    company_id: UUID
    folder_id: UUID | None = None  # None = aplica na raiz (empresa toda)
    custom_field_id: UUID
    mode: str = "apply"  # 'apply' | 'exclude'
    required: bool = False
    display_order: int = 0
    column_width: int | None = None
    # Fase 8.3: valor padrão herdado — pré-preenche o campo no formulário de
    # um documento novo dentro desta pasta (ou de uma sub-pasta que não tenha
    # sua própria regra pra este campo).
    default_value: str | None = None

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
            condition_field_id=body.condition_field_id, condition_value=body.condition_value,
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

    if body.label is not None and not body.label.strip():
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Dê um nome ao campo.")
    row = await CustomFieldsService.update_field(
        conn, field_id, label=body.label.strip() if body.label else None, format_config=body.format_config,
        condition_field_id=body.condition_field_id, condition_value=body.condition_value,
        clear_condition=body.clear_condition,
    )
    await _log_config(conn, claims["sub"], existing["company_id"], "field_update", field_id, row["label"],
                      {"antes": existing["label"]} if existing["label"] != row["label"] else None)
    return dict(row)


@router.post("/custom-fields/{field_id}/restore")
async def restore_custom_field(
    field_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Desarquivar (A8-16): o campo volta ao catálogo e às pastas onde estava aplicado."""
    existing = await CustomFieldsService.get_field(conn, field_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado.")
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, claims["sub"], UUID(existing["company_id"]), role)
    await conn.execute("UPDATE public.custom_field SET archived_at = NULL WHERE id = $1", field_id)
    await _log_config(conn, claims["sub"], existing["company_id"], "field_restore", field_id, existing["label"])
    return {"id": str(field_id), "archived_at": None}


@router.delete("/custom-fields/{field_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_custom_field(
    field_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """Fase 6.3: exclusão de verdade — só permitida se o campo nunca foi
    preenchido em nenhum documento. Senão, 409 orientando pra arquivar
    (que preserva o histórico já preenchido)."""
    existing = await CustomFieldsService.get_field(conn, field_id)
    if existing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado.")
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, claims["sub"], UUID(existing["company_id"]), role)

    if await CustomFieldsService.field_is_in_use(conn, field_id):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Este campo já foi preenchido em algum documento — excluir apagaria esse histórico. Arquive o campo em vez de excluir.",
        )
    await CustomFieldsService.delete_field(conn, field_id)


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
    await _log_config(conn, claims["sub"], existing["company_id"], "field_archive", field_id, existing["label"])


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


@router.post("/custom-fields/copy/preview")
async def preview_copy_custom_fields(
    body: CustomFieldCopy,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Prévia da cópia (A8-28): o que é novo, o que já existe no destino e
    quantas aplicações em pasta encontram pasta equivalente."""
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, claims["sub"], body.source_company_id, role)
    await _require_company_admin(conn, claims["sub"], body.target_company_id, role)
    return await CustomFieldsService.copy_preview(
        conn, source_company_id=body.source_company_id, target_company_id=body.target_company_id,
    )


@router.post("/custom-fields/copy-selected")
async def copy_selected_custom_fields(
    body: CustomFieldCopySelected,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Copia os campos escolhidos (e a aplicação nas pastas de mesmo nome) e
    devolve o relatório do que foi feito."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, user_id, body.source_company_id, role)
    await _require_company_admin(conn, user_id, body.target_company_id, role)
    rel = await CustomFieldsService.copy_selected(
        conn, source_company_id=body.source_company_id, target_company_id=body.target_company_id,
        field_ids=body.field_ids, include_tree=body.include_tree, created_by=user_id,
    )
    await _log_config(conn, user_id, body.target_company_id, "fields_copy", body.target_company_id,
                      "Campos de metadados", {"de_empresa": str(body.source_company_id), **{k: (len(v) if isinstance(v, list) else v) for k, v in rel.items()}})
    return rel


@router.post("/folder-fields/copy")
async def copy_folder_field_rules(
    body: FolderRulesCopy,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Copia as regras próprias de uma pasta para outra da mesma empresa (A8-28)."""
    user_id = claims["sub"]
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, user_id, body.company_id, role)
    if body.source_folder_id == body.target_folder_id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Escolha uma pasta de destino diferente da de origem.")
    origem = await conn.fetchrow(
        "SELECT path::text, name FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
        body.source_folder_id, body.company_id,
    )
    destino = await conn.fetchrow(
        "SELECT path::text, name FROM public.folders WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL",
        body.target_folder_id, body.company_id,
    )
    if origem is None or destino is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada nesta empresa.")
    n = await CustomFieldsService.copy_folder_rules(
        conn, company_id=body.company_id, source_path=origem["path"], target_path=destino["path"], created_by=user_id,
    )
    await _log_config(conn, user_id, body.company_id, "field_rules_copy", body.target_folder_id, destino["name"],
                      {"de_pasta": origem["name"], "regras": n})
    return {"regras_copiadas": n, "destino": destino["name"]}


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


@router.get("/custom-fields/{field_id}/where")
async def where_field_applies(
    field_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Onde o campo vale (A8-13): as regras dele na árvore, com o caminho da
    pasta, aplicar/excluir, obrigatório e valor padrão, e quantos documentos já
    têm valor. O RLS da conexão limita às pastas que a pessoa enxerga."""
    field = await conn.fetchrow("SELECT id, company_id, label FROM public.custom_field WHERE id = $1", field_id)
    if field is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado.")
    rows = await conn.fetch(
        """
        SELECT ff.folder_path::text AS folder_path, ff.mode, ff.required, ff.default_value, f.id::text AS folder_id,
               CASE WHEN ff.folder_path IS NULL THEN 'Empresa toda'
                    ELSE (SELECT string_agg(a.name, ' / ' ORDER BY nlevel(a.path)) FROM public.folders a
                          WHERE a.company_id = ff.company_id AND a.path @> ff.folder_path AND a.deleted_at IS NULL) END AS caminho
        FROM public.folder_field ff
        LEFT JOIN public.folders f ON f.company_id = ff.company_id AND f.path = ff.folder_path AND f.deleted_at IS NULL
        WHERE ff.custom_field_id = $1 AND (ff.folder_path IS NULL OR f.id IS NOT NULL)
        ORDER BY ff.folder_path NULLS FIRST
        """,
        field_id,
    )
    preenchidos = await conn.fetchval("SELECT count(*) FROM public.document_field_value WHERE custom_field_id = $1", field_id)
    return {"label": field["label"], "regras": [dict(r) for r in rows], "documentos_com_valor": preenchidos}


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

    field = await CustomFieldsService.get_field(conn, body.custom_field_id)
    if field is None or str(field["company_id"]) != str(body.company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado nesta empresa.")
    if body.default_value:
        erro = _value_error(field, body.default_value)
        if erro:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Valor padrão de “{field['label']}”: {erro}")

    row = await CustomFieldsService.upsert_folder_field(
        conn, company_id=body.company_id, folder_path=folder_path, custom_field_id=body.custom_field_id,
        mode=body.mode, required=body.required, display_order=body.display_order,
        column_width=body.column_width, created_by=user_id, default_value=body.default_value,
    )
    await _log_config(conn, user_id, body.company_id, "field_rule_exclude" if body.mode == "exclude" else "field_rule_apply",
                      body.custom_field_id, field["label"],
                      {"onde": folder_path or "Empresa toda", "obrigatorio": body.required, "padrao": body.default_value})
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


class FieldValuesQuery(BaseModel):
    document_ids: list[UUID]


@router.post("/documents/field-values/query")
async def query_document_field_values(
    body: FieldValuesQuery,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Mesmo que GET /documents/field-values, com os ids no corpo (até 1.000)."""
    if len(body.document_ids) > 1000:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Máximo de 1.000 documentos por consulta.")
    if not body.document_ids:
        return []
    rows = await CustomFieldsService.get_values_for_documents(conn, list(body.document_ids))
    return [dict(r) for r in rows]


@router.get("/documents/{document_id}/field-values")
async def get_document_field_values(
    document_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    rows = await CustomFieldsService.get_document_values(conn, document_id)
    return [dict(r) for r in rows]


class BulkFieldValues(BaseModel):
    document_ids: list[UUID]
    values: list[DocumentFieldValueSet]


@router.put("/documents/field-values/batch")
async def set_field_values_batch(
    body: BulkFieldValues,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Edição de metadados em lote numa transação só (achado A5-29): ou todos os
    documentos recebem os valores, ou nenhum — antes era um PUT por documento
    e uma falha no meio deixava parte alterada. Mesma validação do formulário.
    """
    if not 1 <= len(body.document_ids) <= 1000:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Informe de 1 a 1.000 documentos.")
    if not body.values:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Nenhum campo para alterar.")
    async with conn.transaction():
        for document_id in body.document_ids:
            await set_document_field_values(document_id, body.values, conn, claims)
    return {"updated": len(body.document_ids)}


@router.put("/documents/{document_id}/field-values")
async def set_document_field_values(
    document_id: UUID,
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

    # company_id é derivado do documento no servidor — nunca aceito do cliente
    # (R6): um valor arbitrário aqui corromperia relatórios/listagens filtrados
    # por empresa mesmo com a RLS de document_field_value já protegendo o
    # acesso via document_id corretamente.
    doc = await CustomFieldsService.get_document_company_and_name(conn, document_id)
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    company_id = doc["company_id"]

    # Uma query pra buscar todos os campos referenciados no lote, em vez de uma
    # por item (N+1) — importante aqui porque um preenchimento de formulário
    # inteiro chega de uma vez (10-20+ campos não é incomum).
    fields_by_id = await CustomFieldsService.get_fields_bulk(conn, [item.custom_field_id for item in body])

    results = []
    for item in body:
        field = fields_by_id.get(str(item.custom_field_id))
        if field is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado.")

        value_text = item.value.strip()
        if not value_text:
            # Valor vazio apaga o preenchimento (B1.3.7: o desfazer do lote
            # volta o documento ao vazio que era). Fica na trilha.
            old_value = await conn.fetchval(
                "DELETE FROM public.document_field_value WHERE document_id = $1 AND custom_field_id = $2 RETURNING value_text",
                document_id, item.custom_field_id,
            )
            if old_value is not None:
                await conn.execute(
                    """
                    INSERT INTO public.activity_log
                      (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
                    VALUES ($1::uuid, $2::uuid, 'update_metadata', 'document', $3::uuid, $4, 'metadata', $5::jsonb)
                    """,
                    user_id, str(company_id), str(document_id), doc["name"],
                    json.dumps({"field_label": field["label"], "custom_field_id": str(item.custom_field_id), "old_value": old_value, "new_value": None}),
                )
            results.append({"custom_field_id": str(item.custom_field_id), "value_text": None, "cleared": True})
            continue
        value_date = None
        value_number = None
        # CustomFieldsService.get_fields_bulk já decodifica format_config pra
        # dict (Fase 6.4 — bug pré-existente de jsonb chegando como string
        # crua do asyncpg, corrigido em _decode_field_row).
        format_config: dict[str, Any] = field["format_config"] or {}

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
            import decimal
            normalized_number = value_text.replace(",", ".")
            try:
                n = decimal.Decimal(normalized_number)
            except decimal.InvalidOperation:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Número inválido em '{field['label']}'.")
            # Fase 6.4: "ilimitado" é o padrão — decimals ausente (None) significa
            # não arredondar/forçar casas nenhuma, só guardar o número como digitado.
            # Decimal em vez de float evita artefato de representação binária
            # (ex.: 123.456789 virando 123.45678900000000055570126... no banco).
            decimals = format_config.get("decimals")
            if decimals is None:
                value_number = n
                value_text = normalized_number
            else:
                value_number = round(n, decimals)
                value_text = f"{value_number:.{decimals}f}"
        elif field["type"] == "selecao":
            options = format_config.get("options", [])
            if options and value_text not in options:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Valor fora das opções permitidas em '{field['label']}'.")
        elif field["type"] == "multipla":
            try:
                value_text = _multipla(value_text, format_config.get("options", []))
            except ValueError as exc:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{exc} ({field['label']})")
        elif field["type"] in _EXTRAS and value_text:
            try:
                value_text, value_number = _normalize_extra(field["type"], value_text)
            except ValueError as exc:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"{exc} ({field['label']})")

        row = await CustomFieldsService.upsert_document_value(
            conn, document_id=document_id, company_id=company_id, custom_field_id=item.custom_field_id,
            value_text=value_text, value_date=value_date, value_number=value_number, updated_by=user_id,
        )
        results.append(dict(row))

        # Fase 2.4 (before/after de metadados): só grava evento se o valor
        # realmente mudou — reenviar o mesmo valor (ex.: autosave disparando
        # de novo no blur) não deveria virar ruído na timeline.
        old_value = row["old_value_text"]
        if old_value != value_text:
            await conn.execute(
                """
                INSERT INTO public.activity_log
                  (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
                VALUES ($1::uuid, $2::uuid, 'update_metadata', 'document', $3::uuid, $4, 'metadata', $5::jsonb)
                """,
                user_id, str(company_id), str(document_id), doc["name"],
                json.dumps({"field_label": field["label"], "custom_field_id": str(item.custom_field_id), "old_value": old_value, "new_value": value_text}),
            )
    return results


# ---------------------------------------------------------------------------
# Trocar o tipo de um campo convertendo os valores (B1.3.10) e aplicar o valor
# padrão de uma regra de pasta aos documentos que já existem (FA-A8-09). As
# duas rotas têm prévia: nada muda sem `aplicar: true`.
# ---------------------------------------------------------------------------

def _normalizar(tipo: str, cfg: dict[str, Any], bruto: str):
    """(texto, data, número) no formato do tipo, ou ValueError com o motivo."""
    import datetime as _dt
    from decimal import Decimal, InvalidOperation

    v = (bruto or "").strip()
    if not v:
        raise ValueError("vazio")
    if tipo == "texto":
        return v, None, None
    if tipo == "cpf":
        d = re.sub(r"\D", "", v)
        if not _validate_cpf(d):
            raise ValueError("CPF inválido")
        return f"{d[:3]}.{d[3:6]}.{d[6:9]}-{d[9:]}", None, None
    if tipo == "cnpj":
        d = re.sub(r"\D", "", v)
        if not _validate_cnpj(d):
            raise ValueError("CNPJ inválido")
        return f"{d[:2]}.{d[2:5]}.{d[5:8]}/{d[8:12]}-{d[12:]}", None, None
    if tipo == "data":
        for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y"):
            try:
                d = _dt.datetime.strptime(v, fmt).date()
                return d.strftime("%d/%m/%Y"), d, None
            except ValueError:
                continue
        raise ValueError("não é uma data")
    if tipo == "competencia":
        for fmt in ("%m/%Y", "%Y-%m", "%d/%m/%Y", "%Y-%m-%d"):
            try:
                d = _dt.datetime.strptime(v, fmt).date().replace(day=1)
                return d.strftime("%m/%Y"), d, None
            except ValueError:
                continue
        raise ValueError("não é uma competência")
    if tipo == "numero":
        limpo = v.replace(".", "").replace(",", ".") if "," in v else v
        try:
            n = Decimal(limpo)
        except InvalidOperation:
            raise ValueError("não é um número")
        casas = cfg.get("decimals")
        if casas is None:
            return limpo, None, n
        n = round(n, casas)
        return f"{n:.{casas}f}", None, n
    if tipo == "selecao":
        if v not in cfg.get("options", []):
            raise ValueError("fora das opções")
        return v, None, None
    if tipo == "multipla":
        return _multipla(v, cfg.get("options", [])), None, None
    if tipo in _EXTRAS:
        texto, numero = _normalize_extra(tipo, v)
        return texto, None, numero
    raise ValueError("tipo desconhecido")


class FieldTypeChange(BaseModel):
    new_type: str
    aplicar: bool = False


@router.post("/custom-fields/{field_id}/change-type")
async def change_field_type(
    field_id: UUID,
    body: FieldTypeChange,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Prévia (padrão) ou troca de fato do tipo. Valores que não convertem são
    listados na prévia e, ao aplicar, apagados (o aviso diz quantos e quais).
    Para "seleção", as opções passam a ser os valores que já existem.
    """
    import json as _json

    field = await CustomFieldsService.get_field(conn, field_id)
    if field is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Campo não encontrado.")
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, claims["sub"], UUID(field["company_id"]), role)
    if body.new_type not in VALID_TYPES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Tipo inválido.")
    if body.new_type == field["type"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O campo já é deste tipo.")

    valores = await conn.fetch(
        """
        SELECT v.id, v.value_text, d.name AS documento
        FROM public.document_field_value v JOIN public.documents d ON d.id = v.document_id
        WHERE v.custom_field_id = $1
        """,
        field_id,
    )
    cfg_antigo = field["format_config"] or {}
    if isinstance(cfg_antigo, str):
        cfg_antigo = _json.loads(cfg_antigo or "{}")
    cfg_novo: dict[str, Any] = {}
    if body.new_type in ("selecao", "multipla"):
        opcoes = sorted({(v["value_text"] or "").strip() for v in valores if (v["value_text"] or "").strip()})[:100]
        cfg_novo = {"options": opcoes}
    elif body.new_type == "numero" and "decimals" in cfg_antigo:
        cfg_novo = {"decimals": cfg_antigo["decimals"]}

    convertidos, perdidos = [], []
    for v in valores:
        try:
            convertidos.append((v["id"], *_normalizar(body.new_type, cfg_novo, v["value_text"])))
        except ValueError as exc:
            perdidos.append({"documento": v["documento"], "valor": v["value_text"], "motivo": str(exc)})

    resumo = {"total": len(valores), "convertidos": len(convertidos), "perdidos": len(perdidos),
              "exemplos_perdidos": perdidos[:10], "opcoes": cfg_novo.get("options")}
    if not body.aplicar:
        return resumo | {"aplicado": False}

    async with conn.transaction():
        for vid, texto, data, numero in convertidos:
            await conn.execute(
                "UPDATE public.document_field_value SET value_text = $2, value_date = $3, value_number = $4, updated_at = now() WHERE id = $1",
                vid, texto, data, numero,
            )
        if perdidos:
            ids_ok = [c[0] for c in convertidos]
            await conn.execute(
                "DELETE FROM public.document_field_value WHERE custom_field_id = $1 AND NOT (id = ANY($2::uuid[]))", field_id, ids_ok,
            )
        await conn.execute(
            "UPDATE public.custom_field SET type = $2, format_config = $3::jsonb WHERE id = $1", field_id, body.new_type, _json.dumps(cfg_novo),
        )
        # Valor padrão das pastas que não serve mais no tipo novo sai (ficaria inválido).
        regras = await conn.fetch("SELECT id, default_value FROM public.folder_field WHERE custom_field_id = $1 AND default_value IS NOT NULL", field_id)
        for r in regras:
            try:
                texto, _, _ = _normalizar(body.new_type, cfg_novo, r["default_value"])
                await conn.execute("UPDATE public.folder_field SET default_value = $2 WHERE id = $1", r["id"], texto)
            except ValueError:
                await conn.execute("UPDATE public.folder_field SET default_value = NULL WHERE id = $1", r["id"])
    await _log_config(conn, claims["sub"], field["company_id"], "field_type_change", field_id, field["label"],
                      {"de": field["type"], "para": body.new_type, "convertidos": len(convertidos), "perdidos": len(perdidos)})
    return resumo | {"aplicado": True}


class ApplyDefault(BaseModel):
    modo: str = "vazios"  # vazios | sobrescrever
    aplicar: bool = False


@router.post("/folder-fields/{rule_id}/apply-default")
async def apply_default_to_existing(
    rule_id: UUID,
    body: ApplyDefault,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Leva o valor padrão da regra aos documentos que já estão na pasta e nas
    subpastas onde esta regra vale (uma subpasta com regra própria para o
    campo fica de fora). "vazios" só preenche quem está sem valor;
    "sobrescrever" troca também os valores diferentes.
    """
    import json as _json

    if body.modo not in ("vazios", "sobrescrever"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Modo inválido.")
    regra = await conn.fetchrow(
        """
        SELECT ff.id, ff.company_id, ff.folder_path, ff.custom_field_id, ff.default_value, ff.mode,
               cf.type, cf.format_config, cf.label
        FROM public.folder_field ff JOIN public.custom_field cf ON cf.id = ff.custom_field_id
        WHERE ff.id = $1
        """,
        rule_id,
    )
    if regra is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Regra não encontrada.")
    role = await get_app_role(conn, claims)
    await _require_company_admin(conn, claims["sub"], regra["company_id"], role)
    if regra["mode"] != "apply" or not regra["default_value"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Esta regra não tem valor padrão para aplicar.")
    cfg = regra["format_config"] or {}
    if isinstance(cfg, str):
        cfg = _json.loads(cfg or "{}")
    try:
        texto, data, numero = _normalizar(regra["type"], cfg, regra["default_value"])
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"O valor padrão não serve para o campo: {exc}.")

    # Documentos onde ESTA regra é a que vale (a mais específica para o campo).
    docs = await conn.fetch(
        """
        SELECT d.id, v.value_text
        FROM public.documents d
        JOIN public.folders f ON f.id = d.folder_id
        LEFT JOIN public.document_field_value v ON v.document_id = d.id AND v.custom_field_id = $2
        WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
          AND ($3::ltree IS NULL OR f.path <@ $3::ltree)
          AND NOT EXISTS (
            SELECT 1 FROM public.folder_field o
            WHERE o.company_id = $1 AND o.custom_field_id = $2 AND o.id <> $4
              AND o.folder_path IS NOT NULL AND f.path <@ o.folder_path
              AND ($3::ltree IS NULL OR o.folder_path <@ $3::ltree) AND o.folder_path <> coalesce($3::ltree, ''::ltree)
          )
        """,
        regra["company_id"], regra["custom_field_id"], regra["folder_path"], rule_id,
    )
    vazios = [d["id"] for d in docs if not (d["value_text"] or "").strip()]
    diferentes = [d["id"] for d in docs if (d["value_text"] or "").strip() and d["value_text"] != texto]
    alvo = vazios + (diferentes if body.modo == "sobrescrever" else [])
    resumo = {"documentos": len(docs), "vazios": len(vazios), "diferentes": len(diferentes), "vao_mudar": len(alvo), "valor": texto}
    if not body.aplicar:
        return resumo | {"aplicado": False}
    async with conn.transaction():
        for doc_id in alvo:
            await CustomFieldsService.upsert_document_value(
                conn, document_id=doc_id, company_id=regra["company_id"], custom_field_id=regra["custom_field_id"],
                value_text=texto, value_date=data, value_number=numero, updated_by=claims["sub"],
            )
    await _log_config(conn, claims["sub"], regra["company_id"], "field_default_apply", regra["custom_field_id"], regra["label"],
                      {"valor": texto, "modo": body.modo, "documentos": len(alvo)})
    return resumo | {"aplicado": True}
