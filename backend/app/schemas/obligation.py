"""Respostas das rotas de obrigação (X3-16)."""
from datetime import date, datetime
from typing import Any
from uuid import UUID

from app.schemas.base import Resposta


class Obrigacao(Resposta):
    """Competência de uma obrigação, com o estado calculado."""

    id: UUID
    template_id: UUID
    company_id: UUID
    period: str
    period_label: str
    due_date: date
    status: str
    dispensa_motivo: str | None
    owner_id: UUID | None
    score: int
    satisfied_at: datetime | None
    created_at: datetime
    updated_at: datetime
    notes: str | None
    reviewed_by: UUID | None
    reviewed_at: datetime | None
    review_note: str | None
    template_name: str
    criticality: str | None
    department: str | None
    weight: int | None
    frequency: str | None
    legal_basis: str | None
    requires_review: bool | None
    template_description: str | None
    company_name: str
    owner_name: str | None
    reviewer_name: str | None
    # pending, at_risk, overdue, blocked, reviewing, approved, expired,
    # not_applicable, dispensado ou cancelado.
    effective_status: str
    # Modelos de que esta depende e que ainda não foram cumpridos.
    blocking_templates: list[str] | None
    document_expires_at: date | None
    document_count: int
    days_late: int


class DocumentoDaObrigacao(Resposta):
    """Documento que comprova a competência."""

    id: UUID
    obligation_instance_id: UUID
    document_id: UUID
    linked_by: UUID | None
    linked_at: datetime
    valid_until: date | None
    document_name: str
    folder_id: str
    folder_name: str | None
    document_created_at: datetime
    linked_by_name: str | None


class HistoricoObrigacao(Resposta):
    id: str
    action: str
    metadata: dict[str, Any] | None
    created_at: datetime
    user_name: str | None


class ObrigacaoDetalhe(Obrigacao):
    """Competência com documentos e histórico (GET /obligations/instances/{id})."""

    documents: list[DocumentoDaObrigacao]
    history: list[HistoricoObrigacao]
