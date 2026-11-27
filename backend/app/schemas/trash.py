"""Respostas da lixeira (X3-16)."""
from datetime import datetime
from typing import Literal

from app.schemas.base import Resposta


class DocumentoNaLixeira(Resposta):
    id: str
    name: str
    folder_id: str
    company_id: str
    file_type: str
    size_bytes: int
    deleted_at: datetime
    trash_expires_at: datetime | None
    deleted_original_folder_id: str | None
    original_folder_name: str | None
    original_folder_deleted: bool
    original_path: str | None
    deleted_by_name: str | None
    # Motivo de não poder excluir de vez (bloqueio judicial, guarda) ou nulo.
    bloqueio: str | None
    item_type: Literal["document"]


class PastaNaLixeira(Resposta):
    id: str
    name: str
    company_id: str
    deleted_at: datetime
    trash_expires_at: datetime | None
    parent_id: str | None
    original_path: str | None
    deleted_by_name: str | None
    document_count: int
    item_type: Literal["folder"]


class Lixeira(Resposta):
    """Itens na lixeira da empresa (GET /trash)."""

    documents: list[DocumentoNaLixeira]
    folders: list[PastaNaLixeira]
    total: int
