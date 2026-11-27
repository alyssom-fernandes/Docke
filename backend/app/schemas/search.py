"""Respostas da busca (X3-16)."""
from datetime import date, datetime

from app.schemas.base import Resposta


class ResultadoBusca(Resposta):
    """Documento encontrado pela busca."""

    id: str
    name: str
    file_type: str
    size_bytes: int
    sector: str | None
    competencia: date | None
    tipo_fiscal: str | None
    ocr_status: str
    folder_id: str
    company_id: str
    created_at: datetime
    folder_name: str | None
    rank: float | None
    # Trecho do texto com <mark> nos termos (nulo quando o termo não está no texto).
    snippet: str | None
    folder_path_label: str | None
    # Só na busca exata: a pessoa ancorou ou abriu o documento.
    usado_por_mim: bool | None = None


class ValorFaceta(Resposta):
    value: str
    count: int


class Facetas(Resposta):
    sector: list[ValorFaceta]
    file_type: list[ValorFaceta]


class RespostaBusca(Resposta):
    """Página da busca (GET /search)."""

    results: list[ResultadoBusca]
    total: int
    page: int
    page_size: int
    query: str
    facets: Facetas
    # Sem termo e sem filtro a resposta vem só com os campos acima.
    aproximado: bool | None = None
    sugestao: str | None = None
    sem_texto: int | None = None


class ResultadoRapido(Resposta):
    """Resultado da busca rápida (GET /search/quick)."""

    id: str
    name: str
    type: str
    file_type: str
    folder_id: str
    folder_name: str | None
    rank: float | None
