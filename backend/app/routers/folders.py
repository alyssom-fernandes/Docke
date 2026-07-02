from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.dependencies import get_current_user, get_db, get_db_admin

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
    conn: asyncpg.Connection = Depends(get_db),
) -> list[dict[str, Any]]:
    """
    Lista pastas da empresa visíveis ao usuário (RLS filtra automaticamente).
    parent_id=null → pastas raiz; parent_id=<uuid> → filhos diretos.
    """
    rows = await conn.fetch(
        """
        SELECT
          f.id::text,
          f.name,
          f.path::text,
          f.parent_id::text,
          f.company_id::text,
          f.created_by::text,
          f.created_at,
          public.user_has_access(auth.uid(), f.path, f.company_id) AS my_permission,
          (SELECT count(*) FROM public.folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL) AS child_count,
          (SELECT count(*) FROM public.documents d WHERE d.folder_id = f.id AND d.deleted_at IS NULL) AS document_count
        FROM public.folders f
        WHERE f.company_id = $1
          AND f.deleted_at IS NULL
          AND ($2::uuid IS NULL AND f.parent_id IS NULL
               OR f.parent_id = $2)
        ORDER BY f.name
        """,
        company_id,
        parent_id,
    )
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
    rows = await conn.fetch(
        """
        SELECT
          f.id::text,
          f.name,
          f.path::text,
          f.parent_id::text,
          f.company_id::text,
          COUNT(al.id) AS activity_count,
          MAX(al.created_at) AS last_activity
        FROM public.folders f
        JOIN public.documents d ON d.folder_id = f.id AND d.deleted_at IS NULL
        JOIN public.activity_log al
          ON al.item_id = d.id
          AND al.item_type = 'document'
          AND al.user_id = $1::uuid
          AND al.created_at >= now() - interval '30 days'
          AND al.action IN ('upload', 'view', 'download')
        WHERE f.company_id = $2
          AND f.deleted_at IS NULL
        GROUP BY f.id, f.name, f.path, f.parent_id, f.company_id
        ORDER BY activity_count DESC, last_activity DESC
        LIMIT $3
        """,
        user_id,
        company_id,
        limit,
    )
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
        parent = await conn.fetchrow(
            "SELECT path::text, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            body.parent_id,
        )
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta pai não encontrada.")
        if str(parent["company_id"]) != str(body.company_id):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Pasta pai pertence a outra empresa.")
        check_path = parent["path"]
        # Gera label ltree único: sequência numérica curta (evita caracteres inválidos)
        new_label = await conn.fetchval(
            "SELECT 'f' || floor(extract(epoch FROM now()) * 1000)::text || lpad((random()*9999)::int::text, 4, '0')"
        )
        new_path = f"{parent['path']}.{new_label}"
    else:
        check_path = None
        # Raiz da empresa — gera path único sem pontos
        new_label = await conn.fetchval(
            "SELECT 'f' || floor(extract(epoch FROM now()) * 1000)::text || lpad((random()*9999)::int::text, 4, '0')"
        )
        new_path = new_label

    # Checagem explícita ANTES do INSERT: sem isso, quem não tem permissão de
    # escrita esbarra só na RLS, que rejeita a linha com uma exceção crua do
    # Postgres — isso não vira um 403 limpo, derruba a conexão (net::ERR_FAILED
    # no browser, sem resposta HTTP nenhuma chegando ao cliente).
    permission = await conn.fetchval(
        "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
        user_id, check_path, body.company_id,
    )
    if permission != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para criar pasta aqui.")

    row = await conn.fetchrow(
        """
        INSERT INTO public.folders (company_id, parent_id, path, name, created_by)
        VALUES ($1, $2, $3::ltree, $4, $5)
        RETURNING id::text, name, path::text, parent_id::text, company_id::text, created_at
        """,
        body.company_id,
        body.parent_id,
        new_path,
        body.name,
        user_id,
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
    row = await conn.fetchrow(
        """
        UPDATE public.folders
        SET name = $2
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id::text, name, path::text, parent_id::text, company_id::text, created_at
        """,
        folder_id,
        body.name,
    )
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
    folder = await conn.fetchrow(
        "SELECT path::text, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
        folder_id,
    )
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")

    old_path = folder["path"]
    company_id = folder["company_id"]

    new_parent_path: str | None = None
    if body.parent_id is not None:
        parent = await conn.fetchrow(
            "SELECT path::text FROM public.folders WHERE id = $1 AND deleted_at IS NULL AND company_id = $2",
            body.parent_id,
            company_id,
        )
        if parent is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta destino não encontrada.")
        if parent["path"] == old_path or parent["path"].startswith(old_path + "."):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Não é possível mover uma pasta para dentro de si mesma.",
            )
        new_parent_path = parent["path"]

    old_nlevel = old_path.count(".") + 1

    # Atualiza pasta + todos os descendentes atomicamente.
    # subpath(path, old_nlevel - 1) = sufixo a partir do label da própria pasta movida.
    # CASE: raiz → só sufixo; senão → parent_path || sufixo.
    await conn.execute(
        """
        UPDATE public.folders
        SET path = CASE
                WHEN $2::text IS NULL THEN subpath(path, $3)
                ELSE ($2::ltree || subpath(path, $3))
            END,
            parent_id = CASE WHEN id = $1 THEN $4 ELSE parent_id END
        WHERE (id = $1 OR path <@ $5::ltree)
          AND deleted_at IS NULL
        """,
        folder_id,
        new_parent_path,   # None para mover para raiz
        old_nlevel - 1,    # pular os ancestrais, preservar label da pasta + filhos
        body.parent_id,
        old_path,
    )

    row = await conn.fetchrow(
        "SELECT id::text, name, path::text, parent_id::text, company_id::text FROM public.folders WHERE id = $1",
        folder_id,
    )
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
    # Valida que o usuário pode ver e tem permissão de editor+ na pasta
    folder = await conn.fetchrow(
        """
        SELECT f.path::text, f.company_id::text,
               public.user_has_access(auth.uid(), f.path, f.company_id) AS permission
        FROM public.folders f
        WHERE f.id = $1 AND f.deleted_at IS NULL
        """,
        folder_id,
    )
    if folder is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada.")
    if folder["permission"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para deletar esta pasta.")

    # Soft delete via service role (bypassa RLS para evitar o bloqueio implícito)
    await admin_conn.execute(
        """
        UPDATE public.folders
        SET deleted_at = now()
        WHERE path <@ $1::ltree AND deleted_at IS NULL
        """,
        folder["path"],
    )
    await admin_conn.execute(
        """
        UPDATE public.documents d
        SET deleted_at = now(),
            deleted_original_folder_id = d.folder_id
        FROM public.folders f
        WHERE d.folder_id = f.id
          AND f.path <@ $1::ltree
          AND d.deleted_at IS NULL
        """,
        folder["path"],
    )
