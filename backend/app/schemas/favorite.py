"""Respostas dos ancorados (X3-16)."""
from datetime import datetime
from typing import Literal

from app.schemas.base import Resposta


class Ancorado(Resposta):
    """Documento ou pasta ancorada pela pessoa (GET /favorites)."""

    id: str
    user_id: str
    document_id: str | None
    folder_id: str | None
    created_at: datetime
    item_type: Literal["document", "folder"]
    # O item sempre existe: ancorado de item excluído não entra na lista.
    item_name: str
    # Pasta do documento ancorado (nula quando o ancorado é a própria pasta).
    document_folder_id: str | None
    # Caminho de pastas até o item.
    location: str | None
