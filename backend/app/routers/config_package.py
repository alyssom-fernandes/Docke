"""
Uso, cota e pacote de configuração por empresa (achado B4.2.8 da avaliação de
25/11/2026).

- Uso: documentos, armazenamento (arquivos atuais e versões antigas), pastas
  e pessoas, com a cota quando existe.
- Cota: limite de armazenamento por empresa, definido pelo administrador
  geral. Envio que passaria do limite é recusado com mensagem clara.
- Pacote de configuração: campos de metadado, políticas de guarda e modelos
  de obrigação exportados num JSON e importados em outra empresa (só o que
  ainda não existe, pelo nome; prévia antes de aplicar).
"""
import json
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService

router = APIRouter(prefix="/companies", tags=["config-package"])

_CAMPOS = ("label", "field_key", "type", "format_config")
_POLITICAS = ("name", "legal_basis", "trigger_type", "duration_months", "locked", "start_rule", "catalog_key", "notes")
_MODELOS = ("name", "description", "frequency", "criticality", "department", "sla_days", "weight", "rules_json",
            "validity_months", "due_day", "due_month_offset", "due_month", "requires_review", "legal_basis", "catalog_key")


async def _exigir_admin(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID) -> str:
    role = await get_app_role(conn, claims)
    if role != "supremo" and not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores da empresa.")
    return role


async def uso_bytes(conn: asyncpg.Connection, company_id: UUID) -> int:
    """Bytes guardados pela empresa: arquivos atuais (inclusive lixeira) e versões antigas."""
    return int(await conn.fetchval(
        """
        SELECT COALESCE((SELECT sum(size_bytes) FROM public.documents WHERE company_id = $1 AND content_hash IS NOT NULL), 0)
             + COALESCE((SELECT sum(v.size_bytes) FROM public.document_versions v JOIN public.documents d ON d.id = v.document_id
                          WHERE d.company_id = $1 AND v.storage_key IS DISTINCT FROM d.storage_path), 0)
        """,
        company_id,
    ) or 0)


async def conferir_cota(admin_conn: asyncpg.Connection, company_id: UUID, novos_bytes: int) -> None:
    """Recusa o envio que passaria da cota da empresa (sem cota, nada muda)."""
    cota = await admin_conn.fetchval("SELECT quota_bytes FROM public.companies WHERE id = $1", company_id)
    if not cota:
        return
    usado = await uso_bytes(admin_conn, company_id)
    if usado + max(0, novos_bytes) > cota:
        gb = lambda b: f"{b / 1024 ** 3:.1f}".replace(".", ",")  # noqa: E731
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"A empresa chegou ao limite de armazenamento ({gb(usado)} GB de {gb(cota)} GB). Fale com o administrador geral.",
        )


@router.get("/{company_id}/usage")
async def uso(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    linha = await admin_conn.fetchrow(
        """
        SELECT
          (SELECT count(*) FROM public.documents WHERE company_id = $1 AND deleted_at IS NULL AND content_hash IS NOT NULL) AS documentos,
          (SELECT count(*) FROM public.documents WHERE company_id = $1 AND deleted_at IS NOT NULL) AS na_lixeira,
          (SELECT COALESCE(sum(size_bytes), 0) FROM public.documents WHERE company_id = $1 AND content_hash IS NOT NULL)::bigint AS bytes_atuais,
          (SELECT count(*) FROM public.folders WHERE company_id = $1 AND deleted_at IS NULL) AS pastas,
          (SELECT count(DISTINCT user_id) FROM public.user_company_access WHERE company_id = $1) AS pessoas,
          (SELECT quota_bytes FROM public.companies WHERE id = $1) AS cota_bytes
        """,
        company_id,
    )
    total = await uso_bytes(admin_conn, company_id)
    return dict(linha) | {"bytes_total": total, "bytes_versoes": max(0, total - int(linha["bytes_atuais"]))}


class Cota(BaseModel):
    quota_gb: float | None = Field(None, gt=0, le=100_000)


@router.put("/{company_id}/quota")
async def definir_cota(
    company_id: UUID,
    body: Cota,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    if await get_app_role(conn, claims) != "supremo":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só o administrador geral define a cota.")
    cota = int(body.quota_gb * 1024 ** 3) if body.quota_gb else None
    await admin_conn.execute("UPDATE public.companies SET quota_bytes = $2 WHERE id = $1", company_id, cota)
    await CompaniesService.log_access(admin_conn, actor_id=claims["sub"], company_id=company_id, action="quota",
                                      target_id=company_id, target_name="Cota de armazenamento",
                                      metadata={"gb": body.quota_gb})
    return {"cota_bytes": cota}


@router.get("/{company_id}/config-package")
async def exportar_pacote(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    campos = await admin_conn.fetch(
        f"""
        SELECT {", ".join("c." + c for c in _CAMPOS)}, cond.label AS condicao_campo, c.condition_value AS condicao_valor
        FROM public.custom_field c LEFT JOIN public.custom_field cond ON cond.id = c.condition_field_id
        WHERE c.company_id = $1 AND c.archived_at IS NULL ORDER BY c.label
        """,
        company_id,
    )
    politicas = await admin_conn.fetch(
        f"""
        SELECT {", ".join("p." + c for c in _POLITICAS)}, f.label AS campo_gatilho
        FROM public.retention_policies p LEFT JOIN public.custom_field f ON f.id = p.trigger_custom_field_id
        WHERE p.company_id = $1 AND p.archived_at IS NULL ORDER BY p.name
        """,
        company_id,
    )
    modelos = await admin_conn.fetch(
        f"SELECT {', '.join(_MODELOS)} FROM public.obligation_templates WHERE company_id = $1 AND archived_at IS NULL ORDER BY name",
        company_id,
    )

    def limpa(r: asyncpg.Record) -> dict[str, Any]:
        d = dict(r)
        for k, v in d.items():
            if isinstance(v, str) and k in ("format_config", "rules_json"):
                d[k] = json.loads(v)
        return d

    nome = await admin_conn.fetchval("SELECT name FROM public.companies WHERE id = $1", company_id)
    return {"docke_pacote": 1, "origem": nome, "campos": [limpa(r) for r in campos],
            "politicas": [limpa(r) for r in politicas], "modelos": [limpa(r) for r in modelos]}


class Importar(BaseModel):
    pacote: dict[str, Any]
    aplicar: bool = False


@router.post("/{company_id}/config-package/import")
async def importar_pacote(
    company_id: UUID,
    body: Importar,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    p = body.pacote
    if p.get("docke_pacote") != 1:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Arquivo não é um pacote de configuração do Docke.")
    campos = [c for c in p.get("campos", []) if isinstance(c, dict) and c.get("label") and c.get("field_key") and c.get("type")]
    politicas = [x for x in p.get("politicas", []) if isinstance(x, dict) and x.get("name")]
    modelos = [x for x in p.get("modelos", []) if isinstance(x, dict) and x.get("name") and x.get("frequency")]

    existentes_campos = {r["field_key"] for r in await admin_conn.fetch("SELECT field_key FROM public.custom_field WHERE company_id = $1", company_id)}
    existentes_pol = {r["name"].lower() for r in await admin_conn.fetch("SELECT name FROM public.retention_policies WHERE company_id = $1", company_id)}
    existentes_mod = {r["name"].lower() for r in await admin_conn.fetch("SELECT name FROM public.obligation_templates WHERE company_id = $1", company_id)}
    novos_campos = [c for c in campos if c["field_key"] not in existentes_campos]
    novas_pol = [x for x in politicas if x["name"].lower() not in existentes_pol]
    novos_mod = [x for x in modelos if x["name"].lower() not in existentes_mod]
    resumo = {
        "campos": {"novos": [c["label"] for c in novos_campos], "ja_existem": len(campos) - len(novos_campos)},
        "politicas": {"novas": [x["name"] for x in novas_pol], "ja_existem": len(politicas) - len(novas_pol)},
        "modelos": {"novos": [x["name"] for x in novos_mod], "ja_existem": len(modelos) - len(novos_mod)},
    }
    if not body.aplicar:
        return resumo | {"aplicado": False}

    async with admin_conn.transaction():
        for c in novos_campos:
            await admin_conn.execute(
                "INSERT INTO public.custom_field (company_id, label, field_key, type, format_config, created_by) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
                company_id, str(c["label"])[:120], str(c["field_key"])[:80], c["type"], json.dumps(c.get("format_config") or {}), claims["sub"],
            )
        # Condição entre campos, pelo rótulo (o id muda de uma empresa para outra).
        for c in novos_campos:
            if c.get("condicao_campo"):
                await admin_conn.execute(
                    """
                    UPDATE public.custom_field f SET condition_field_id = cond.id, condition_value = $4
                    FROM public.custom_field cond
                    WHERE f.company_id = $1 AND f.field_key = $2 AND cond.company_id = $1 AND cond.label = $3
                    """,
                    company_id, c["field_key"], c["condicao_campo"], c.get("condicao_valor"),
                )
        for x in novas_pol:
            gatilho = None
            if x.get("campo_gatilho"):
                gatilho = await admin_conn.fetchval(
                    "SELECT id FROM public.custom_field WHERE company_id = $1 AND label = $2 LIMIT 1", company_id, x["campo_gatilho"],
                )
            await admin_conn.execute(
                """
                INSERT INTO public.retention_policies
                  (company_id, name, legal_basis, trigger_type, trigger_custom_field_id, duration_months, locked, start_rule, catalog_key, notes, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'data'), $9, $10, $11)
                """,
                company_id, x["name"][:200], x.get("legal_basis"), x.get("trigger_type") if gatilho else "upload_date",
                gatilho, x.get("duration_months"), bool(x.get("locked")), x.get("start_rule"), x.get("catalog_key"), x.get("notes"), claims["sub"],
            )
        for x in novos_mod:
            await admin_conn.execute(
                """
                INSERT INTO public.obligation_templates
                  (company_id, name, description, frequency, criticality, department, sla_days, weight, rules_json,
                   validity_months, due_day, due_month_offset, due_month, requires_review, legal_basis, catalog_key, created_by)
                VALUES ($1, $2, $3, $4, coalesce($5, 'media'), $6, $7, coalesce($8, 1), coalesce($9::jsonb, '{}'::jsonb),
                        $10, $11, $12, $13, coalesce($14, false), $15, $16, $17)
                """,
                company_id, x["name"][:200], x.get("description"), x["frequency"], x.get("criticality"), x.get("department"),
                x.get("sla_days"), x.get("weight"), json.dumps(x.get("rules_json")) if x.get("rules_json") is not None else None,
                x.get("validity_months"), x.get("due_day"), x.get("due_month_offset"), x.get("due_month"), x.get("requires_review"),
                x.get("legal_basis"), x.get("catalog_key"), claims["sub"],
            )
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
            VALUES ($1::uuid, $2::uuid, 'config_package_import', 'config', $2::uuid, 'Pacote de configuração', 'config', $3::jsonb)
            """,
            claims["sub"], company_id, json.dumps({"origem": p.get("origem"), "campos": len(novos_campos),
                                                   "politicas": len(novas_pol), "modelos": len(novos_mod)}),
        )
    return resumo | {"aplicado": True}
