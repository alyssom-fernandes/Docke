"""Respostas da trilha de atividade (X3-16)."""
from datetime import datetime
from typing import Any

from app.schemas.base import Resposta


class EventoAtividade(Resposta):
    """Evento da trilha."""

    id: str
    user_id: str | None
    company_id: str | None
    action: str
    item_type: str | None
    item_id: str | None
    item_name_snapshot: str | None
    metadata: dict[str, Any] | None
    created_at: datetime
    user_name: str | None
    user_username: str | None
    # Pasta atual do documento (para o link); nula se ele não existe mais.
    current_folder_id: str | None


class PaginaAtividade(Resposta):
    """Página da trilha (GET /activity)."""

    results: list[EventoAtividade]
    total: int
    page: int
    page_size: int
