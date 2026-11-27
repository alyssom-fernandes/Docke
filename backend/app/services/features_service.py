"""
Recursos que cada empresa liga ou desliga (Ajustes → Recursos).

A coluna companies.features guarda só o que foi mudado; a chave ausente vale
como ligada. O canal do titular continua na coluna própria
(lgpd_channel_enabled) e aparece aqui como "canal_titular" para a tela de
Ajustes mostrar tudo num lugar só.

Desligar um recurso não apaga nada: some da tela, a API recusa criar coisa
nova e o que é público (links, pedidos de arquivo) para de abrir. Ligar de
novo devolve tudo como estava.
"""
import json
from typing import Any
from uuid import UUID

import asyncpg
from fastapi import HTTPException, status

# chave → (nome na tela, mensagem quando a API recusa)
FEATURES: dict[str, tuple[str, str]] = {
    "links": ("Compartilhamento por link", "O compartilhamento por link está desligado nesta empresa."),
    "pedidos": ("Pedidos de arquivo por link", "Os pedidos de arquivo por link estão desligados nesta empresa."),
    "obrigacoes": ("Obrigações e prazos", "As obrigações estão desligadas nesta empresa."),
    "exames": ("Exames ocupacionais (ASO)", "Os exames ocupacionais estão desligados nesta empresa."),
    "comentarios": ("Comentários e anotações", "Os comentários estão desligados nesta empresa."),
    "ocr": ("Leitura de texto", "A leitura de texto está desligada nesta empresa."),
}
# Ficam na coluna própria, não no jsonb.
COLUMN_FEATURES = {"canal_titular": "lgpd_channel_enabled"}
ALL_KEYS = set(FEATURES) | set(COLUMN_FEATURES)


def merge(raw: Any, canal_titular: bool | None = None) -> dict[str, bool]:
    """Junta o que foi gravado com os padrões (tudo ligado)."""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = {}
    raw = raw if isinstance(raw, dict) else {}
    out = {k: bool(raw.get(k, True)) for k in FEATURES}
    out["canal_titular"] = bool(canal_titular)
    return out


async def company_features(conn: asyncpg.Connection, company_id: UUID | str) -> dict[str, bool]:
    row = await conn.fetchrow(
        "SELECT features, lgpd_channel_enabled FROM public.companies WHERE id = $1", company_id,
    )
    if row is None:
        return merge({})
    return merge(row["features"], row["lgpd_channel_enabled"])


async def enabled(conn: asyncpg.Connection, company_id: UUID | str, key: str) -> bool:
    """Funciona em qualquer conexão (inclusive a das rotas públicas de link)."""
    return bool(await conn.fetchval("SELECT public.company_feature_enabled($1::uuid, $2)", str(company_id), key))


async def require(conn: asyncpg.Connection, company_id: UUID | str, key: str) -> None:
    """Recusa a ação quando o recurso está desligado, dizendo onde religar."""
    if not await enabled(conn, company_id, key):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"{FEATURES[key][1]} Quem administra a empresa pode ligar em Ajustes → Recursos.",
            headers={"X-Docke-Code": f"recurso_desligado:{key}"},
        )
