"""
CustomFieldsService — catálogo de campos customizados (metadados), aplicação
na árvore de pastas (com herança via resolve_folder_fields), e valores
preenchidos por documento (ADENDO-08).

NUNCA decide permissão sozinho — a checagem de "é admin/supremo" é feita no
router (mesmo padrão de _can_manage_company em companies.py); a leitura
respeita RLS via a conexão authenticated normal.
"""
import json
from typing import Any
from uuid import UUID

import asyncpg

VALID_TYPES = ("texto", "cpf", "cnpj", "data", "competencia", "numero", "selecao")


class CustomFieldsService:
    # ─── Catálogo (custom_field) ────────────────────────────────────────────

    @staticmethod
    async def list_fields(conn: asyncpg.Connection, *, company_id: UUID, include_archived: bool) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT id::text, company_id::text, label, field_key, type, format_config,
                   created_by::text, created_at, archived_at
            FROM public.custom_field
            WHERE company_id = $1
              AND ($2::boolean OR archived_at IS NULL)
            ORDER BY archived_at NULLS FIRST, label
            """,
            company_id, include_archived,
        )

    @staticmethod
    async def get_field(conn: asyncpg.Connection, field_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id::text, company_id::text, label, field_key, type, format_config FROM public.custom_field WHERE id = $1",
            field_id,
        )

    @staticmethod
    async def create_field(
        conn: asyncpg.Connection, *, company_id: UUID, label: str, field_key: str,
        type: str, format_config: dict[str, Any], created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.custom_field (company_id, label, field_key, type, format_config, created_by)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)
            RETURNING id::text, company_id::text, label, field_key, type, format_config, created_at
            """,
            company_id, label, field_key, type, json.dumps(format_config), created_by,
        )

    @staticmethod
    async def update_field(
        conn: asyncpg.Connection, field_id: UUID, *, label: str | None, format_config: dict[str, Any] | None,
    ) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            UPDATE public.custom_field
            SET label = COALESCE($2, label),
                format_config = COALESCE($3::jsonb, format_config)
            WHERE id = $1
            RETURNING id::text, company_id::text, label, field_key, type, format_config, created_at
            """,
            field_id, label, json.dumps(format_config) if format_config is not None else None,
        )

    @staticmethod
    async def archive_field(conn: asyncpg.Connection, field_id: UUID) -> None:
        """Soft-delete: some das colunas/formulários, mas os valores já preenchidos ficam intactos."""
        await conn.execute(
            "UPDATE public.custom_field SET archived_at = now() WHERE id = $1 AND archived_at IS NULL",
            field_id,
        )

    @staticmethod
    async def copy_fields_from_company(
        conn: asyncpg.Connection, *, source_company_id: UUID, target_company_id: UUID, created_by: str,
    ) -> list[asyncpg.Record]:
        """
        Copia só o catálogo (não a aplicação na árvore — estruturas de pasta
        diferem entre empresas, §5.3 do ADENDO-08). field_key precisa ser
        único por empresa; ON CONFLICT ignora campos já existentes com a
        mesma key no destino (idempotente — copiar 2x não duplica).
        """
        return await conn.fetch(
            """
            INSERT INTO public.custom_field (company_id, label, field_key, type, format_config, created_by)
            SELECT $2, label, field_key, type, format_config, $3
            FROM public.custom_field
            WHERE company_id = $1 AND archived_at IS NULL
            ON CONFLICT (company_id, field_key) DO NOTHING
            RETURNING id::text, company_id::text, label, field_key, type, format_config, created_at
            """,
            source_company_id, target_company_id, created_by,
        )

    # ─── Aplicação na árvore (folder_field) ─────────────────────────────────

    @staticmethod
    async def resolve_for_folder(conn: asyncpg.Connection, *, company_id: UUID, folder_path: str | None) -> list[asyncpg.Record]:
        """Campos efetivos (após herança/override) para uma pasta — reusa a função SQL resolve_folder_fields."""
        return await conn.fetch(
            """
            SELECT rf.custom_field_id::text, rf.required, rf.display_order, rf.column_width,
                   cf.label, cf.field_key, cf.type, cf.format_config
            FROM public.resolve_folder_fields($1, $2::ltree) rf
            JOIN public.custom_field cf ON cf.id = rf.custom_field_id
            WHERE cf.archived_at IS NULL
            ORDER BY rf.display_order, cf.label
            """,
            company_id, folder_path,
        )

    @staticmethod
    async def list_folder_field_rules(conn: asyncpg.Connection, *, company_id: UUID, folder_path: str | None) -> list[asyncpg.Record]:
        """Regras cruas (não resolvidas) aplicadas exatamente nesta pasta — para a tela de edição mostrar
        o que é próprio vs herdado (herdado = resolve_for_folder menos as linhas daqui)."""
        return await conn.fetch(
            """
            SELECT ff.id::text, ff.custom_field_id::text, ff.mode, ff.required, ff.display_order, ff.column_width,
                   cf.label, cf.field_key, cf.type
            FROM public.folder_field ff
            JOIN public.custom_field cf ON cf.id = ff.custom_field_id
            WHERE ff.company_id = $1
              AND ((ff.folder_path IS NULL AND $2::ltree IS NULL) OR ff.folder_path = $2::ltree)
            ORDER BY ff.display_order, cf.label
            """,
            company_id, folder_path,
        )

    @staticmethod
    async def upsert_folder_field(
        conn: asyncpg.Connection, *, company_id: UUID, folder_path: str | None, custom_field_id: UUID,
        mode: str, required: bool, display_order: int, column_width: int | None, created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.folder_field (company_id, folder_path, custom_field_id, mode, required, display_order, column_width, created_by)
            VALUES ($1, $2::ltree, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (company_id, folder_path, custom_field_id)
            DO UPDATE SET mode = $4, required = $5, display_order = $6, column_width = $7
            RETURNING id::text, company_id::text, folder_path::text, custom_field_id::text, mode, required, display_order, column_width
            """,
            company_id, folder_path, custom_field_id, mode, required, display_order, column_width, created_by,
        )

    @staticmethod
    async def remove_folder_field_rule(conn: asyncpg.Connection, rule_id: UUID) -> None:
        """Remove a regra própria desta pasta — volta a herdar do ancestral (se houver)."""
        await conn.execute("DELETE FROM public.folder_field WHERE id = $1", rule_id)

    @staticmethod
    async def get_folder_path(conn: asyncpg.Connection, folder_id: UUID) -> str | None:
        row = await conn.fetchrow("SELECT path::text FROM public.folders WHERE id = $1 AND deleted_at IS NULL", folder_id)
        return row["path"] if row else None

    # ─── Valores por documento (document_field_value) ───────────────────────

    @staticmethod
    async def get_document_values(conn: asyncpg.Connection, document_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT dfv.custom_field_id::text, dfv.value_text, dfv.value_date, dfv.value_number,
                   cf.label, cf.field_key, cf.type
            FROM public.document_field_value dfv
            JOIN public.custom_field cf ON cf.id = dfv.custom_field_id
            WHERE dfv.document_id = $1
            """,
            document_id,
        )

    @staticmethod
    async def get_values_for_documents(conn: asyncpg.Connection, document_ids: list[UUID]) -> list[asyncpg.Record]:
        """Busca em lote — evita N+1 quando a tabela de Documentos precisa mostrar
        colunas de metadado para vários documentos de uma vez (M-H)."""
        if not document_ids:
            return []
        return await conn.fetch(
            """
            SELECT dfv.document_id::text, dfv.custom_field_id::text, dfv.value_text, dfv.value_date, dfv.value_number
            FROM public.document_field_value dfv
            WHERE dfv.document_id = ANY($1::uuid[])
            """,
            document_ids,
        )

    @staticmethod
    async def upsert_document_value(
        conn: asyncpg.Connection, *, document_id: UUID, company_id: UUID, custom_field_id: UUID,
        value_text: str, value_date, value_number, updated_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.document_field_value (document_id, company_id, custom_field_id, value_text, value_date, value_number, updated_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (document_id, custom_field_id)
            DO UPDATE SET value_text = $4, value_date = $5, value_number = $6, updated_by = $7, updated_at = now()
            RETURNING id::text, document_id::text, custom_field_id::text, value_text, value_date, value_number
            """,
            document_id, company_id, custom_field_id, value_text, value_date, value_number, updated_by,
        )
