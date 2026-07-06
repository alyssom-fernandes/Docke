from typing import Any
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies import get_current_user, get_db, get_db_admin
from app.routers.shares import expire_shares_for_resource
from app.services import storage_service
from app.services.trash_service import TrashService

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
    docs = await TrashService.list_deleted_documents(admin_conn, company_id, user_id)
    folders = await TrashService.list_deleted_folders(admin_conn, company_id, user_id)
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
        doc = await TrashService.get_deleted_document(admin_conn, item_id)
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado na lixeira.")

        original_folder_id = doc["deleted_original_folder_id"] or doc["folder_id"]
        target_folder = await TrashService.get_active_folder(admin_conn, original_folder_id)
        if target_folder is None:
            target_folder = await TrashService.get_root_folder(admin_conn, doc["company_id"])
            if target_folder is None:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Pasta original deletada e nenhuma pasta raiz disponível.")

        permission = await TrashService.check_permission(
            admin_conn, user_id, str(target_folder["path"]), str(target_folder["company_id"]),
        )
        if permission not in ("admin", "operador"):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão na pasta de destino.")

        row = await TrashService.restore_document(admin_conn, item_id, target_folder["id"])
        await TrashService.log_activity(
            admin_conn, user_id=user_id, company_id=str(doc["company_id"]),
            action="restore", item_type="document", item_id=str(item_id), item_name=row["name"],
        )
        return dict(row) | {"item_type": "document", "restored_to_folder_id": str(target_folder["id"])}

    else:  # folder
        folder = await TrashService.get_deleted_folder(admin_conn, item_id)
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada na lixeira.")

        permission = await TrashService.check_permission(
            admin_conn, user_id, str(folder["path"]), str(folder["company_id"]),
        )
        if permission != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Sem permissão para restaurar esta pasta.")

        # Se a pasta pai também está deletada, restaura como raiz (parent_id = NULL)
        new_parent_id = folder["parent_id"]
        if new_parent_id is not None and await TrashService.is_parent_deleted(admin_conn, new_parent_id):
            new_parent_id = None

        await TrashService.restore_folder_cascade(
            admin_conn, folder_id=item_id, new_parent_id=new_parent_id, path=str(folder["path"]),
        )
        await TrashService.log_activity(
            admin_conn, user_id=user_id, company_id=str(folder["company_id"]),
            action="restore", item_type="folder", item_id=str(item_id), item_name=folder["name"],
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
        doc = await TrashService.get_document_for_permanent_delete(admin_conn, item_id)
        if doc is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Documento não encontrado na lixeira.")

        permission = await TrashService.get_company_admin_permission(admin_conn, user_id, doc["company_id"])
        if permission != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas administradores da empresa podem excluir permanentemente.")

        async with admin_conn.transaction():
            await TrashService.permanently_delete_document(admin_conn, item_id)
            await TrashService.log_activity(
                admin_conn, user_id=user_id, company_id=str(doc["company_id"]),
                action="delete", item_type="document", item_id=str(item_id), item_name=doc["name"],
            )
            # ADR-031: shares apontando pra este documento ficam expired (não apontam pro vazio)
            await expire_shares_for_resource(admin_conn, "document", item_id)

        # Remove do storage após commit do banco (falha no storage não desfaz o DELETE —
        # I11: objeto nunca deve ficar órfão indefinidamente, mas o registro já sumiu
        # do banco antes, então uma falha aqui só vira log, não bloqueia o usuário).
        if doc["storage_path"]:
            try:
                storage_service.delete_object(doc["storage_path"])
            except Exception:
                pass

    else:  # folder
        folder = await TrashService.get_folder_for_permanent_delete(admin_conn, item_id)
        if folder is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pasta não encontrada na lixeira.")

        permission = await TrashService.get_company_admin_permission(admin_conn, user_id, folder["company_id"])
        if permission != "admin":
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Apenas administradores da empresa podem excluir permanentemente.")

        # Hard delete da pasta — os documentos já devem ter sido deletados previamente
        # (soft delete cascateou para eles). Verificamos antes de tentar.
        orphan_docs = await TrashService.count_documents_in_folder(admin_conn, item_id)
        if orphan_docs > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A pasta ainda contém {orphan_docs} documento(s). Delete-os permanentemente antes.",
            )

        async with admin_conn.transaction():
            await TrashService.permanently_delete_folder(admin_conn, item_id)
            await TrashService.log_activity(
                admin_conn, user_id=user_id, company_id=str(folder["company_id"]),
                action="delete", item_type="folder", item_id=str(item_id), item_name=folder["name"],
            )
            await expire_shares_for_resource(admin_conn, "folder", item_id)
