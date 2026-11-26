"""
Modelos e pacote de configuração (benchmark B1.5.4, B1.5.5, B1.5.6, B1.5.8).

- Modelo de estrutura: a árvore de uma pasta (subpastas, classificação LGPD,
  campos de metadados com valor padrão) guardada com nome e versão. Aplicar
  cria a árvore numa pasta nova ou a mescla numa pasta que já existe, sem
  apagar nada, com política explícita para nome repetido.
- Documento-modelo: documento marcado como modelo; "Novo a partir de modelo"
  copia o arquivo para a pasta escolhida com os metadados já preenchidos.
- Pacote de configuração: exporta e importa campos, modelos, regras de
  retenção, papéis e a árvore de pastas da empresa num JSON (serve de backup
  da configuração).

Tudo pela conexão interna, com a checagem de permissão feita aqui: admin da
empresa toda (ou o administrador geral) mexe em modelos e no pacote; para o
documento-modelo vale a permissão de escrita na pasta de destino.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService
from app.services.folders_service import FoldersService

router = APIRouter(tags=["templates"])

MAX_NOS = 500
MAX_PROFUNDIDADE = 12
SENSIBILIDADES = ("normal", "pessoal", "sensivel")
TIPOS_CAMPO_BASICOS = ("texto", "cpf", "cnpj", "data", "competencia", "numero", "selecao")


class _Desfazer(Exception):
    """Interrompe a transação de propósito na prévia (dry_run): nada fica gravado."""


async def _exigir_admin(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID | str) -> None:
    role = await get_app_role(conn, claims)
    if role == "supremo":
        return
    if not await CompaniesService.user_manages_company(conn, claims["sub"], UUID(str(company_id))):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador da empresa mexe nos modelos e na configuração.")


async def _trilha(admin_conn: asyncpg.Connection, *, user_id: str, company_id: str, action: str, item_type: str,
                  item_id: str, nome: str, meta: dict[str, Any]) -> None:
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
        VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $6, 'config', $7::jsonb)
        """,
        user_id, company_id, action, item_type, item_id, nome[:200], json.dumps(meta, ensure_ascii=False),
    )


def _json(v: Any) -> Any:
    return json.loads(v) if isinstance(v, str) else v


# ---------------------------------------------------------------------------
# Árvore: capturar de uma pasta, validar e aplicar
# ---------------------------------------------------------------------------

async def _capturar_arvore(admin_conn: asyncpg.Connection, company_id: str, raiz_path: str | None) -> list[dict[str, Any]]:
    """Lista de nós de topo. Com raiz_path, um único nó (a pasta); sem, as pastas de topo da empresa."""
    pastas = await admin_conn.fetch(
        """
        SELECT id::text, name, parent_id::text, path::text, sensitivity
        FROM public.folders
        WHERE company_id = $1::uuid AND deleted_at IS NULL AND ($2::ltree IS NULL OR path <@ $2::ltree)
        ORDER BY nlevel(path), lower(name)
        """,
        company_id, raiz_path,
    )
    campos = await admin_conn.fetch(
        """
        SELECT ff.folder_path::text AS folder_path, ff.mode, ff.required, ff.display_order, ff.default_value,
               cf.label, cf.field_key, cf.type, cf.format_config
        FROM public.folder_field ff
        JOIN public.custom_field cf ON cf.id = ff.custom_field_id
        WHERE ff.company_id = $1::uuid AND ff.folder_path IS NOT NULL AND cf.archived_at IS NULL
          AND ($2::ltree IS NULL OR ff.folder_path <@ $2::ltree)
        ORDER BY ff.display_order, cf.label
        """,
        company_id, raiz_path,
    )
    por_path: dict[str, list[dict[str, Any]]] = {}
    for c in campos:
        por_path.setdefault(c["folder_path"], []).append({
            "field_key": c["field_key"], "label": c["label"], "type": c["type"],
            "format_config": _json(c["format_config"]) or {}, "mode": c["mode"], "required": c["required"],
            "display_order": c["display_order"], "default_value": c["default_value"],
        })
    nos: dict[str, dict[str, Any]] = {}
    topo: list[dict[str, Any]] = []
    for p in pastas:
        no = {"name": p["name"], "sensitivity": p["sensitivity"], "fields": por_path.get(p["path"], []), "children": []}
        nos[p["id"]] = no
        pai = nos.get(p["parent_id"]) if p["parent_id"] else None
        if pai is not None:
            pai["children"].append(no)
        else:
            topo.append(no)
    if len(nos) > MAX_NOS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"A estrutura tem {len(nos)} pastas; o limite de um modelo é {MAX_NOS}.")
    return topo


def _validar_no(no: Any, profundidade: int, contador: list[int]) -> dict[str, Any]:
    """Normaliza um nó vindo de fora (pacote importado): nomes, tipos e limites."""
    if not isinstance(no, dict):
        raise HTTPException(status_code=422, detail="Estrutura inválida: cada pasta precisa ser um objeto.")
    contador[0] += 1
    if contador[0] > MAX_NOS or profundidade > MAX_PROFUNDIDADE:
        raise HTTPException(status_code=422, detail=f"Estrutura grande demais (até {MAX_NOS} pastas e {MAX_PROFUNDIDADE} níveis).")
    nome = str(no.get("name") or "").strip()
    if not nome or len(nome) > 120 or "/" in nome:
        raise HTTPException(status_code=422, detail=f"Nome de pasta inválido no modelo: {nome[:60]!r}.")
    sens = no.get("sensitivity") or "normal"
    if sens not in SENSIBILIDADES:
        sens = "normal"
    campos = []
    for c in no.get("fields") or []:
        if not isinstance(c, dict) or not c.get("field_key") or not c.get("label") or not c.get("type"):
            raise HTTPException(status_code=422, detail=f"Campo inválido na pasta {nome!r}.")
        campos.append({
            "field_key": str(c["field_key"])[:80], "label": str(c["label"])[:120], "type": str(c["type"])[:40],
            "format_config": c.get("format_config") if isinstance(c.get("format_config"), dict) else {},
            "mode": c.get("mode") if c.get("mode") in ("apply", "exclude") else "apply",
            "required": bool(c.get("required")), "display_order": int(c.get("display_order") or 0),
            "default_value": (str(c["default_value"])[:500] if c.get("default_value") not in (None, "") else None),
        })
    filhos = [_validar_no(f, profundidade + 1, contador) for f in (no.get("children") or [])]
    return {"name": nome, "sensitivity": sens, "fields": campos, "children": filhos}


def _validar_arvore(arvore: Any) -> list[dict[str, Any]]:
    if not isinstance(arvore, list) or not arvore:
        raise HTTPException(status_code=422, detail="Estrutura vazia ou inválida.")
    contador = [0]
    return [_validar_no(n, 1, contador) for n in arvore]


def _contar(arvore: list[dict[str, Any]]) -> int:
    return sum(1 + _contar(n["children"]) for n in arvore)


async def _campo_id(admin_conn: asyncpg.Connection, company_id: str, campo: dict[str, Any], user_id: str, out: dict[str, Any]) -> str:
    fid = await admin_conn.fetchval(
        "SELECT id::text FROM public.custom_field WHERE company_id = $1::uuid AND field_key = $2 AND archived_at IS NULL",
        company_id, campo["field_key"],
    )
    if fid:
        return fid
    out["campos_criados"] += 1
    return await admin_conn.fetchval(
        """
        INSERT INTO public.custom_field (company_id, label, field_key, type, format_config, created_by)
        VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::uuid) RETURNING id::text
        """,
        company_id, campo["label"], campo["field_key"], campo["type"], json.dumps(campo["format_config"]), user_id,
    )


async def _aplicar_no(admin_conn: asyncpg.Connection, *, company_id: str, no: dict[str, Any], pai_id: str | None,
                      pai_path: str | None, conflito: str, user_id: str, rotulo: str, out: dict[str, Any],
                      destino: tuple[str, str, str] | None = None) -> None:
    caminho = f"{rotulo} / {no['name']}" if rotulo else no["name"]
    if destino is not None:
        # O nó de topo vira a própria pasta de destino; os caminhos dos filhos partem dela.
        fid, fpath, nome_destino = destino
        out["mescladas"].append(nome_destino)
        caminho = ""
    else:
        existente = await admin_conn.fetchrow(
            """
            SELECT id::text, path::text, sensitivity FROM public.folders
            WHERE company_id = $1::uuid AND parent_id IS NOT DISTINCT FROM $2::uuid
              AND lower(name) = lower($3) AND deleted_at IS NULL
            LIMIT 1
            """,
            company_id, pai_id, no["name"],
        )
        if existente is not None and conflito == "pular":
            out["puladas"].append(caminho)
            return
        if existente is not None and conflito == "mesclar":
            fid, fpath = existente["id"], existente["path"]
            out["mescladas"].append(caminho)
            # Só sobe a proteção: pasta "normal" passa a pessoal/sensível; nunca o contrário.
            if no["sensitivity"] != "normal" and existente["sensitivity"] == "normal":
                await admin_conn.execute("UPDATE public.folders SET sensitivity = $2 WHERE id = $1::uuid", fid, no["sensitivity"])
        else:
            nome = no["name"]
            if existente is not None:  # renomear
                nome = await FoldersService.resolve_unique_folder_name(admin_conn, parent_id=UUID(pai_id) if pai_id else None, company_id=company_id, name=nome)
                caminho = f"{rotulo} / {nome}" if rotulo else nome
            label = await FoldersService.generate_path_label(admin_conn)
            fpath = f"{pai_path}.{label}" if pai_path else label
            fid = await admin_conn.fetchval(
                """
                INSERT INTO public.folders (company_id, parent_id, path, name, created_by, sensitivity)
                VALUES ($1::uuid, $2::uuid, $3::ltree, $4, $5::uuid, $6) RETURNING id::text
                """,
                company_id, pai_id, fpath, nome, user_id, no["sensitivity"],
            )
            out["criadas"].append(caminho)
            if out.get("raiz_id") is None:
                out["raiz_id"] = fid
    for campo in no["fields"]:
        cid = await _campo_id(admin_conn, company_id, campo, user_id, out)
        r = await admin_conn.execute(
            """
            INSERT INTO public.folder_field (company_id, folder_path, custom_field_id, mode, required, display_order, default_value, created_by)
            VALUES ($1::uuid, $2::ltree, $3::uuid, $4, $5, $6, $7, $8::uuid)
            ON CONFLICT (company_id, folder_path, custom_field_id) DO NOTHING
            """,
            company_id, fpath, cid, campo["mode"], campo["required"], campo["display_order"], campo["default_value"], user_id,
        )
        if r.endswith(" 1"):
            out["regras_de_campo"] += 1
    for filho in no["children"]:
        await _aplicar_no(admin_conn, company_id=company_id, no=filho, pai_id=fid, pai_path=fpath,
                          conflito=conflito, user_id=user_id, rotulo=caminho, out=out)


def _resultado_vazio() -> dict[str, Any]:
    return {"criadas": [], "mescladas": [], "puladas": [], "regras_de_campo": 0, "campos_criados": 0, "raiz_id": None}


# ---------------------------------------------------------------------------
# Modelos de estrutura
# ---------------------------------------------------------------------------

class TemplateCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str | None = Field(None, max_length=500)
    source_folder_id: UUID


class TemplateUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=500)
    source_folder_id: UUID | None = None  # regrava a árvore a partir da pasta: nova versão


class TemplateApply(BaseModel):
    # Uma das duas: aplicar DENTRO de uma pasta que já existe (mescla o
    # conteúdo do modelo nela) ou criar a pasta do modelo sob um pai (None = topo).
    target_folder_id: UUID | None = None
    target_parent_id: UUID | None = None
    conflito: Literal["mesclar", "renomear", "pular"] = "mesclar"
    dry_run: bool = False


async def _pasta(admin_conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record:
    p = await admin_conn.fetchrow(
        "SELECT id::text, company_id::text, name, path::text FROM public.folders WHERE id = $1 AND deleted_at IS NULL", folder_id,
    )
    if p is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    return p


async def _modelo(admin_conn: asyncpg.Connection, template_id: UUID) -> asyncpg.Record:
    m = await admin_conn.fetchrow(
        """
        SELECT id::text, company_id::text, name, description, version, tree, updated_at
        FROM public.structure_templates WHERE id = $1 AND archived_at IS NULL
        """,
        template_id,
    )
    if m is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo não encontrado.")
    return m


def _resumo_modelo(m: asyncpg.Record | dict[str, Any]) -> dict[str, Any]:
    arvore = _json(m["tree"])
    return {
        "id": m["id"], "name": m["name"], "description": m["description"], "version": m["version"],
        "updated_at": m["updated_at"], "folders": _contar(arvore),
        "fields": sum(len(n["fields"]) for n in _achatar(arvore)),
        "top": [n["name"] for n in arvore][:3],
    }


def _achatar(arvore: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for n in arvore:
        out.append(n)
        out.extend(_achatar(n["children"]))
    return out


@router.get("/companies/{company_id}/structure-templates")
async def list_templates(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    await _exigir_admin(conn, claims, company_id)
    rows = await admin_conn.fetch(
        """
        SELECT id::text, name, description, version, tree, updated_at
        FROM public.structure_templates WHERE company_id = $1 AND archived_at IS NULL ORDER BY lower(name)
        """,
        company_id,
    )
    return [_resumo_modelo(r) for r in rows]


@router.post("/companies/{company_id}/structure-templates", status_code=status.HTTP_201_CREATED)
async def create_template(
    company_id: UUID,
    body: TemplateCreate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    pasta = await _pasta(admin_conn, body.source_folder_id)
    if pasta["company_id"] != str(company_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    arvore = await _capturar_arvore(admin_conn, str(company_id), pasta["path"])
    try:
        row = await admin_conn.fetchrow(
            """
            INSERT INTO public.structure_templates (company_id, name, description, tree, created_by, updated_by)
            VALUES ($1, $2, $3, $4::jsonb, $5::uuid, $5::uuid)
            RETURNING id::text, name, description, version, tree, updated_at
            """,
            company_id, body.name.strip(), (body.description or "").strip() or None, json.dumps(arvore, ensure_ascii=False), claims["sub"],
        )
    except asyncpg.UniqueViolationError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe um modelo com esse nome. Escolha outro ou atualize o existente.")
    await _trilha(admin_conn, user_id=claims["sub"], company_id=str(company_id), action="template_saved", item_type="config",
                  item_id=row["id"], nome=row["name"], meta={"versao": 1, "pasta_origem": pasta["name"]})
    return _resumo_modelo(row)


@router.get("/structure-templates/{template_id}")
async def get_template(
    template_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    m = await _modelo(admin_conn, template_id)
    await _exigir_admin(conn, claims, m["company_id"])
    versoes = await admin_conn.fetch(
        """
        SELECT v.version, v.saved_at, u.full_name AS saved_by_name, v.tree
        FROM public.structure_template_versions v LEFT JOIN public.users u ON u.id = v.saved_by
        WHERE v.template_id = $1 ORDER BY v.version DESC
        """,
        template_id,
    )
    return {
        **_resumo_modelo(m), "tree": _json(m["tree"]),
        "versions": [{"version": v["version"], "saved_at": v["saved_at"], "saved_by_name": v["saved_by_name"],
                      "folders": _contar(_json(v["tree"]))} for v in versoes],
    }


async def _nova_versao(admin_conn: asyncpg.Connection, m: asyncpg.Record, arvore: list[dict[str, Any]], user_id: str) -> None:
    await admin_conn.execute(
        """
        INSERT INTO public.structure_template_versions (template_id, version, tree, saved_by)
        VALUES ($1::uuid, $2, $3::jsonb, $4::uuid) ON CONFLICT DO NOTHING
        """,
        m["id"], m["version"], json.dumps(_json(m["tree"]), ensure_ascii=False), user_id,
    )
    await admin_conn.execute(
        "UPDATE public.structure_templates SET tree = $2::jsonb, version = version + 1, updated_by = $3::uuid, updated_at = now() WHERE id = $1::uuid",
        m["id"], json.dumps(arvore, ensure_ascii=False), user_id,
    )


@router.put("/structure-templates/{template_id}")
async def update_template(
    template_id: UUID,
    body: TemplateUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    m = await _modelo(admin_conn, template_id)
    await _exigir_admin(conn, claims, m["company_id"])
    async with admin_conn.transaction():
        if body.name is not None or body.description is not None:
            try:
                await admin_conn.execute(
                    "UPDATE public.structure_templates SET name = COALESCE($2, name), description = $3, updated_at = now() WHERE id = $1",
                    template_id, body.name.strip() if body.name else None,
                    (body.description.strip() or None) if body.description is not None else m["description"],
                )
            except asyncpg.UniqueViolationError:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Já existe um modelo com esse nome.")
        if body.source_folder_id is not None:
            pasta = await _pasta(admin_conn, body.source_folder_id)
            if pasta["company_id"] != m["company_id"]:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
            await _nova_versao(admin_conn, m, await _capturar_arvore(admin_conn, m["company_id"], pasta["path"]), claims["sub"])
            await _trilha(admin_conn, user_id=claims["sub"], company_id=m["company_id"], action="template_saved", item_type="config",
                          item_id=m["id"], nome=body.name or m["name"], meta={"versao": m["version"] + 1, "pasta_origem": pasta["name"]})
    return _resumo_modelo(await _modelo(admin_conn, template_id))


@router.post("/structure-templates/{template_id}/restore/{version}")
async def restore_template_version(
    template_id: UUID,
    version: int,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """Volta a uma versão anterior sem perder a atual: a atual vira histórico e a antiga vira a versão nova."""
    m = await _modelo(admin_conn, template_id)
    await _exigir_admin(conn, claims, m["company_id"])
    antiga = await admin_conn.fetchval(
        "SELECT tree FROM public.structure_template_versions WHERE template_id = $1 AND version = $2", template_id, version,
    )
    if antiga is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Versão não encontrada.")
    async with admin_conn.transaction():
        await _nova_versao(admin_conn, m, _json(antiga), claims["sub"])
        await _trilha(admin_conn, user_id=claims["sub"], company_id=m["company_id"], action="template_saved", item_type="config",
                      item_id=m["id"], nome=m["name"], meta={"versao": m["version"] + 1, "restaurada_de": version})
    return _resumo_modelo(await _modelo(admin_conn, template_id))


@router.delete("/structure-templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    m = await _modelo(admin_conn, template_id)
    await _exigir_admin(conn, claims, m["company_id"])
    await admin_conn.execute("UPDATE public.structure_templates SET archived_at = now() WHERE id = $1", template_id)
    await _trilha(admin_conn, user_id=claims["sub"], company_id=m["company_id"], action="template_deleted", item_type="config",
                  item_id=m["id"], nome=m["name"], meta={"versao": m["version"]})


async def _aplicar_arvore(admin_conn: asyncpg.Connection, *, company_id: str, arvore: list[dict[str, Any]],
                          destino: asyncpg.Record | None, pai: asyncpg.Record | None, conflito: str, user_id: str) -> dict[str, Any]:
    out = _resultado_vazio()
    if destino is not None:
        # Mescla: o conteúdo de cada nó de topo (campos e subpastas) entra na pasta de destino.
        for no in arvore:
            await _aplicar_no(admin_conn, company_id=company_id, no=no, pai_id=None, pai_path=None, conflito=conflito,
                              user_id=user_id, rotulo="", out=out, destino=(destino["id"], destino["path"], destino["name"]))
        out["raiz_id"] = destino["id"]
    else:
        for no in arvore:
            await _aplicar_no(admin_conn, company_id=company_id, no=no, pai_id=pai["id"] if pai else None,
                              pai_path=pai["path"] if pai else None, conflito=conflito, user_id=user_id, rotulo="", out=out)
    return out


@router.post("/structure-templates/{template_id}/apply")
async def apply_template(
    template_id: UUID,
    body: TemplateApply,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Nunca apaga nem renomeia o que já existe. Nome repetido no mesmo nível:
    "mesclar" entra na pasta existente, "renomear" cria "Nome (1)", "pular"
    deixa aquele ramo de fora. Campo já aplicado na pasta fica como está.
    dry_run devolve o que aconteceria (a transação é desfeita no fim).
    """
    m = await _modelo(admin_conn, template_id)
    await _exigir_admin(conn, claims, m["company_id"])
    if body.target_folder_id and body.target_parent_id:
        raise HTTPException(status_code=422, detail="Escolha aplicar dentro de uma pasta ou criar sob uma pasta, não os dois.")
    destino = await _pasta(admin_conn, body.target_folder_id) if body.target_folder_id else None
    pai = await _pasta(admin_conn, body.target_parent_id) if body.target_parent_id else None
    for p in (destino, pai):
        if p is not None and p["company_id"] != m["company_id"]:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    arvore = _json(m["tree"])
    out: dict[str, Any] = {}
    try:
        async with admin_conn.transaction():
            out = await _aplicar_arvore(admin_conn, company_id=m["company_id"], arvore=arvore, destino=destino, pai=pai,
                                        conflito=body.conflito, user_id=claims["sub"])
            if body.dry_run:
                raise _Desfazer
            alvo = out["raiz_id"] or (pai["id"] if pai else None)
            if alvo:
                await _trilha(admin_conn, user_id=claims["sub"], company_id=m["company_id"], action="template_applied", item_type="folder",
                              item_id=alvo, nome=m["name"],
                              meta={"modelo": m["name"], "versao": m["version"], "conflito": body.conflito,
                                    "criadas": len(out["criadas"]), "mescladas": len(out["mescladas"]), "puladas": len(out["puladas"])})
    except _Desfazer:
        out["raiz_id"] = None
    return {**out, "dry_run": body.dry_run}


# ---------------------------------------------------------------------------
# Documento-modelo (B1.5.6)
# ---------------------------------------------------------------------------

class DocTemplateFlag(BaseModel):
    is_template: bool


class NewFromTemplate(BaseModel):
    folder_id: UUID
    name: str | None = Field(None, max_length=200)


@router.put("/documents/{document_id}/template")
async def set_document_template(
    document_id: UUID,
    body: DocTemplateFlag,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    doc = await conn.fetchrow(
        """
        SELECT d.id::text, d.name, d.company_id::text, f.path::text AS path
        FROM public.documents d JOIN public.folders f ON f.id = d.folder_id
        WHERE d.id = $1 AND d.deleted_at IS NULL
        """,
        document_id,
    )
    if doc is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado.")
    nivel = await FoldersService.check_permission(conn, claims["sub"], doc["path"], UUID(doc["company_id"]))
    if nivel not in ("admin", "supremo") and await get_app_role(conn, claims) != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador da pasta marca um documento como modelo.")
    await admin_conn.execute("UPDATE public.documents SET is_template = $2 WHERE id = $1", document_id, body.is_template)
    await _trilha(admin_conn, user_id=claims["sub"], company_id=doc["company_id"], action="template_marked" if body.is_template else "template_unmarked",
                  item_type="document", item_id=doc["id"], nome=doc["name"], meta={})
    return {"is_template": body.is_template}


@router.get("/companies/{company_id}/document-templates")
async def list_document_templates(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """Modelos de documento que a pessoa enxerga (o RLS da conexão dela filtra), com os metadados que vêm junto."""
    rows = await conn.fetch(
        """
        SELECT d.id::text, d.name, d.file_type, f.name AS folder_name,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('label', cf.label, 'value', v.value_text) ORDER BY cf.label)
                         FROM public.document_field_value v JOIN public.custom_field cf ON cf.id = v.custom_field_id
                         WHERE v.document_id = d.id), '[]'::jsonb) AS fields
        FROM public.documents d JOIN public.folders f ON f.id = d.folder_id
        WHERE d.company_id = $1 AND d.is_template AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
        ORDER BY lower(d.name)
        """,
        company_id,
    )
    return [{**dict(r), "fields": _json(r["fields"])} for r in rows]


@router.post("/document-templates/{document_id}/new", status_code=status.HTTP_201_CREATED)
async def new_from_document_template(
    document_id: UUID,
    body: NewFromTemplate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    modelo = await conn.fetchrow(
        f"SELECT {FoldersService._COPY_COLS}, company_id::text FROM public.documents WHERE id = $1 AND is_template AND deleted_at IS NULL AND content_hash IS NOT NULL",
        document_id,
    )
    if modelo is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Modelo de documento não encontrado.")
    pasta = await conn.fetchrow(
        "SELECT id, company_id::text, path::text FROM public.folders WHERE id = $1 AND deleted_at IS NULL", body.folder_id,
    )
    if pasta is None or pasta["company_id"] != modelo["company_id"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    nivel = await FoldersService.check_permission(conn, claims["sub"], pasta["path"], UUID(pasta["company_id"]))
    if nivel not in ("admin", "operador", "supremo"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Você só lê esta pasta: peça a quem administra para enviar.")
    registro = dict(modelo)
    if body.name and body.name.strip():
        ext = modelo["name"][modelo["name"].rfind("."):] if "." in modelo["name"] else ""
        base = body.name.strip()
        registro["name"] = base if (ext and base.lower().endswith(ext.lower())) else base + ext
    novos = await FoldersService.copy_documents(
        conn, docs=[registro], target_folder_id=body.folder_id, target_company_id=UUID(pasta["company_id"]), uploaded_by=claims["sub"],
    )
    novo = novos[0]
    copiados = await conn.execute(
        """
        INSERT INTO public.document_field_value (company_id, document_id, custom_field_id, value_text, value_date, value_number, updated_by)
        SELECT company_id, $2::uuid, custom_field_id, value_text, value_date, value_number, $3::uuid
        FROM public.document_field_value WHERE document_id = $1
        ON CONFLICT (document_id, custom_field_id) DO NOTHING
        """,
        document_id, novo, claims["sub"],
    )
    nome = await conn.fetchval("SELECT name FROM public.documents WHERE id = $1::uuid", novo)
    await _trilha(admin_conn, user_id=claims["sub"], company_id=pasta["company_id"], action="created_from_template", item_type="document",
                  item_id=novo, nome=nome, meta={"modelo": modelo["name"]})
    return {"id": novo, "name": nome, "fields_copied": int(copiados.split()[-1])}


# ---------------------------------------------------------------------------
# Pacote de configuração (B1.5.5)
# ---------------------------------------------------------------------------

FORMATO = "docke-configuracao"


@router.get("/companies/{company_id}/config-package")
async def export_config(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    empresa = await admin_conn.fetchval("SELECT name FROM public.companies WHERE id = $1", company_id)
    if empresa is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    campos = await admin_conn.fetch(
        """
        SELECT cf.field_key, cf.label, cf.type, cf.format_config, c2.field_key AS condition_field_key, cf.condition_value
        FROM public.custom_field cf LEFT JOIN public.custom_field c2 ON c2.id = cf.condition_field_id
        WHERE cf.company_id = $1 AND cf.archived_at IS NULL ORDER BY cf.label
        """,
        company_id,
    )
    gerais = await admin_conn.fetch(
        """
        SELECT cf.field_key, ff.mode, ff.required, ff.display_order, ff.default_value
        FROM public.folder_field ff JOIN public.custom_field cf ON cf.id = ff.custom_field_id
        WHERE ff.company_id = $1 AND ff.folder_path IS NULL AND cf.archived_at IS NULL
        """,
        company_id,
    )
    modelos = await admin_conn.fetch(
        "SELECT name, description, tree FROM public.structure_templates WHERE company_id = $1 AND archived_at IS NULL ORDER BY lower(name)",
        company_id,
    )
    retencao = await admin_conn.fetch(
        """
        SELECT p.name, p.legal_basis, p.trigger_type, tf.field_key AS trigger_field_key, p.duration_months, p.locked, p.active,
               p.start_rule, p.catalog_key, p.notes,
               EXISTS (SELECT 1 FROM public.retention_policy_assignments a
                       WHERE a.policy_id = p.id AND a.folder_path IS NULL AND a.match_tipo_fiscal IS NULL AND a.match_field_id IS NULL) AS empresa_toda
        FROM public.retention_policies p
        LEFT JOIN public.custom_field tf ON tf.id = p.trigger_custom_field_id
        WHERE p.company_id = $1 AND p.archived_at IS NULL ORDER BY p.name
        """,
        company_id,
    )
    papeis = await admin_conn.fetch(
        """
        SELECT r.key, r.label, COALESCE(array_agg(rp.permission ORDER BY rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
        FROM public.role r LEFT JOIN public.role_permission rp ON rp.role_id = r.id
        WHERE r.company_id = $1 GROUP BY r.id ORDER BY r.label
        """,
        company_id,
    )
    pacote = {
        "formato": FORMATO, "versao": 1, "exportado_em": datetime.now(timezone.utc).isoformat(), "empresa": empresa,
        "campos": [{**dict(c), "format_config": _json(c["format_config"]) or {}} for c in campos],
        "campos_empresa_toda": [dict(g) for g in gerais],
        "modelos": [{"name": m["name"], "description": m["description"], "tree": _json(m["tree"])} for m in modelos],
        "retencao": [dict(r) for r in retencao],
        "papeis": [{"key": p["key"], "label": p["label"], "permissions": list(p["permissions"])} for p in papeis],
        "pastas": await _capturar_arvore(admin_conn, str(company_id), None),
    }
    await _trilha(admin_conn, user_id=claims["sub"], company_id=str(company_id), action="config_exported", item_type="config",
                  item_id=str(company_id), nome="Pacote de configuração",
                  meta={k: len(v) for k, v in pacote.items() if isinstance(v, list)})
    return pacote


class ConfigImport(BaseModel):
    pacote: dict[str, Any]
    incluir_pastas: bool = False
    dry_run: bool = False


@router.post("/companies/{company_id}/config-package")
async def import_config(
    company_id: UUID,
    body: ConfigImport,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Só acrescenta: campo com a mesma chave, modelo com o mesmo nome (a menos
    que a árvore mude: aí vira versão nova), regra de retenção com o mesmo
    nome e papel com a mesma chave ficam como estão. Pastas, se pedidas, são
    mescladas pelo nome. dry_run devolve o resumo sem gravar.
    """
    await _exigir_admin(conn, claims, company_id)
    p = body.pacote
    if p.get("formato") != FORMATO or p.get("versao") != 1:
        raise HTTPException(status_code=422, detail="Este arquivo não é um pacote de configuração do Docke (versão 1).")
    cid, uid = str(company_id), claims["sub"]
    res: dict[str, Any] = {"campos_criados": 0, "regras_gerais": 0, "modelos_criados": 0, "modelos_atualizados": 0,
                           "retencao_criadas": 0, "papeis_criados": 0, "pastas": None, "ignorados": []}
    modelos = [(str(m.get("name") or "").strip()[:120], (m.get("description") or None), _validar_arvore(m.get("tree"))) for m in (p.get("modelos") or [])]
    pastas = _validar_arvore(p.get("pastas")) if body.incluir_pastas and p.get("pastas") else None
    try:
        async with admin_conn.transaction():
            chaves: dict[str, str] = {}
            for c in p.get("campos") or []:
                if not isinstance(c, dict) or not c.get("field_key") or not c.get("label") or not c.get("type"):
                    res["ignorados"].append("campo sem chave, nome ou tipo")
                    continue
                aux = {"campos_criados": 0}
                campo = {"field_key": str(c["field_key"])[:80], "label": str(c["label"])[:120], "type": str(c["type"])[:40],
                         "format_config": c.get("format_config") if isinstance(c.get("format_config"), dict) else {}}
                try:
                    async with admin_conn.transaction():
                        chaves[campo["field_key"]] = await _campo_id(admin_conn, cid, campo, uid, aux)
                except asyncpg.CheckViolationError:
                    res["ignorados"].append(f"campo {campo['label']!r}: tipo {campo['type']!r} não existe aqui")
                    continue
                res["campos_criados"] += aux["campos_criados"]
            for c in p.get("campos") or []:
                if isinstance(c, dict) and c.get("condition_field_key") in chaves and c.get("field_key") in chaves:
                    await admin_conn.execute(
                        "UPDATE public.custom_field SET condition_field_id = $2::uuid, condition_value = $3 WHERE id = $1::uuid AND condition_field_id IS NULL",
                        chaves[c["field_key"]], chaves[c["condition_field_key"]], c.get("condition_value"),
                    )
            for g in p.get("campos_empresa_toda") or []:
                if not isinstance(g, dict) or g.get("field_key") not in chaves:
                    continue
                r = await admin_conn.execute(
                    """
                    INSERT INTO public.folder_field (company_id, folder_path, custom_field_id, mode, required, display_order, default_value, created_by)
                    VALUES ($1::uuid, NULL, $2::uuid, $3, $4, $5, $6, $7::uuid)
                    ON CONFLICT (company_id, folder_path, custom_field_id) DO NOTHING
                    """,
                    cid, chaves[g["field_key"]], g.get("mode") if g.get("mode") in ("apply", "exclude") else "apply",
                    bool(g.get("required")), int(g.get("display_order") or 0), g.get("default_value"), uid,
                )
                res["regras_gerais"] += 1 if r.endswith(" 1") else 0
            for nome, desc, arvore in modelos:
                if not nome:
                    res["ignorados"].append("modelo sem nome")
                    continue
                atual = await admin_conn.fetchrow(
                    "SELECT id::text, name, description, version, tree FROM public.structure_templates WHERE company_id = $1::uuid AND lower(btrim(name)) = lower($2) AND archived_at IS NULL",
                    cid, nome,
                )
                if atual is None:
                    await admin_conn.execute(
                        "INSERT INTO public.structure_templates (company_id, name, description, tree, created_by, updated_by) VALUES ($1::uuid, $2, $3, $4::jsonb, $5::uuid, $5::uuid)",
                        cid, nome, (str(desc)[:500] if desc else None), json.dumps(arvore, ensure_ascii=False), uid,
                    )
                    res["modelos_criados"] += 1
                elif _json(atual["tree"]) != arvore:
                    await _nova_versao(admin_conn, atual, arvore, uid)
                    res["modelos_atualizados"] += 1
            for r in p.get("retencao") or []:
                if not isinstance(r, dict) or not str(r.get("name") or "").strip():
                    continue
                nome = str(r["name"]).strip()[:120]
                if await admin_conn.fetchval(
                    "SELECT 1 FROM public.retention_policies WHERE company_id = $1::uuid AND lower(name) = lower($2) AND archived_at IS NULL", cid, nome,
                ):
                    continue
                gatilho = chaves.get(r.get("trigger_field_key") or "")
                tipo = "custom_field" if r.get("trigger_type") == "custom_field" and gatilho else "upload_date"
                try:
                    async with admin_conn.transaction():
                        pid = await admin_conn.fetchval(
                            """
                            INSERT INTO public.retention_policies
                              (company_id, name, legal_basis, trigger_type, trigger_custom_field_id, duration_months, locked, active,
                               start_rule, catalog_key, notes, created_by)
                            VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11, $12::uuid)
                            RETURNING id
                            """,
                            cid, nome, r.get("legal_basis"), tipo, gatilho if tipo == "custom_field" else None,
                            r.get("duration_months"), bool(r.get("locked")), r.get("active", True) is not False,
                            r.get("start_rule") if r.get("start_rule") in ("data", "ano_seguinte") else "data",
                            r.get("catalog_key"), r.get("notes"), uid,
                        )
                        if r.get("empresa_toda"):
                            await admin_conn.execute(
                                "INSERT INTO public.retention_policy_assignments (company_id, folder_path, policy_id, created_by) VALUES ($1::uuid, NULL, $2, $3::uuid) ON CONFLICT DO NOTHING",
                                cid, pid, uid,
                            )
                except (asyncpg.CheckViolationError, asyncpg.DataError):
                    res["ignorados"].append(f"retenção {nome!r}: valores inválidos")
                    continue
                res["retencao_criadas"] += 1
            for papel in p.get("papeis") or []:
                if not isinstance(papel, dict) or not papel.get("key") or not papel.get("label"):
                    continue
                rid = await admin_conn.fetchval(
                    """
                    INSERT INTO public.role (company_id, key, label) VALUES ($1::uuid, $2, $3)
                    ON CONFLICT (company_id, key) WHERE company_id IS NOT NULL DO NOTHING RETURNING id
                    """,
                    cid, str(papel["key"])[:60], str(papel["label"])[:120],
                )
                if rid is not None:
                    res["papeis_criados"] += 1
                    for perm in papel.get("permissions") or []:
                        await admin_conn.execute(
                            "INSERT INTO public.role_permission (role_id, permission) VALUES ($1, $2) ON CONFLICT DO NOTHING", rid, str(perm)[:80],
                        )
            if pastas is not None:
                out = await _aplicar_arvore(admin_conn, company_id=cid, arvore=pastas, destino=None, pai=None, conflito="mesclar", user_id=uid)
                res["pastas"] = {"criadas": len(out["criadas"]), "mescladas": len(out["mescladas"]),
                                 "regras_de_campo": out["regras_de_campo"]}
                res["campos_criados"] += out["campos_criados"]
            if body.dry_run:
                raise _Desfazer
            await _trilha(admin_conn, user_id=uid, company_id=cid, action="config_imported", item_type="config", item_id=cid,
                          nome="Pacote de configuração", meta={k: v for k, v in res.items() if k != "ignorados"} | {"origem": p.get("empresa")})
    except _Desfazer:
        pass
    return {**res, "dry_run": body.dry_run}
