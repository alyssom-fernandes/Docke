"""Inserção em activity_log e export CSV/XLSX — implementado em M3.4.

NUNCA edita ou deleta linhas do activity_log (append-only, Invariante I1).
"""
import csv
import io
import json
from datetime import date
from typing import Any
from uuid import UUID

import asyncpg
from openpyxl import Workbook
from openpyxl.styles import Font

_EXPORT_LIMIT = 5000

_ACTION_LABELS: dict[str, str] = {
    "upload": "Envio",
    "view": "Visualização",
    "move": "Movimentação",
    "rename": "Renomeação",
    "delete": "Exclusão",
    "restore": "Restauração",
    "download": "Download",
    "favorite": "Ancorado",
    "unfavorite": "Desancorado",
    "undo": "Desfeito",
    "copy": "Cópia de estrutura",
    "update_metadata": "Metadado alterado",
    "version_delete": "Versão excluída",
    "integrity_check": "Integridade conferida",
    "privacy_set": "Classificação LGPD alterada",
    "lgpd_titular_search": "Pedido do titular consultado",
    "version_label": "Versão nomeada",
    "obligation_create": "Obrigação cadastrada",
    "obligation_update": "Obrigação alterada",
    "obligation_archive": "Obrigação arquivada",
    "obligation_restore": "Obrigação reativada",
    "obligation_generate": "Competência aberta",
    "obligation_link": "Documento enviado para obrigação",
    "obligation_unlink": "Documento tirado de obrigação",
    "obligation_approve": "Obrigação aprovada",
    "obligation_return": "Obrigação devolvida",
    "obligation_dispense": "Obrigação dispensada",
    "obligation_cancel": "Competência cancelada",
    "obligation_reopen": "Obrigação reaberta",
    "obligation_assign": "Responsável trocado",
    "obligation_dependency_add": "Dependência criada",
    "obligation_dependency_remove": "Dependência removida",
    "retention_policy_create": "Prazo de guarda cadastrado",
    "retention_policy_update": "Prazo de guarda alterado",
    "retention_policy_archive": "Prazo de guarda arquivado",
    "retention_assign": "Prazo atribuído",
    "retention_unassign": "Prazo removido",
    "retention_hold_create": "Bloqueio judicial criado",
    "retention_hold_release": "Bloqueio judicial liberado",
    "retention_queue_approved": "Descarte aprovado",
    "retention_queue_rejected": "Documento mantido",
    "retention_queue_deferred": "Decisão adiada",
    "access_grant": "Acesso concedido",
    "access_revoke": "Acesso retirado",
    "access_role_change": "Papel trocado",
    "member_remove": "Pessoa removida da empresa",
    "account_deactivate": "Conta desativada",
    "account_activate": "Conta reativada",
    "account_password_reset": "Senha provisória gerada",
    "field_update": "Campo alterado",
    "field_archive": "Campo arquivado",
    "field_restore": "Campo reativado",
    "field_rule_apply": "Campo aplicado em pasta",
    "fields_copy": "Campos copiados de outra empresa",
    "audit_export": "Trilha de auditoria exportada",
    "share_policy": "Política de links alterada",
    "mfa_policy": "Regra da verificação em duas etapas alterada",
    "mfa_reset": "Verificação em duas etapas zerada",
    "sessions_end": "Sessões encerradas",
    "audit_verify": "Integridade da trilha verificada",
    "field_rules_copy": "Regras de metadados copiadas de outra pasta",
    "field_rule_exclude": "Campo tirado de pasta",
}

REVERSIBLE_ACTIONS = {"move", "rename", "delete", "favorite"}


class ActivityService:
    """Responsável por consultas, export e undo de activity_log."""

    @staticmethod
    async def list_events(
        conn: asyncpg.Connection,
        *,
        company_id: UUID,
        user_id: UUID | None,
        action: str | None,
        item_type: str | None,
        item_id: UUID | None = None,
        date_from: date | None,
        date_to: date | None,
        page: int,
        page_size: int,
        sem_acessos: bool = False,
    ) -> dict[str, Any]:
        offset = (page - 1) * page_size
        rows = await conn.fetch(
            """
            SELECT
              al.id::text,
              al.user_id::text,
              al.company_id::text,
              al.action,
              al.item_type,
              al.item_id::text,
              al.item_name_snapshot,
              al.metadata,
              al.created_at,
              u.full_name AS user_name,
              u.username  AS user_username,
              -- pasta ATUAL do documento (não a de quando o evento aconteceu) —
              -- permite ao frontend montar o deep-link /documents?folder_id=...&doc=...;
              -- vem NULL se o documento já foi excluído permanentemente desde então,
              -- e nesse caso o item simplesmente não é clicável no frontend.
              cur_d.folder_id::text AS current_folder_id,
              count(*) OVER () AS total_count
            FROM public.activity_log al
            LEFT JOIN public.users u ON u.id = al.user_id
            LEFT JOIN public.documents cur_d
              ON al.item_type = 'document' AND cur_d.id = al.item_id AND cur_d.deleted_at IS NULL
            WHERE al.company_id = $1
              AND ($2::uuid IS NULL OR al.user_id    = $2)
              AND ($3::text IS NULL OR al.action     = $3)
              AND ($4::text IS NULL OR al.item_type  = $4)
              AND ($5::date IS NULL OR al.created_at >= $5::date)
              AND ($6::date IS NULL OR al.created_at <  ($6 + interval '1 day')::date)
              AND ($9::uuid IS NULL OR al.item_id    = $9)
              AND (NOT $10::boolean OR al.action NOT IN ('view', 'download'))
            ORDER BY al.created_at DESC
            LIMIT $7 OFFSET $8
            """,
            company_id, user_id, action, item_type, date_from, date_to, page_size, offset, item_id, sem_acessos,
        )
        total = rows[0]["total_count"] if rows else 0
        results = []
        for r in rows:
            item = {k: v for k, v in dict(r).items() if k != "total_count"}
            # asyncpg devolve jsonb como string crua — sem isso o frontend recebe
            # '{"a":"b"}' como texto (Object.entries vira índice:caractere).
            if isinstance(item.get("metadata"), str):
                item["metadata"] = json.loads(item["metadata"])
            results.append(item)
        return {
            "results": results,
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @staticmethod
    async def fetch_export_rows(
        conn: asyncpg.Connection,
        *,
        company_id: UUID,
        user_id: UUID | None,
        action: str | None,
        item_type: str | None,
        date_from: date | None,
        date_to: date | None,
    ) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              al.id::text,
              al.created_at,
              al.action,
              al.item_type,
              al.item_name_snapshot,
              al.item_id::text,
              u.full_name AS user_name,
              u.username  AS user_username
            FROM public.activity_log al
            LEFT JOIN public.users u ON u.id = al.user_id
            WHERE al.company_id = $1
              AND ($2::uuid IS NULL OR al.user_id    = $2)
              AND ($3::text IS NULL OR al.action     = $3)
              AND ($4::text IS NULL OR al.item_type  = $4)
              AND ($5::date IS NULL OR al.created_at >= $5::date)
              AND ($6::date IS NULL OR al.created_at <  ($6 + interval '1 day')::date)
            ORDER BY al.created_at DESC
            LIMIT $7
            """,
            company_id, user_id, action, item_type, date_from, date_to, _EXPORT_LIMIT,
        )

    @staticmethod
    def build_xlsx(rows: list[asyncpg.Record]) -> bytes:
        wb = Workbook()
        ws = wb.active
        ws.title = "Atividade"
        headers = ["Data/Hora", "Ação", "Tipo", "Item", "Usuário", "Usuário (login)"]
        ws.append(headers)
        for cell in ws[1]:
            cell.font = Font(bold=True)
        for r in rows:
            ws.append([
                r["created_at"].strftime("%d/%m/%Y %H:%M") if r["created_at"] else "",
                _ACTION_LABELS.get(r["action"], r["action"]),
                "Pasta" if r["item_type"] == "folder" else "Documento",
                r["item_name_snapshot"] or "",
                r["user_name"] or "",
                r["user_username"] or "",
            ])
        for col_idx, header in enumerate(headers, start=1):
            ws.column_dimensions[chr(64 + col_idx)].width = max(len(header) + 2, 18)
        buf = io.BytesIO()
        wb.save(buf)
        return buf.getvalue()

    @staticmethod
    def build_csv(rows: list[asyncpg.Record]) -> bytes:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "created_at", "action", "item_type", "item_name", "item_id", "user_name", "username"])
        for r in rows:
            writer.writerow([
                r["id"],
                r["created_at"].isoformat() if r["created_at"] else "",
                r["action"],
                r["item_type"],
                r["item_name_snapshot"] or "",
                r["item_id"],
                r["user_name"] or "",
                r["user_username"] or "",
            ])
        return buf.getvalue().encode("utf-8-sig")  # BOM para Excel abrir corretamente

    @staticmethod
    async def verify_chain(conn: asyncpg.Connection, *, company_id: UUID) -> list[asyncpg.Record]:
        """Recalcula a cadeia de hash HMAC de uma empresa (função SQL SECURITY
        DEFINER — a chave nunca passa pelo Python)."""
        return await conn.fetch(
            "SELECT event_id, event_created_at, ok, reason FROM public.activity_log_verify_chain($1)",
            company_id,
        )

    @staticmethod
    async def verify_summary(conn: asyncpg.Connection, *, company_id: UUID) -> asyncpg.Record:
        """Resumo da verificação calculado no banco (X3-12): antes todas as
        linhas da trilha vinham para o Python só para serem contadas."""
        return await conn.fetchrow(
            """
            WITH v AS (
              SELECT event_id, event_created_at, ok, reason, n
              FROM public.activity_log_verify_chain($1) WITH ORDINALITY AS t(event_id, event_created_at, ok, reason, n)
            )
            SELECT
              count(*) FILTER (WHERE event_id IS NOT NULL) AS total_events,
              count(*) FILTER (WHERE NOT ok) AS broken_count,
              (SELECT jsonb_build_object('event_id', event_id, 'event_created_at', event_created_at, 'ok', ok, 'reason', reason)
                 FROM v WHERE NOT ok ORDER BY n LIMIT 1) AS first_broken
            FROM v
            """,
            company_id,
        )

    @staticmethod
    async def get_event(conn: asyncpg.Connection, event_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT id::text, action, item_type, item_id::text, item_name_snapshot,
                   company_id::text, metadata
            FROM public.activity_log
            WHERE id = $1
            """,
            event_id,
        )

    @staticmethod
    async def create_undo_event(
        admin_conn: asyncpg.Connection,
        *,
        user_id: str,
        event: asyncpg.Record,
        event_id: UUID,
    ) -> asyncpg.Record:
        undo_metadata: dict[str, Any] = {
            "undo_of_event_id": str(event_id),
            "original_action": event["action"],
            "original_name": event["item_name_snapshot"],
        }
        if event["metadata"]:
            original_meta = event["metadata"] if isinstance(event["metadata"], dict) else json.loads(event["metadata"])
            undo_metadata["original_metadata"] = original_meta

        return await admin_conn.fetchrow(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
            VALUES ($1::uuid, $2::uuid, 'undo', $3, $4::uuid, $5, $6::jsonb)
            RETURNING id::text, action, item_type, item_id::text, item_name_snapshot, metadata, created_at
            """,
            user_id,
            event["company_id"],
            event["item_type"],
            event["item_id"],
            event["item_name_snapshot"],
            json.dumps(undo_metadata),
        )

    @staticmethod
    def undo_instructions(event: dict[str, Any]) -> dict[str, Any]:
        """Retorna instruções para o cliente executar o undo."""
        action = event["action"]
        item_id = event["item_id"]
        meta = event.get("metadata") or {}
        if isinstance(meta, str):
            meta = json.loads(meta)

        if action == "delete":
            return {"type": "restore", "endpoint": f"POST /trash/{item_id}/restore?item_type={event['item_type']}"}
        if action == "move":
            original_folder = meta.get("original_folder_id") or meta.get("source_folder_id")
            return {"type": "move_back", "endpoint": "POST /documents/bulk-move", "target_folder_id": original_folder}
        if action == "rename":
            original_name = meta.get("original_name") or event["item_name_snapshot"]
            return {"type": "rename_back", "name": original_name}
        if action == "favorite":
            return {"type": "unfavorite", "endpoint": "DELETE /favorites/<favorite_id>"}
        return {}
