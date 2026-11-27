"""Respostas das rotas de pasta (X3-16)."""
from datetime import datetime

from app.schemas.base import Resposta


class Pasta(Resposta):
    """Pasta da empresa (GET /folders)."""

    id: str
    name: str
    path: str
    parent_id: str | None
    company_id: str
    created_by: str | None
    created_at: datetime
    # Nível de acesso de quem pediu (admin, operador, visualizador) ou nulo.
    my_permission: str | None
    child_count: int
    document_count: int


class PastaFrequente(Resposta):
    """Pasta com mais atividade recente da pessoa (GET /folders/frequent)."""

    id: str
    name: str
    path: str
    parent_id: str | None
    company_id: str
    activity_count: int
    last_activity: datetime | None


class ResumoPasta(Resposta):
    """O que há abaixo da pasta (GET /folders/{id}/summary)."""

    name: str
    subfolders: int
    documents: int
