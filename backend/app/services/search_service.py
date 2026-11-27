"""Full-text search com FTS 'portuguese' + ts_headline — implementado em M3.1."""
import difflib
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

    _MESES = ("jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez")

    @staticmethod
    def competencia_pattern(raw: str) -> str | None:
        """
        Competência escrita de vários jeitos (B2.2.1): "03/2026", "3-2026",
        "mar/2026", "março de 2026" e "2026-03" acham o mesmo documento, no
        texto, no nome e na competência gravada. Devolve uma expressão regular
        do PostgreSQL (sem caixa) ou None se o termo não é uma competência.
        """
        t = raw.strip().lower()
        mes = ano = None
        m = re.fullmatch(r"(0?[1-9]|1[0-2])\s*[/\-.]\s*(\d{4})", t)
        if m:
            mes, ano = int(m.group(1)), m.group(2)
        m = m or re.fullmatch(r"(\d{4})\s*[/\-.]\s*(0[1-9]|1[0-2])", t)
        if m and mes is None:
            ano, mes = m.group(1), int(m.group(2))
        if mes is None:
            m = re.fullmatch(r"([a-zç]{3})[a-zç]*\.?\s*(?:de\s+|[/\-.]\s*)?(\d{4})", t)
            if m and m.group(1) in SearchService._MESES:
                mes, ano = SearchService._MESES.index(m.group(1)) + 1, m.group(2)
        if mes is None or not ano or not 2000 <= int(ano) <= 2100:
            return None
        abrev = SearchService._MESES[mes - 1]
        return (rf"(?i)(\m0?{mes}\s*[/\-.]\s*{ano}\M|\m{abrev}[a-zç]*\.?\s*(de\s+|[/\-.]\s*)?{ano}\M"
                rf"|\m{ano}\s*[/\-.]\s*{mes:02d}\M)")

    _WHERE = """
      d.company_id = $2
      AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
      AND (
        d.search_tsv @@ sq.tsq
        OR to_tsvector('portuguese', public.immutable_unaccent(coalesce(ft.txt, ''))) @@ sq.tsq
        OR d.name ILIKE '%' || $3 || '%'
        OR d.ocr_text ILIKE '%' || $3 || '%'
        OR ft.txt ILIKE '%' || $3 || '%'
        OR ($4::text IS NOT NULL AND (d.name ~ $4 OR d.ocr_text ~ $4 OR ft.txt ~ $4 OR coalesce(d.competencia::text, '') ~ $4
              -- Chave de acesso da NF-e lida no envio, com ou sem espaços (B2.5.5).
              OR EXISTS (SELECT 1 FROM public.document_nfe n WHERE n.document_id = d.id
                         AND (n.chave ~ $4 OR coalesce(n.emitente_cnpj, '') ~ $4 OR coalesce(n.destinatario_doc, '') ~ $4))))
        -- Campos da NF-e lida na entrada (B2.5.4): emitente, destinatário e número.
        OR EXISTS (SELECT 1 FROM public.document_nfe n WHERE n.document_id = d.id AND length($3) >= 3
                   AND public.immutable_unaccent(lower(coalesce(n.emitente_nome, '') || ' ' || coalesce(n.destinatario_nome, '') || ' ' || coalesce(n.numero::text, '')))
                       LIKE '%' || public.immutable_unaccent(lower($3)) || '%')
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
        # Sinais de uso (B2.1.4): ancorado por quem busca e aberto por ela nos
        # últimos 90 dias sobem; o ganho é limitado para não passar na frente
        # de um resultado bem mais relevante.
        "relevancia": "ts_rank_cd(dtv.tsv, sq.tsq, 4) * (1 + uso.boost) DESC, d.created_at DESC",
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
        guarda: str | None = None,
        ocr: str | None = None,
        campo: UUID | None = None,
        valor: str | None = None,
    ) -> dict[str, Any]:
        """
        Busca com filtros de pasta (com subpastas), período e tipo, ordenação
        e paginação (A6-03, A6-04). O termo cru alimenta o ILIKE (códigos com
        pontuação) e os números entram também sem pontuação.
        """
        offset = (page - 1) * page_size
        raw_term = q.strip()
        digits = SearchService.digits_pattern(raw_term) or SearchService.competencia_pattern(raw_term)
        order = SearchService._ORDER.get(sort, SearchService._ORDER["relevancia"])
        rows = await conn.fetch(
            f"""
            SELECT
              d.id::text, d.name, d.file_type, d.size_bytes, d.sector, d.competencia, d.tipo_fiscal,
              d.ocr_status, d.folder_id::text, d.company_id::text, d.created_at, f.name AS folder_name,
              ts_rank_cd(dtv.tsv, sq.tsq, 4) AS rank,
              uso.boost > 0 AS usado_por_mim,
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
            CROSS JOIN LATERAL (
              SELECT
                (CASE WHEN EXISTS (SELECT 1 FROM public.favorites fv WHERE fv.user_id = auth.uid() AND fv.document_id = d.id) THEN 0.5 ELSE 0 END)
                + (CASE WHEN EXISTS (
                    SELECT 1 FROM public.activity_log al
                    WHERE al.item_id = d.id AND al.item_type = 'document' AND al.user_id = auth.uid()
                      AND al.action IN ('view', 'download') AND al.created_at > now() - interval '90 days'
                  ) THEN 0.3 ELSE 0 END) AS boost
            ) uso
            WHERE {SearchService._WHERE}
              AND ($9::text IS NULL OR d.sector = $9)
              AND ($10::text IS NULL OR d.file_type = $10)
              AND ($13::text IS NULL
                   OR ($13 = 'bloqueio' AND public.document_is_under_hold(d.id))
                   OR ($13 = 'sem_prazo' AND NOT EXISTS (SELECT 1 FROM public.document_retention_info(d.id) ri WHERE ri.policy_id IS NOT NULL))
                   OR ($13 = 'vencido' AND EXISTS (SELECT 1 FROM public.document_retention_info(d.id) ri WHERE ri.expires_at < CURRENT_DATE)))
              AND ($14::text IS NULL OR ($14 = 'lido' AND d.ocr_status = 'done') OR ($14 = 'fila' AND d.ocr_status IN ('pending', 'processing'))
                   OR ($14 = 'falhou' AND d.ocr_status = 'failed'))
              AND ($15::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM public.document_field_value v
                    WHERE v.document_id = d.id AND v.custom_field_id = $15::uuid
                      AND ($16::text IS NULL OR public.immutable_unaccent(lower(coalesce(v.value_text, v.value_number::text, v.value_date::text, '')))
                           LIKE '%' || public.immutable_unaccent(lower($16::text)) || '%')))
            ORDER BY {order}
            LIMIT $11 OFFSET $12
            """,
            normalized, company_id, raw_term, digits, folder_path, date_from, date_to, exact_folder_id,
            sector, file_type, page_size, offset, guarda, ocr, campo, valor,
        )
        total = rows[0]["total_count"] if rows else 0

        # Tolerância a erro de digitação e de OCR (B2.2.3, B2.1.9): sem nenhum
        # resultado exato, procura palavras parecidas por trigramas ("contrarto"
        # acha "contrato"). Palavra curta pede semelhança maior.
        aproximado = False
        sugestao: str | None = None
        letras = re.sub(r"[^\w]", "", raw_term, flags=re.UNICODE)
        if not rows and page == 1 and digits is None and len(letras) >= 4 and not letras.isdigit():
            limiar = 0.75 if len(letras) <= 5 else 0.6 if len(letras) <= 7 else 0.5
            await conn.execute(f"SET LOCAL pg_trgm.word_similarity_threshold = {limiar}")
            rows = await conn.fetch(
                """
                SELECT
                  d.id::text, d.name, d.file_type, d.size_bytes, d.sector, d.competencia, d.tipo_fiscal,
                  d.ocr_status, d.folder_id::text, d.company_id::text, d.created_at, f.name AS folder_name,
                  greatest(word_similarity($1, d.name), word_similarity($1, coalesce(d.ocr_text, ''))) AS rank,
                  NULL::text AS snippet,
                  (SELECT string_agg(anc.name, ' / ' ORDER BY nlevel(anc.path))
                     FROM public.folders anc WHERE anc.company_id = d.company_id AND anc.path @> f.path) AS folder_path_label
                FROM public.documents d
                JOIN public.folders f ON f.id = d.folder_id
                WHERE d.company_id = $2 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
                  AND ($1 <% d.name OR $1 <% d.ocr_text)
                  AND ($3::ltree IS NULL OR f.path <@ $3::ltree)
                  AND ($4::date IS NULL OR d.created_at >= $4::date)
                  AND ($5::date IS NULL OR d.created_at < ($5::date + 1))
                  AND ($6::uuid IS NULL OR d.folder_id = $6)
                  AND ($7::text IS NULL OR d.sector = $7)
                  AND ($8::text IS NULL OR d.file_type = $8)
                  AND ($10::text IS NULL
                       OR ($10 = 'bloqueio' AND public.document_is_under_hold(d.id))
                       OR ($10 = 'sem_prazo' AND NOT EXISTS (SELECT 1 FROM public.document_retention_info(d.id) ri WHERE ri.policy_id IS NOT NULL))
                       OR ($10 = 'vencido' AND EXISTS (SELECT 1 FROM public.document_retention_info(d.id) ri WHERE ri.expires_at < CURRENT_DATE)))
                  AND ($11::text IS NULL OR ($11 = 'lido' AND d.ocr_status = 'done') OR ($11 = 'fila' AND d.ocr_status IN ('pending', 'processing'))
                       OR ($11 = 'falhou' AND d.ocr_status = 'failed'))
                  AND ($12::uuid IS NULL OR EXISTS (
                        SELECT 1 FROM public.document_field_value v
                        WHERE v.document_id = d.id AND v.custom_field_id = $12::uuid
                          AND ($13::text IS NULL OR public.immutable_unaccent(lower(coalesce(v.value_text, v.value_number::text, v.value_date::text, '')))
                               LIKE '%' || public.immutable_unaccent(lower($13::text)) || '%')))
                ORDER BY rank DESC, d.created_at DESC
                LIMIT $9
                """,
                raw_term, company_id, folder_path, date_from, date_to, exact_folder_id, sector, file_type, page_size, guarda,
                ocr, campo, valor,
            )
            aproximado = bool(rows)
            total = len(rows)
            if rows:
                palavras = {w for r in rows for w in re.findall(r"[^\W\d_]{4,}", r["name"] or "", flags=re.UNICODE)}
                perto = difflib.get_close_matches(raw_term.lower(), {w.lower() for w in palavras}, n=1, cutoff=0.6)
                sugestao = perto[0] if perto and perto[0] != raw_term.lower() else None

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
            "aproximado": aproximado,
            "sugestao": sugestao,
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
        # Só letras e números entram na sintaxe do to_tsquery (X3-06): aspas,
        # apóstrofo ("d'água") ou hífen solto quebravam a consulta com erro 500.
        words = re.findall(r"\w+", normalized, flags=re.UNICODE)
        if not words:
            return []
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
