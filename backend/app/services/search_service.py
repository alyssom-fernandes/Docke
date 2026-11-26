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
    def digits_pattern(raw: str) -> str | None:
        """
        CNPJ, CPF, chave de acesso e números de nota com ou sem pontuação
        (achado X2/A6): "12.345.678/0001-90" e "12345678000190" acham o mesmo
        documento. Só vale para termos que são basicamente número (8+ dígitos
        e nenhuma letra); devolve uma expressão que aceita até 2 separadores
        entre os dígitos.
        """
        term = raw.strip()
        digits = re.sub(r"\D", "", term)
        if len(digits) < 8 or re.search(r"[^\d\s.\-/]", term):
            return None
        return r"\D{0,2}".join(digits)

    _WHERE = """
      d.company_id = $2
      AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
      AND (
        dtv.tsv @@ sq.tsq
        OR d.name ILIKE '%' || $3 || '%'
        OR d.ocr_text ILIKE '%' || $3 || '%'
        OR ft.txt ILIKE '%' || $3 || '%'
        OR ($4::text IS NOT NULL AND (d.name ~ $4 OR d.ocr_text ~ $4 OR ft.txt ~ $4))
      )
      AND ($5::ltree IS NULL OR f.path <@ $5::ltree)
      AND ($6::date IS NULL OR d.created_at >= $6::date)
      AND ($7::date IS NULL OR d.created_at < ($7::date + 1))
      AND ($8::uuid IS NULL OR d.folder_id = $8)
    """

    _FROM = """
      FROM public.documents d
      JOIN public.folders f ON f.id = d.folder_id
      LEFT JOIN (
        SELECT dfv.document_id,
               string_agg(coalesce(dfv.value_text, dfv.value_number::text, dfv.value_date::text), ' ') AS txt
        FROM public.document_field_value dfv
        GROUP BY dfv.document_id
      ) ft ON ft.document_id = d.id
      CROSS JOIN (SELECT websearch_to_tsquery('portuguese', unaccent($1)) AS tsq) sq
      CROSS JOIN LATERAL (
        -- nome (A), setor/fiscal (C) e texto lido (D) já vêm calculados na
        -- coluna gerada com índice (X3-05); só o metadado (B) é somado aqui.
        SELECT d.search_tsv ||
          setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(ft.txt, ''))), 'B') AS tsv
      ) dtv
    """

    _ORDER = {
        "relevancia": "rank DESC, d.created_at DESC",
        "recentes": "d.created_at DESC",
        "antigos": "d.created_at ASC",
        "nome": "lower(d.name) ASC",
    }

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
        date_from=None,
        date_to=None,
        sort: str = "relevancia",
        folder_path: str | None = None,
        exact_folder_id: UUID | None = None,
    ) -> dict[str, Any]:
        """
        Busca com filtros de pasta (com subpastas), período e tipo, ordenação
        e paginação (A6-03, A6-04). O termo cru alimenta o ILIKE (códigos com
        pontuação) e os números entram também sem pontuação.
        """
        offset = (page - 1) * page_size
        raw_term = q.strip()
        digits = SearchService.digits_pattern(raw_term)
        order = SearchService._ORDER.get(sort, SearchService._ORDER["relevancia"])
        rows = await conn.fetch(
            f"""
            SELECT
              d.id::text, d.name, d.file_type, d.size_bytes, d.sector, d.competencia, d.tipo_fiscal,
              d.ocr_status, d.folder_id::text, d.company_id::text, d.created_at, f.name AS folder_name,
              ts_rank_cd(dtv.tsv, sq.tsq, 4) AS rank,
              CASE
                WHEN d.ocr_text IS NOT NULL
                 AND (to_tsvector('portuguese', public.immutable_unaccent(d.ocr_text)) @@ sq.tsq
                      OR d.ocr_text ILIKE '%' || $3 || '%')
                THEN ts_headline('portuguese', left(d.ocr_text, 8000), sq.tsq,
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=10, ShortWord=3, HighlightAll=false, MaxFragments=3, FragmentDelimiter=<hr/>')
                ELSE NULL
              END AS snippet,
              (SELECT string_agg(anc.name, ' / ' ORDER BY nlevel(anc.path))
                 FROM public.folders anc WHERE anc.company_id = d.company_id AND anc.path @> f.path) AS folder_path_label,
              count(*) OVER () AS total_count
            {SearchService._FROM}
            WHERE {SearchService._WHERE}
              AND ($9::text IS NULL OR d.sector = $9)
              AND ($10::text IS NULL OR d.file_type = $10)
            ORDER BY {order}
            LIMIT $11 OFFSET $12
            """,
            normalized, company_id, raw_term, digits, folder_path, date_from, date_to, exact_folder_id,
            sector, file_type, page_size, offset,
        )
        total = rows[0]["total_count"] if rows else 0

        # Facetas: contagem por setor/tipo entre os que batem, ignorando o
        # filtro da própria dimensão.
        facet_rows = await conn.fetch(
            f"""
            WITH matched AS (
              SELECT d.sector, d.file_type
              {SearchService._FROM}
              WHERE {SearchService._WHERE}
            )
            SELECT 'sector' AS dimension, sector AS value, count(*) AS count
            FROM matched WHERE sector IS NOT NULL GROUP BY sector
            UNION ALL
            SELECT 'file_type' AS dimension, file_type AS value, count(*) AS count
            FROM matched WHERE file_type IS NOT NULL GROUP BY file_type
            """,
            normalized, company_id, raw_term, digits, folder_path, date_from, date_to, exact_folder_id,
        )
        facets: dict[str, list[dict[str, Any]]] = {"sector": [], "file_type": []}
        for r in facet_rows:
            facets[r["dimension"]].append({"value": r["value"], "count": r["count"]})
        for dim in facets:
            facets[dim].sort(key=lambda x: x["count"], reverse=True)

        # Quantos documentos ainda não entram na busca pelo conteúdo (A6-06).
        sem_texto = await conn.fetchval(
            """
            SELECT count(*) FROM public.documents d
            WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
              AND d.ocr_status IN ('pending', 'processing', 'failed')
            """,
            company_id,
        )

        return {
            "results": [{k: v for k, v in dict(r).items() if k != "total_count"} for r in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
            "query": q,
            "facets": facets,
            "sem_texto": int(sem_texto or 0),
        }

    @staticmethod
    async def quick_search(
        conn: asyncpg.Connection,
        *,
        q: str,
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
            WITH field_text AS (
              SELECT dfv.document_id,
                     string_agg(coalesce(dfv.value_text, dfv.value_number::text, dfv.value_date::text), ' ') AS txt
              FROM public.document_field_value dfv
              GROUP BY dfv.document_id
            )
            SELECT
              d.id::text,
              d.name,
              'document' AS type,
              d.file_type,
              d.folder_id::text,
              f.name AS folder_name,
              ts_rank_cd(dtv.tsv, to_tsquery('portuguese', unaccent($1))) AS rank
            FROM public.documents d
            JOIN public.folders f ON f.id = d.folder_id
            LEFT JOIN field_text ft ON ft.document_id = d.id
            CROSS JOIN LATERAL (
              -- Fase 7.1: mesmo setweight do /search — nome (A) > metadado
              -- customizado (B) > setor/fiscal (C) > OCR (D).
              SELECT
                setweight(to_tsvector('portuguese', public.immutable_unaccent(d.name)), 'A') ||
                setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(ft.txt, ''))), 'B') ||
                setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(d.sector, '') || ' ' || coalesce(d.tipo_fiscal, ''))), 'C') ||
                setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(d.ocr_text, ''))), 'D') AS tsv
            ) dtv
            WHERE d.company_id = $2
              AND d.deleted_at IS NULL
              AND (
                dtv.tsv @@ to_tsquery('portuguese', unaccent($1))
                -- Fase 6.1/7.1: mesmo fallback pg_trgm do /search, com o termo
                -- CRU (não normalizado) — o command palette não pode perder
                -- um código pontuado que o FTS tokeniza mal.
                OR d.name ILIKE '%' || $4 || '%'
                OR d.ocr_text ILIKE '%' || $4 || '%'
                OR ft.txt ILIKE '%' || $4 || '%'
              )
            ORDER BY rank DESC, d.name
            LIMIT $3
            """,
            prefix_query, company_id, _QUICK_LIMIT, q.strip(),
        )
        return [dict(r) for r in rows]
