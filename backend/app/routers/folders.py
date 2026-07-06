from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin
from app.services.folders_service import FoldersService

router = APIRouter(prefix="/folders", tags=["folders"])


class FolderCreate(BaseModel):
    name: str
    parent_id: UUID | None = None
    company_id: UUID


class FolderRename(BaseModel):
    name: str


class FolderMove(BaseModel):
    parent_id: UUID | None = None


# ---------------------------------------------------------------------------
# GET /folders — lista pastas de uma empresa (filtra por parent_id opcional)
# ---------------------------------------------------------------------------

@router.get("")
async def list_folders(
    company_id: UUID = Query(...),
    parent_id: UUID | None = Query(None),
    flat: bool = Query(False, description="Ignora parent_id e retorna todas as pastas da empresa, ordenadas por path (uso: seletor de pasta em telas administrativas)."),
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Lista pastas da empresa visíveis ao usuário (RLS filtra automaticamente).
    parent_id=null → pastas raiz; parent_id=<uuid> → filhos diretos.
    flat=true → árvore inteira achatada, ordenada por path.
    """
    rows = await FoldersService.list_folders(conn, company_id=company_id, parent_id=parent_id, flat=flat)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /folders/frequent — pastas mais acessadas recentemente pelo usuário
# ---------------------------------------------------------------------------

@router.get("/frequent")
async def frequent_folders(
    company_id: UUID = Query(...),
    limit: int = Query(5, ge=1, le=20),
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """
    Retorna as pastas com mais atividade recente do usuário (últimos 30 dias).
    Baseado em activity_log: conta eventos de upload/view/download em cada pasta.
    """
    user_id = claims["sub"]
    rows = await FoldersService.frequent_folders(conn, user_id=user_id, company_id=company_id, limit=limit)
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# POST /folders — cria pasta
# ---------------------------------------------------------------------------

@router.post("", status_code=status.HTTP_201_CREATED)
async def create_folder(
    body: FolderCreate,
    conn: asyncpg.Connection = Depends(get_db),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Cria uma pasta com path ltree calculado a partir do parent.
    Path raiz: text2ltree(replace(gen_random_uuid()::text, '-', ''))
    Path filho: parent.path || label_filho
    """
    user_id = claims["sub"]

    # Busca path do parent (se houver) e valida acesso
    if body.parent_id is not None:
        parent = await FoldersService.get_parent_folder(conn, body.parent_id)
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta pai não encontrada.")
        if str(parent["company_id"]) != str(body.company_id):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Pasta pai pertence a outra empresa.")
        check_path = parent["path"]
        new_label = await FoldersService.generate_path_label(conn)
        new_path = f"{parent['path']}.{new_label}"
    else:
        check_path = None
        # Raiz da empresa — gera path único sem pontos
        new_label = await FoldersService.generate_path_label(conn)
        new_path = new_label

    # Checagem explícita ANTES do INSERT: sem isso, quem não tem permissão de
    # escrita esbarra só na RLS, que rejeita a linha com uma exceção crua do
    # Postgres — isso não vira um 403 limpo, derruba a conexão (net::ERR_FAILED
    # no browser, sem resposta HTTP nenhuma chegando ao cliente).
    permission = await FoldersService.check_permission(conn, user_id, check_path, body.company_id)
    if permission != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para criar pasta aqui.")

    row = await FoldersService.insert_folder(
        conn, company_id=body.company_id, parent_id=body.parent_id, path=new_path, name=body.name, created_by=user_id,
    )
    return dict(row)


# ---------------------------------------------------------------------------
# PATCH /folders/:id — rename ou move (atômico via UPDATE com subpath)
# ---------------------------------------------------------------------------

@router.patch("/{folder_id}/rename")
async def rename_folder(
    folder_id: UUID,
    body: FolderRename,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """Renomeia a pasta (só o campo name — path ltree não muda no rename)."""
    row = await FoldersService.rename_folder(conn, folder_id, body.name)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    return dict(row)


@router.patch("/{folder_id}/move")
async def move_folder(
    folder_id: UUID,
    body: FolderMove,
    conn: asyncpg.Connection = Depends(get_db),
) -> dict[str, Any]:
    """
    Move pasta para novo parent de forma atômica (R4/R8):
    - Atualiza path da pasta e de TODOS os descendentes numa transação.
    - Usa ltree subpath para reescrever prefixo sem recursão.
    """
    folder = await FoldersService.get_folder_for_move(conn, folder_id)
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")

    old_path = folder["path"]
    company_id = folder["company_id"]

    new_parent_path: str | None = None
    if body.parent_id is not None:
        parent = await FoldersService.get_target_parent(conn, body.parent_id, company_id)
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta destino não encontrada.")
        if parent["path"] == old_path or parent["path"].startswith(old_path + "."):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Não é possível mover uma pasta para dentro de si mesma.",
            )
        new_parent_path = parent["path"]

    old_nlevel = old_path.count(".") + 1

    await FoldersService.move_folder_atomic(
        conn,
        folder_id=folder_id, new_parent_path=new_parent_path,
        old_nlevel=old_nlevel, new_parent_id=body.parent_id, old_path=old_path,
    )

    row = await FoldersService.get_folder_after_move(conn, folder_id)
    return dict(row)


# ---------------------------------------------------------------------------
# DELETE /folders/:id — soft delete (e descendentes)
# ---------------------------------------------------------------------------

@router.delete("/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_folder(
    folder_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> None:
    """
    Soft delete da pasta e de todos os descendentes.

    Usa conn (authenticated) para verificar visibilidade + permissão via RLS.
    Usa admin_conn (service role) para executar o soft delete:
    PostgreSQL rejeita UPDATE que torna linhas invisíveis ao SELECT do usuário
    (o `deleted_at IS NULL` na policy folders_select é aplicado como WITH CHECK
    implícito na nova linha — comportamento documentado do RLS PG).
    """
    folder = await FoldersService.get_folder_for_delete(conn, folder_id)
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    if folder["permission"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para deletar esta pasta.")

    await FoldersService.soft_delete_folder_cascade(admin_conn, folder["path"])
    await FoldersService.log_delete_activity(conn, folder_id=folder_id, company_id=folder["company_id"], name=folder["name"])
