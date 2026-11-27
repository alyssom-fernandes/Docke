"""Respostas dos avisos (X3-16)."""
from datetime import datetime

from app.schemas.base import Resposta


class Aviso(Resposta):
    id: str
    type: str
    resource_type: str | None
    resource_id: str | None
    company_id: str | None
    message: str | None
    read_at: datetime | None
    created_at: datetime
    snoozed_until: datetime | None
    archived_at: datetime | None
    # Pasta do documento do aviso (para levar ao item); nula sem acesso.
    folder_id: str | None
    in_trash: bool


class ListaAvisos(Resposta):
    """Caixa de avisos (GET /notifications)."""

    results: list[Aviso]
    unread_count: int
