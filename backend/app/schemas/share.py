"""Respostas das rotas de link compartilhado (X3-16)."""
from datetime import datetime

from app.schemas.base import Resposta


class LinkCompartilhado(Resposta):
    """Link na lista de compartilhados (GET /shares)."""

    id: str
    resource_type: str
    resource_id: str
    company_id: str
    expires_at: datetime | None
    revoked_at: datetime | None
    view_count: int | None
    last_accessed_at: datetime | None
    created_at: datetime
    has_password: bool
    max_views: int | None
    allow_download: bool | None
    pin_to_version_id: str | None
    resource_name: str | None
    # Pasta do documento compartilhado (para o link na tela).
    document_folder_id: str | None
    created_by: str | None
    created_by_name: str | None
    expired_at: datetime | None
