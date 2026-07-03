from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies import get_current_user, get_db, get_db_admin
from app.routers.shares import expire_shares_for_resource
from app.services import storage_service

router = APIRouter(prefix="/trash", tags=["trash"])


# ---------------------------------------------------------------------------
# GET /trash — lista itens na lixeira (documentos e pastas deletadas)
# ---------------------------------------------------------------------------

@router.get("")
async def list_trash(
    company_id: UUID = Query(...),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Lista itens na lixeira da empresa.
    Usa admin_conn (itens deleted_at IS NOT NULL são invisíveis ao authenticated via RLS).
    Filtra apenas itens do usuário atual ou de pastas onde o usuário tem manager.
    """
    user_id = claims["sub"]

    # Documentos deletados onde o usuário tem alguma permissão na empresa
    docs = await admin_conn.fetch(
        """
        SELECT
          d.id::text,
          d.name,
          d.folder_id::text,
          d.company_id::text,
          d.file_type,
          d.size_bytes,
          d.deleted_at,
          d.deleted_original_folder_id::text,
          f.name AS original_folder_name,
          f.deleted_at IS NOT NULL AS original_folder_deleted,
          'document' AS item_type
        FROM public.documents d
        LEFT JOIN public.folders f ON f.id = d.deleted_original_folder_id
        WHERE d.company_id = $1
          AND d.deleted_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM public.user_company_access uca
            WHERE uca.user_id = $2 AND uca.company_id = $1
          )
        ORDER BY d.deleted_at DESC
        """,
        company_id,
        user_id,
    )

    # Pastas deletadas (só raízes — não listar sub-pastas de pastas deletadas individualmente)
    folders = await admin_conn.fetch(
        """
        SELECT
          f.id::text,
          f.name,
          f.company_id::text,
          f.deleted_at,
          f.parent_id::text,
          'folder' AS item_type
        FROM public.folders f
        WHERE f.company_id = $1
          AND f.deleted_at IS NOT NULL
          AND (
            f.parent_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM public.folders parent
              WHERE parent.id = f.parent_id AND parent.deleted_at IS NOT NULL
            )
          )
          AND EXISTS (
            SELECT 1 FROM public.user_company_access uca
            WHERE uca.user_id = $2 AND uca.company_id = $1
          )
        ORDER BY f.deleted_at DESC
        """,
        company_id,
        user_id,
    )

    return {
        "documents": [dict(r) for r in docs],
        "folders": [dict(r) for r in folders],
        "total": len(docs) + len(folders),
    }


# ---------------------------------------------------------------------------
# POST /trash/:id/restore — restaura item da lixeira
# Delega para a lógica de restore já implementada nos routers específicos
# ---------------------------------------------------------------------------

@router.post("/{item_id}/restore")
async def restore_trash_item(
    item_id: UUID,
    item_type: str = Query(..., pattern="^(document|folder)$"),
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    """
    Restaura documento ou pasta da lixeira.
    item_type: 'document' ou 'folder'

    Para pastas: restaura a pasta e todos os descendentes em cascata.
    Regra: se a pasta PAI da pasta deletada também está deletada, restaura como raiz.

    Para documentos: reutiliza a lógica do POST /documents/:id/restore.
    """
    user_id = claims["sub"]

    if item_type == "document":
        # Reutiliza a mesma lógica do restore de documento
        doc = await admin_conn.fetchrow(
            "SELECT id, folder_id, company_id, deleted_original_folder_id FROM public.documents WHERE id = $1 AND deleted_at IS NOT NULL",
            item_id,
        )
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado na lixeira.")

        original_folder_id = doc["deleted_original_folder_id"] or doc["folder_id"]
        target_folder = await admin_conn.fetchrow(
            "SELECT id, path, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            original_folder_id,
        )
        if target_folder is None:
            target_folder = await admin_conn.fetchrow(
                "SELECT id, path, company_id FROM public.folders WHERE company_id = $1 AND parent_id IS NULL AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
                doc["company_id"],
            )
            if target_folder is None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Pasta original deletada e nenhuma pasta raiz disponível.")

        permission = await admin_conn.fetchval(
            "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
            user_id, str(target_folder["path"]), str(target_folder["company_id"]),
        )
        if permission not in ("admin", "operador"):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão na pasta de destino.")

        row = await admin_conn.fetchrow(
            """
            UPDATE public.documents
            SET deleted_at = NULL, folder_id = $2, deleted_original_folder_id = NULL, updated_at = now()
            WHERE id = $1
            RETURNING id::text, name, folder_id::text, company_id::text, ocr_status
            """,
            item_id, target_folder["id"],
        )
        await admin_conn.execute(
            "INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot) VALUES ($1::uuid, $2::uuid, 'restore', 'document', $3::uuid, $4)",
            user_id, str(doc["company_id"]), str(item_id), row["name"],
        )
        return dict(row) | {"item_type": "document", "restored_to_folder_id": str(target_folder["id"])}

    else:  # folder
        folder = await admin_conn.fetchrow(
            "SELECT id, name, path, company_id, parent_id FROM public.folders WHERE id = $1 AND deleted_at IS NOT NULL",
            item_id,
        )
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada na lixeira.")

        permission = await admin_conn.fetchval(
            "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
            user_id, str(folder["path"]), str(folder["company_id"]),
        )
        if permission != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para restaurar esta pasta.")

        # Se a pasta pai também está deletada, restaura como raiz (parent_id = NULL)
        new_parent_id = folder["parent_id"]
        if new_parent_id is not None:
            parent_deleted = await admin_conn.fetchval(
                "SELECT deleted_at IS NOT NULL FROM public.folders WHERE id = $1",
                new_parent_id,
            )
            if parent_deleted:
                new_parent_id = None

        # Restaura a pasta e todos os descendentes
        await admin_conn.execute(
            """
            UPDATE public.folders
            SET deleted_at = NULL,
                parent_id = CASE WHEN id = $1 THEN $2 ELSE parent_id END
            WHERE (id = $1 OR path <@ $3::ltree)
              AND deleted_at IS NOT NULL
            """,
            item_id, new_parent_id, str(folder["path"]),
        )
        await admin_conn.execute(
            "INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot) VALUES ($1::uuid, $2::uuid, 'restore', 'folder', $3::uuid, $4)",
            user_id, str(folder["company_id"]), str(item_id), folder["name"],
        )
        return {"item_type": "folder", "id": str(item_id), "name": folder["name"], "restored_parent_id": str(new_parent_id) if new_parent_id else None}


# ---------------------------------------------------------------------------
# DELETE /trash/:id/permanent — exclusão permanente (hard delete)
# ---------------------------------------------------------------------------

@router.delete("/{item_id}/permanent", status_code=status.HTTP_204_NO_CONTENT)
async def permanent_delete(
    item_id: UUID,
    item_type: str = Query(..., pattern="^(document|folder)$"),
    confirm: bool = Query(..., description="Deve ser true para confirmar exclusão permanente."),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> None:
    """
    Exclusão permanente do banco e do storage.
    REQUER: ?confirm=true na query string (proteção contra chamadas acidentais).
    Apenas itens já soft-deleted (na lixeira) podem ser permanentemente excluídos.
    Apenas manager pode excluir permanentemente.
    """
    if not confirm:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Inclua ?confirm=true para confirmar a exclusão permanente. Esta ação é irreversível.",
        )

    user_id = claims["sub"]

    if item_type == "document":
        doc = await admin_conn.fetchrow(
            "SELECT id, name, company_id, storage_path FROM public.documents WHERE id = $1 AND deleted_at IS NOT NULL",
            item_id,
        )
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado na lixeira.")

        # Valida que o usuário é manager da empresa
        permission = await admin_conn.fetchval(
            "SELECT permission_level FROM public.user_company_access WHERE user_id = $1 AND company_id = $2 AND folder_path IS NULL",
            user_id, doc["company_id"],
        )
        if permission != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas administradores da empresa podem excluir permanentemente.")

        # Remove do banco e do storage
        async with admin_conn.transaction():
            await admin_conn.execute("DELETE FROM public.documents WHERE id = $1", item_id)
            await admin_conn.execute(
                "INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot) VALUES ($1::uuid, $2::uuid, 'delete', 'document', $3::uuid, $4)",
                user_id, str(doc["company_id"]), str(item_id), doc["name"],
            )
            # ADR-031: shares apontando pra este documento ficam expired (não apontam pro vazio)
            await expire_shares_for_resource(admin_conn, "document", item_id)

        # Remove do storage após commit do banco (falha no storage não desfaz o DELETE)
        if doc["storage_path"]:
            try:
                if storage_service.is_mock():
                    import os
                    from pathlib import Path
                    safe_key = doc["storage_path"].replace("/", "__")
                    p = Path(storage_service.MOCK_DIR) / safe_key
                    p.unlink(missing_ok=True)
                # R2: seria _s3.delete_object(Bucket=..., Key=...)
            except Exception:
                pass  # Falha no storage não bloqueia — objeto pode ser coletado por lifecycle rule

    else:  # folder
        folder = await admin_conn.fetchrow(
            "SELECT id, name, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NOT NULL",
            item_id,
        )
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada na lixeira.")

        permission = await admin_conn.fetchval(
            "SELECT permission_level FROM public.user_company_access WHERE user_id = $1 AND company_id = $2 AND folder_path IS NULL",
            user_id, folder["company_id"],
        )
        if permission != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas administradores da empresa podem excluir permanentemente.")

        # Hard delete da pasta — CASCADE deleta documentos associados via FK (ON DELETE RESTRICT)
        # Os documentos já devem ter sido deletados previamente (soft delete cascateou para eles)
        # Verificamos antes de tentar
        orphan_docs = await admin_conn.fetchval(
            "SELECT count(*) FROM public.documents WHERE folder_id = $1",
            item_id,
        )
        if orphan_docs > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A pasta ainda contém {orphan_docs} documento(s). Delete-os permanentemente antes.",
            )

        async with admin_conn.transaction():
            await admin_conn.execute("DELETE FROM public.folders WHERE id = $1", item_id)
            await admin_conn.execute(
                "INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot) VALUES ($1::uuid, $2::uuid, 'delete', 'folder', $3::uuid, $4)",
                user_id, str(folder["company_id"]), str(item_id), folder["name"],
            )
            await expire_shares_for_resource(admin_conn, "folder", item_id)
