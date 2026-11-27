"""Respostas das rotas de documento (X3-16)."""
from datetime import date, datetime
from typing import Any

from app.schemas.base import Resposta


class DocumentoNaPasta(Resposta):
    """Linha da lista de documentos da pasta (GET /documents)."""

    id: str
    name: str
    folder_id: str
    company_id: str
    mime_type: str
    file_type: str
    size_bytes: int
    storage_path: str
    content_hash: str | None
    sector: str | None
    competencia: date | None
    tipo_fiscal: str | None
    ocr_status: str
    uploaded_by: str | None
    created_at: datetime
    updated_at: datetime
    is_template: bool
    uploaded_by_name: str | None
    favorited: bool
    active_share_count: int
    thumb_url: str | None = None


class DocumentoRecente(Resposta):
    """Documento recente da empresa (GET /documents/recent)."""

    id: str
    name: str
    folder_id: str
    company_id: str
    mime_type: str
    file_type: str
    size_bytes: int
    ocr_status: str
    created_at: datetime
    folder_name: str | None
    # Só com mine=true: quando a pessoa abriu ou baixou por último.
    opened_at: datetime | None = None


class Reserva(Resposta):
    """Quem reservou o documento para edição."""

    user_id: str
    full_name: str | None
    note: str | None
    created_at: datetime


class DocumentoDetalhe(Resposta):
    """Detalhe do documento (GET /documents/{id}); o texto inteiro vem por /text."""

    id: str
    name: str
    folder_id: str
    company_id: str
    mime_type: str
    file_type: str
    size_bytes: int
    content_hash: str | None
    sector: str | None
    competencia: date | None
    tipo_fiscal: str | None
    ocr_status: str
    ocr_completed_at: datetime | None
    uploaded_by: str | None
    created_at: datetime
    updated_at: datetime
    deleted_original_folder_id: str | None
    thumb_url: str | None
    uploaded_by_name: str | None
    ocr_excerpt: str
    ocr_text_length: int
    # Dados da NF-e lida no envio e outras cópias da mesma chave.
    nfe: dict[str, Any] | None
    checkout: Reserva | None
    # Evento de NF-e (cancelamento, carta de correção) quando o arquivo é um.
    nfe_evento: dict[str, Any] | None


class TextoDocumento(Resposta):
    """Texto lido do documento (GET /documents/{id}/text)."""

    text: str
    ocr_status: str
