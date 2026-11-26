"""
Reserva para edição (check-out/check-in, benchmark B1.4.7): quem reserva um
documento é o único que muda o arquivo, o nome, os metadados, a pasta ou o
exclui até liberar; os outros continuam lendo. O admin da empresa pode
liberar a reserva de outra pessoa.
"""
from typing import Any, Iterable
from uuid import UUID

import asyncpg
from fastapi import HTTPException, status


async def reserva(conn: asyncpg.Connection, document_id: UUID | str) -> dict[str, Any] | None:
    row = await conn.fetchrow(
        """
        SELECT c.user_id::text, u.full_name, c.note, c.created_at
        FROM public.document_checkouts c JOIN public.users u ON u.id = c.user_id
        WHERE c.document_id = $1
        """,
        document_id,
    )
    return dict(row) if row else None


async def exigir_livre(conn: asyncpg.Connection, document_ids: Iterable[UUID | str], user_id: str) -> None:
    """423 se algum dos documentos está reservado por outra pessoa."""
    ids = [str(d) for d in document_ids]
    if not ids:
        return
    row = await conn.fetchrow(
        """
        SELECT d.name, u.full_name, c.created_at
        FROM public.document_checkouts c
        JOIN public.documents d ON d.id = c.document_id
        JOIN public.users u ON u.id = c.user_id
        WHERE c.document_id = ANY($1::uuid[]) AND c.user_id <> $2::uuid
        LIMIT 1
        """,
        ids, user_id,
    )
    if row is not None:
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail=f'"{row["name"]}" está reservado para edição por {row["full_name"]} desde {row["created_at"]:%d/%m %H:%M}. '
                   "Dá para abrir e baixar; para alterar, peça para liberar.",
            headers={"X-Docke-Code": "em_edicao"},
        )
