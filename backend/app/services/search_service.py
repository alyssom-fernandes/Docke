"""Full-text search com FTS 'portuguese' + ts_headline — implementado em M3.1."""
import re
from typing import Any
from uuid import UUID

import asyncpg

_QUICK_LIMIT = 10


class SearchService:
    """Responsável por busca FTS.

    NUNCA lida com OCR ou storage — apenas com queries no banco.
    """

    @staticmethod
    def normalize_query(raw: str) -> str:
        """
        Normaliza a query do usuário para tsquery português.

        - Preserva hífens em siglas: "NF-e" → "NF-e" (websearch_to_tsquery lida)
        - Remove caracteres especiais perigosos para tsquery
        - Trim + lowercase (unaccent é aplicado no índice e na query)
        - Palavras vazias após normalização: retorna string vazia

        Usa websearch_to_tsquery que interpreta aspas como frase, - como NOT,
        OR como disjunção — mais seguro e amigável que to_tsquery manual.
        """
        cleaned = re.sub(r"[^\w\s\-\"']", " ", raw, flags=re.UNICODE)
        return " ".join(cleaned.split())  # colapsa espaços múltiplos

    @staticmethod
    async def search(
        conn: asyncpg.Connection,
        *,
        q: str,
        normalized: str,
        company_id: UUID,
        folder_id: UUID | None,
        sector: str | None,
        file_type: str | None,
        page: int,
        page_size: int,
    ) -> dict[str, Any]:
        offset = (page - 1) * page_size
        rows = await conn.fetch(
            """
            WITH search_query AS (
              SELECT websearch_to_tsquery('portuguese',
                       unaccent($1)
                     ) AS tsq
            )
            SELECT
              d.id::text,
              d.name,
              d.file_type,
              d.size_bytes,
              d.sector,
              d.competencia,
              d.tipo_fiscal,
              d.ocr_status,
              d.folder_id::text,
              d.company_id::text,
              d.created_at,
              f.name AS folder_name,
              ts_rank_cd(to_tsvector('portuguese', public.immutable_unaccent(d.name || ' ' || coalesce(d.ocr_text, ''))), sq.tsq, 4) AS rank,
              ts_headline(
                'portuguese',
                -- ADR-035 (Adendo 07): trunca o texto antes do ts_headline — gerar o
                -- snippet a partir do documento inteiro degrada performance em OCRs
                -- longos sem ganho de qualidade (o termo buscado quase sempre aparece
                -- bem antes dos primeiros 8000 caracteres).
                left(coalesce(d.ocr_text, d.name), 8000),
                sq.tsq,
                'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=10, ShortWord=3, HighlightAll=false, MaxFragments=2'
              ) AS snippet,
              count(*) OVER () AS total_count
            FROM public.documents d
            JOIN public.folders   f ON f.id = d.folder_id
            CROSS JOIN search_query sq
            WHERE d.company_id = $2
              AND d.deleted_at IS NULL
              AND (
                to_tsvector('portuguese', public.immutable_unaccent(d.name || ' ' || coalesce(d.ocr_text, ''))) @@ sq.tsq
                OR d.name ILIKE '%' || $1 || '%'
              )
              AND ($3::uuid IS NULL OR d.folder_id = $3)
              AND ($4::text  IS NULL OR d.sector    = $4)
              AND ($5::text  IS NULL OR d.file_type = $5)
            ORDER BY rank DESC, d.created_at DESC
            LIMIT $6 OFFSET $7
            """,
            normalized, company_id, folder_id, sector, file_type, page_size, offset,
        )

        total = rows[0]["total_count"] if rows else 0
        return {
            "results": [{k: v for k, v in dict(r).items() if k != "total_count"} for r in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
            "query": q,
        }

    @staticmethod
    async def quick_search(
        conn: asyncpg.Connection,
        *,
        normalized: str,
        company_id: UUID,
    ) -> list[dict[str, Any]]:
        # Monta tsquery com prefix matching na última palavra:
        # "nota fiscal" → "nota & fiscal:*"
        words = normalized.split()
        if len(words) == 1:
            prefix_query = f"{words[0]}:*"
        else:
            prefix_query = " & ".join(words[:-1]) + f" & {words[-1]}:*"

        rows = await conn.fetch(
            """
            SELECT
              d.id::text,
              d.name,
              d.file_type,
              d.folder_id::text,
              f.name AS folder_name,
              ts_rank_cd(to_tsvector('portuguese', public.immutable_unaccent(d.name || ' ' || coalesce(d.ocr_text, ''))), to_tsquery('portuguese', unaccent($1))) AS rank
            FROM public.documents d
            JOIN public.folders f ON f.id = d.folder_id
            WHERE d.company_id = $2
              AND d.deleted_at IS NULL
              AND to_tsvector('portuguese', public.immutable_unaccent(d.name || ' ' || coalesce(d.ocr_text, ''))) @@ to_tsquery('portuguese', unaccent($1))
            ORDER BY rank DESC, d.name
            LIMIT $3
            """,
            prefix_query, company_id, _QUICK_LIMIT,
        )
        return [dict(r) for r in rows]
