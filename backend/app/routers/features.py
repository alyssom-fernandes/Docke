"""
Ajustes → Recursos: o que cada empresa usa do Docke.

Qualquer pessoa com acesso à empresa lê (a tela se adapta ao que está
ligado); só quem administra a empresa (ou o administrador geral) muda. Cada
mudança fica na trilha de auditoria.
"""
import json
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services import features_service
from app.services.companies_service import CompaniesService

router = APIRouter(tags=["features"])


class FeaturesUpdate(BaseModel):
    features: dict[str, bool]


@router.get("/companies/{company_id}/features")
async def get_features(company_id: UUID, conn: asyncpg.Connection = Depends(get_db)) -> dict[str, Any]:
    row = await conn.fetchrow("SELECT features, lgpd_channel_enabled FROM public.companies WHERE id = $1", company_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    return {"features": features_service.merge(row["features"], row["lgpd_channel_enabled"])}


@router.put("/companies/{company_id}/features")
async def put_features(
    company_id: UUID,
    body: FeaturesUpdate,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    role = await get_app_role(conn, claims)
    if role != "supremo" and not await CompaniesService.user_manages_company(conn, claims["sub"], company_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só quem administra a empresa liga ou desliga recursos.")
    desconhecidos = sorted(set(body.features) - features_service.ALL_KEYS)
    if desconhecidos:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Recurso desconhecido: {', '.join(desconhecidos)}.")

    antes = await features_service.company_features(admin_conn, company_id)
    no_json = {k: v for k, v in body.features.items() if k in features_service.FEATURES}
    row = await admin_conn.fetchrow(
        "UPDATE public.companies SET features = features || $2::jsonb WHERE id = $1 RETURNING id",
        company_id, json.dumps(no_json),
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Empresa não encontrada.")
    for chave, coluna in features_service.COLUMN_FEATURES.items():
        if chave in body.features:
            await admin_conn.execute(f"UPDATE public.companies SET {coluna} = $2 WHERE id = $1", company_id, body.features[chave])

    depois = await features_service.company_features(admin_conn, company_id)
    mudou = {k: depois[k] for k in depois if depois[k] != antes[k]}
    if mudou:
        await conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
            VALUES ($1::uuid, $2::uuid, 'features', 'config', $2::uuid, 'Recursos da empresa', 'config', $3::jsonb)
            """,
            claims["sub"], company_id, json.dumps({"recursos": mudou}),
        )
    return {"features": depois}
