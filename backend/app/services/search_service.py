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
        # Fase 7.1 fix: o fallback ILIKE precisa do termo CRU (com pontuação),
        # não do normalizado — normalize_query() troca "." e outros símbolos
        # por espaço pra alimentar o tsquery, o que faz "529.982.247-25" virar
        # "529 982 247-25" e nunca bater com o valor armazenado (que tem
        # pontos). Um CPF/CNPJ/código é exatamente o caso que o trigram deveria
        # salvar — usar o normalizado aqui destruía o próprio propósito do fix
        # 6.1. ft.txt também nunca era checado pelo ILIKE: um código só
        # guardado em metadado customizado (não no nome nem no OCR) ficava
        # invisível pra busca inteira, não só pro fallback.
        raw_term = q.strip()
        rows = await conn.fetch(
            """
            WITH search_query AS (
              SELECT websearch_to_tsquery('portuguese',
                       unaccent($1)
                     ) AS tsq
            ),
            field_text AS (
              -- Fase 7.1: valores de metadado customizado (onde ficam CPF/CNPJ/
              -- número de nota) viram peso B, entre o nome e os campos estruturados.
              SELECT dfv.document_id,
                     string_agg(coalesce(dfv.value_text, dfv.value_number::text, dfv.value_date::text), ' ') AS txt
              FROM public.document_field_value dfv
              GROUP BY dfv.document_id
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
              ts_rank_cd(dtv.tsv, sq.tsq, 4) AS rank,
              -- ADR-035: snippet só aparece quando o match vem do conteúdo OCR, não
              -- do nome do arquivo (evita ruído sem propósito quando o nome já basta).
              CASE
                WHEN d.ocr_text IS NOT NULL
                 AND (
                   to_tsvector('portuguese', public.immutable_unaccent(d.ocr_text)) @@ sq.tsq
                   OR d.ocr_text ILIKE '%' || $8 || '%'
                 )
                THEN ts_headline(
                  'portuguese',
                  -- ADR-035 (Adendo 07): trunca o texto antes do ts_headline — gerar o
                  -- snippet a partir do documento inteiro degrada performance em OCRs
                  -- longos sem ganho de qualidade (o termo buscado quase sempre aparece
                  -- bem antes dos primeiros 8000 caracteres).
                  left(d.ocr_text, 8000),
                  sq.tsq,
                  -- Fase 7.3: HighlightAll=false faz o ts_headline escolher os
                  -- trechos com maior densidade de termos batidos (não o
                  -- primeiro que aparece); MaxFragments=3 mostra mais de um
                  -- trecho quando o documento tem matches espalhados, e o
                  -- FragmentDelimiter marca a quebra pro frontend renderizar
                  -- cada trecho em linha própria.
                  'StartSel=<mark>, StopSel=</mark>, MaxWords=40, MinWords=10, ShortWord=3, HighlightAll=false, MaxFragments=3, FragmentDelimiter=<hr/>'
                )
                ELSE NULL
              END AS snippet,
              count(*) OVER () AS total_count
            FROM public.documents d
            JOIN public.folders   f ON f.id = d.folder_id
            LEFT JOIN field_text  ft ON ft.document_id = d.id
            CROSS JOIN search_query sq
            CROSS JOIN LATERAL (
              -- Fase 7.1: setweight por campo — nome (A) > metadado customizado (B)
              -- > metadados estruturados/setor/fiscal (C) > texto OCR (D).
              SELECT
                setweight(to_tsvector('portuguese', public.immutable_unaccent(d.name)), 'A') ||
                setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(ft.txt, ''))), 'B') ||
                setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(d.sector, '') || ' ' || coalesce(d.tipo_fiscal, ''))), 'C') ||
                setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(d.ocr_text, ''))), 'D') AS tsv
            ) dtv
            WHERE d.company_id = $2
              AND d.deleted_at IS NULL
              AND (
                dtv.tsv @@ sq.tsq
                OR d.name ILIKE '%' || $8 || '%'
                -- Fase 6.1/7.1: fallback pg_trgm — contenção de substring pura,
                -- sem stemming/tokenização, com o termo cru (não normalizado)
                -- pra não perder pontuação de código/CNPJ/CPF; cobre nome,
                -- OCR e agora também metadado customizado.
                OR d.ocr_text ILIKE '%' || $8 || '%'
                OR ft.txt ILIKE '%' || $8 || '%'
              )
              AND ($3::uuid IS NULL OR d.folder_id = $3)
              AND ($4::text  IS NULL OR d.sector    = $4)
              AND ($5::text  IS NULL OR d.file_type = $5)
            ORDER BY rank DESC, d.created_at DESC
            LIMIT $6 OFFSET $7
            """,
            normalized, company_id, folder_id, sector, file_type, page_size, offset, raw_term,
        )

        total = rows[0]["total_count"] if rows else 0

        # Fase 7.2: facetas dinâmicas — contagem por setor/tipo de arquivo entre
        # os documentos que batem com a busca, ignorando o próprio filtro de
        # cada dimensão (senão a faceta escolhida sempre mostraria 100%).
        facet_rows = await conn.fetch(
            """
            WITH search_query AS (
              SELECT websearch_to_tsquery('portuguese', unaccent($1)) AS tsq
            ),
            field_text AS (
              SELECT dfv.document_id,
                     string_agg(coalesce(dfv.value_text, dfv.value_number::text, dfv.value_date::text), ' ') AS txt
              FROM public.document_field_value dfv
              GROUP BY dfv.document_id
            ),
            matched AS (
              SELECT d.sector, d.file_type
              FROM public.documents d
              LEFT JOIN field_text ft ON ft.document_id = d.id
              CROSS JOIN search_query sq
              CROSS JOIN LATERAL (
                SELECT
                  setweight(to_tsvector('portuguese', public.immutable_unaccent(d.name)), 'A') ||
                  setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(ft.txt, ''))), 'B') ||
                  setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(d.sector, '') || ' ' || coalesce(d.tipo_fiscal, ''))), 'C') ||
                  setweight(to_tsvector('portuguese', public.immutable_unaccent(coalesce(d.ocr_text, ''))), 'D') AS tsv
              ) dtv
              WHERE d.company_id = $2
                AND d.deleted_at IS NULL
                AND ($3::uuid IS NULL OR d.folder_id = $3)
                AND (
                  dtv.tsv @@ sq.tsq
                  OR d.name ILIKE '%' || $4 || '%'
                  OR d.ocr_text ILIKE '%' || $4 || '%'
                  OR ft.txt ILIKE '%' || $4 || '%'
                )
            )
            SELECT 'sector' AS dimension, sector AS value, count(*) AS count
            FROM matched WHERE sector IS NOT NULL GROUP BY sector
            UNION ALL
            SELECT 'file_type' AS dimension, file_type AS value, count(*) AS count
            FROM matched WHERE file_type IS NOT NULL GROUP BY file_type
            """,
            normalized, company_id, folder_id, raw_term,
        )
        facets: dict[str, list[dict[str, Any]]] = {"sector": [], "file_type": []}
        for r in facet_rows:
            facets[r["dimension"]].append({"value": r["value"], "count": r["count"]})
        for dim in facets:
            facets[dim].sort(key=lambda x: x["count"], reverse=True)

        return {
            "results": [{k: v for k, v in dict(r).items() if k != "total_count"} for r in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
            "query": q,
            "facets": facets,
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
