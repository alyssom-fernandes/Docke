"""
Fase 5.1-5.6 — Retenção legal: política / atribuição / hold / fila de
revisão / execução real do descarte + certificado de destruição.

5.1-5.5 nunca apagam um documento — só calculam prazo, bloqueiam exclusão
sob hold, ou registram uma decisão humana na fila. Só `execute_purge`
(5.4-5.6) de fato apaga, e só aceita item já 'approved' — a aprovação
sozinha nunca chega até aqui automaticamente. Ver comentário de cabeçalho
das migrations 20260723000026 e 20260723000027 para o raciocínio completo.
"""
import json
from typing import Any
from uuid import UUID

import asyncpg


class UnderHoldError(Exception):
    """Levantado quando execute_purge encontra hold ativo na revalidação — o router traduz pra 423."""


class RetentionService:
    # -------------------------------------------------------------------
    # Políticas
    # -------------------------------------------------------------------
    @staticmethod
    async def list_policies(conn: asyncpg.Connection, company_id: UUID, include_archived: bool = False) -> list[asyncpg.Record]:
        clause = "" if include_archived else "AND rp.archived_at IS NULL"
        return await conn.fetch(
            f"""
            SELECT rp.*, cf.label AS trigger_field_label,
                   (SELECT count(*) FROM public.retention_policy_assignments rpa WHERE rpa.policy_id = rp.id) AS assignment_count
            FROM public.retention_policies rp
            LEFT JOIN public.custom_field cf ON cf.id = rp.trigger_custom_field_id
            WHERE rp.company_id = $1 {clause}
            ORDER BY rp.archived_at NULLS FIRST, rp.name
            """,
            company_id,
        )

    @staticmethod
    async def get_policy(conn: asyncpg.Connection, policy_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT * FROM public.retention_policies WHERE id = $1", policy_id)

    @staticmethod
    async def create_policy(
        conn: asyncpg.Connection, *, company_id: UUID, name: str, legal_basis: str | None,
        trigger_type: str, trigger_custom_field_id: UUID | None, duration_months: int | None,
        locked: bool, created_by: str, start_rule: str = "data", notes: str | None = None, catalog_key: str | None = None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.retention_policies
              (company_id, name, legal_basis, trigger_type, trigger_custom_field_id, duration_months, locked, created_by,
               start_rule, notes, catalog_key)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING *
            """,
            company_id, name, legal_basis, trigger_type, trigger_custom_field_id, duration_months, locked, created_by,
            start_rule, notes, catalog_key,
        )

    @staticmethod
    async def update_policy(conn: asyncpg.Connection, policy_id: UUID, changes: dict[str, Any]) -> asyncpg.Record:
        allowed = ("name", "legal_basis", "notes", "duration_months", "locked", "start_rule", "trigger_type", "trigger_custom_field_id")
        cols = [c for c in allowed if c in changes]
        if not cols:
            return await RetentionService.get_policy(conn, policy_id)
        sets = ", ".join(f"{c} = ${i + 2}" for i, c in enumerate(cols))
        return await conn.fetchrow(
            f"UPDATE public.retention_policies SET {sets} WHERE id = $1 RETURNING *",
            policy_id, *[changes[c] for c in cols],
        )

    @staticmethod
    async def existing_catalog_keys(conn: asyncpg.Connection, company_id: UUID) -> set[str]:
        rows = await conn.fetch(
            "SELECT catalog_key FROM public.retention_policies WHERE company_id = $1 AND catalog_key IS NOT NULL AND archived_at IS NULL",
            company_id,
        )
        return {r["catalog_key"] for r in rows}

    @staticmethod
    async def winner_count(conn: asyncpg.Connection, company_id: UUID, policy_id: UUID, folder_path: str | None = None) -> int:
        """Quantos documentos têm hoje o prazo definido por esta política (o que perde cobertura ao arquivar/remover)."""
        return int(await conn.fetchval(
            """
            SELECT count(*) FROM public.documents d
            JOIN public.folders f ON f.id = d.folder_id
            CROSS JOIN LATERAL public.document_retention_info(d.id) w
            WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
              AND w.policy_id = $2
              AND ($3::ltree IS NULL OR f.path <@ $3::ltree)
            """,
            company_id, policy_id, folder_path,
        ) or 0)

    @staticmethod
    async def log(
        conn: asyncpg.Connection, *, user_id: str, company_id: UUID | str, action: str, item_id: UUID | str,
        name: str, metadata: dict[str, Any] | None = None,
    ) -> None:
        """Ações de retenção entram na trilha (A7-03, A7-106)."""
        await conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
            VALUES ($1::uuid, $2::uuid, $3, 'retention', $4::uuid, $5, 'retention', $6::jsonb)
            """,
            user_id, str(company_id), action, str(item_id), name, json.dumps(metadata or {}, default=str),
        )

    @staticmethod
    async def archive_policy(conn: asyncpg.Connection, policy_id: UUID) -> None:
        await conn.execute("UPDATE public.retention_policies SET archived_at = now() WHERE id = $1", policy_id)

    # -------------------------------------------------------------------
    # Atribuições
    # -------------------------------------------------------------------
    @staticmethod
    async def list_assignments(conn: asyncpg.Connection, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT rpa.*, rp.name AS policy_name, f.id::text AS folder_id,
                   (SELECT string_agg(anc.name, ' / ' ORDER BY nlevel(anc.path))
                      FROM public.folders anc
                     WHERE anc.company_id = rpa.company_id AND anc.path @> rpa.folder_path) AS folder_label,
                   (SELECT cf.label FROM public.custom_field cf WHERE cf.id = rpa.match_field_id) AS match_field_label,
                   (SELECT count(*) FROM public.documents d JOIN public.folders df ON df.id = d.folder_id
                     WHERE d.company_id = rpa.company_id AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
                       AND (rpa.folder_path IS NULL OR df.path <@ rpa.folder_path)
                       AND public.retention_assignment_applies(rpa.match_tipo_fiscal, rpa.match_field_id, rpa.match_field_value, d.id, d.tipo_fiscal)) AS document_count
            FROM public.retention_policy_assignments rpa
            JOIN public.retention_policies rp ON rp.id = rpa.policy_id
            LEFT JOIN public.folders f ON f.company_id = rpa.company_id AND f.path = rpa.folder_path AND f.deleted_at IS NULL
            WHERE rpa.company_id = $1
            ORDER BY rpa.folder_path NULLS FIRST
            """,
            company_id,
        )

    @staticmethod
    async def get_assignment(conn: asyncpg.Connection, assignment_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT rpa.*, rp.name AS policy_name,
                   (SELECT string_agg(anc.name, ' / ' ORDER BY nlevel(anc.path))
                      FROM public.folders anc
                     WHERE anc.company_id = rpa.company_id AND anc.path @> rpa.folder_path) AS folder_label,
                   (SELECT cf.label FROM public.custom_field cf WHERE cf.id = rpa.match_field_id) AS match_field_label
            FROM public.retention_policy_assignments rpa
            JOIN public.retention_policies rp ON rp.id = rpa.policy_id
            WHERE rpa.id = $1
            """,
            assignment_id,
        )

    @staticmethod
    async def create_assignment(
        conn: asyncpg.Connection, *, company_id: UUID, folder_path: str | None, policy_id: UUID, created_by: str,
        match_tipo_fiscal: str | None = None, match_field_id: UUID | None = None, match_field_value: str | None = None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.retention_policy_assignments
              (company_id, folder_path, policy_id, created_by, match_tipo_fiscal, match_field_id, match_field_value)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            company_id, folder_path, policy_id, created_by, match_tipo_fiscal, match_field_id, match_field_value,
        )

    @staticmethod
    async def remove_assignment(conn: asyncpg.Connection, assignment_id: UUID) -> None:
        await conn.execute("DELETE FROM public.retention_policy_assignments WHERE id = $1", assignment_id)

    # -------------------------------------------------------------------
    # Legal holds
    # -------------------------------------------------------------------
    @staticmethod
    async def list_holds(conn: asyncpg.Connection, company_id: UUID, active_only: bool = True) -> list[asyncpg.Record]:
        """Com o nome e o caminho do que está bloqueado (A7-107) e quem criou/liberou."""
        clause = "AND h.released_at IS NULL" if active_only else ""
        return await conn.fetch(
            f"""
            SELECT h.*, cu.full_name AS created_by_name, ru.full_name AS released_by_name,
                   COALESCE(d.name, f.name, cust.full_name) AS resource_name,
                   (SELECT count(*) FROM public.documents cd
                     WHERE h.resource_type = 'custodian' AND cd.company_id = h.company_id
                       AND cd.uploaded_by = h.resource_id AND cd.deleted_at IS NULL) AS custodian_documents,
                   COALESCE(d.folder_id, f.id)::text AS folder_id,
                   (SELECT string_agg(anc.name, ' / ' ORDER BY nlevel(anc.path))
                      FROM public.folders anc
                     WHERE anc.company_id = h.company_id AND anc.path @> COALESCE(df.path, f.path)) AS resource_path
            FROM public.legal_holds h
            LEFT JOIN public.documents d ON h.resource_type = 'document' AND d.id = h.resource_id
            LEFT JOIN public.folders df ON df.id = d.folder_id
            LEFT JOIN public.folders f ON h.resource_type = 'folder' AND f.id = h.resource_id
            LEFT JOIN public.users cust ON h.resource_type = 'custodian' AND cust.id = h.resource_id
            LEFT JOIN public.users cu ON cu.id = h.created_by
            LEFT JOIN public.users ru ON ru.id = h.released_by
            WHERE h.company_id = $1 {clause}
            ORDER BY h.released_at NULLS FIRST, h.created_at DESC
            """,
            company_id,
        )

    @staticmethod
    async def create_hold(
        conn: asyncpg.Connection, *, company_id: UUID, resource_type: str, resource_id: UUID, reason: str, created_by: str,
        process_number: str | None = None, review_date=None,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.legal_holds (company_id, resource_type, resource_id, reason, created_by, process_number, review_date)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
            """,
            company_id, resource_type, resource_id, reason, created_by, process_number, review_date,
        )

    @staticmethod
    async def resource_name(conn: asyncpg.Connection, company_id: UUID, resource_type: str, resource_id: UUID) -> str | None:
        if resource_type == "custodian":
            # Custodiante (B3.4.3): pessoa com acesso à empresa ou que enviou documento nela.
            return await conn.fetchval(
                """
                SELECT u.full_name FROM public.users u
                WHERE u.id = $1 AND (
                  EXISTS (SELECT 1 FROM public.user_company_access a WHERE a.user_id = u.id AND a.company_id = $2)
                  OR EXISTS (SELECT 1 FROM public.documents d WHERE d.uploaded_by = u.id AND d.company_id = $2))
                """,
                resource_id, company_id,
            )
        table = "documents" if resource_type == "document" else "folders"
        return await conn.fetchval(
            f"SELECT name FROM public.{table} WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL", resource_id, company_id,
        )

    @staticmethod
    async def release_hold(conn: asyncpg.Connection, hold_id: UUID, released_by: str, reason: str | None = None) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            UPDATE public.legal_holds SET released_at = now(), released_by = $2, release_reason = $3
            WHERE id = $1 AND released_at IS NULL RETURNING *
            """,
            hold_id, released_by, reason,
        )

    @staticmethod
    async def document_is_under_hold(conn: asyncpg.Connection, document_id: UUID) -> bool:
        return bool(await conn.fetchval("SELECT public.document_is_under_hold($1)", document_id))

    @staticmethod
    async def folder_is_under_hold(conn: asyncpg.Connection, folder_id: UUID) -> bool:
        return bool(await conn.fetchval("SELECT public.folder_is_under_hold($1)", folder_id))

    # -------------------------------------------------------------------
    # Prazo calculado
    # -------------------------------------------------------------------
    @staticmethod
    async def get_document_retention_info(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow("SELECT * FROM public.document_retention_info($1)", document_id)

    @staticmethod
    async def simulate_assignment_impact(
        conn: asyncpg.Connection, *, company_id: UUID, policy_id: UUID, folder_path: str | None,
        match_tipo_fiscal: str | None = None, match_field_id: UUID | None = None, match_field_value: str | None = None,
    ) -> dict[str, Any]:
        """
        Prévia antes de atribuir (A7-88): para cada documento do escopo
        (pasta e subpastas, ou a empresa toda), o prazo de hoje (pela mesma
        função que decide de verdade) contra o prazo da política nova. Como o
        prazo mais longo prevalece, a nova só muda os documentos em que ela
        guarda por mais tempo. Mostra a data nova e quantos entrariam já
        vencidos na fila de revisão. Envios incompletos ficam de fora.
        """
        rows = await conn.fetch(
            """
            WITH scope_docs AS (
              SELECT d.id, d.name, d.created_at
              FROM public.documents d
              JOIN public.folders f ON f.id = d.folder_id
              WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
                AND ($3::ltree IS NULL OR f.path <@ $3::ltree)
                AND public.retention_assignment_applies($4, $5, $6, d.id, d.tipo_fiscal)
            ),
            np AS (SELECT * FROM public.retention_policies WHERE id = $2),
            calc AS (
              SELECT sd.id AS document_id, sd.name AS document_name,
                     cur.policy_id AS before_policy_id, cur.policy_name AS before_policy,
                     cur.expires_at AS before_expires_at, cur.is_indeterminate AS before_indeterminate,
                     np.name AS new_policy, np.duration_months IS NULL AS new_indeterminate, st.start_date,
                     CASE WHEN np.duration_months IS NULL OR st.start_date IS NULL THEN NULL ELSE (
                       (CASE WHEN np.start_rule = 'ano_seguinte'
                             THEN (date_trunc('year', st.start_date) + interval '1 year')::date
                             ELSE st.start_date END)
                       + (np.duration_months || ' months')::interval)::date END AS new_expires_at
              FROM scope_docs sd
              CROSS JOIN np
              LEFT JOIN LATERAL (SELECT * FROM public.document_retention_info(sd.id)) cur ON true
              CROSS JOIN LATERAL (
                SELECT CASE np.trigger_type
                         WHEN 'upload_date' THEN sd.created_at::date
                         WHEN 'custom_field' THEN (SELECT dfv.value_date FROM public.document_field_value dfv
                                                   WHERE dfv.document_id = sd.id AND dfv.custom_field_id = np.trigger_custom_field_id)
                       END AS start_date
              ) st
            )
            SELECT *,
              (start_date IS NOT NULL OR new_indeterminate) AND (
                before_policy_id IS NULL
                OR (new_indeterminate AND NOT before_indeterminate)
                OR (NOT new_indeterminate AND NOT COALESCE(before_indeterminate, false) AND new_expires_at > before_expires_at)
              ) AS changed
            FROM calc
            ORDER BY document_name
            """,
            company_id, policy_id, folder_path, match_tipo_fiscal, match_field_id, match_field_value,
        )
        import datetime as _dt

        hoje = _dt.date.today()
        results = []
        for r in rows:
            d = dict(r)
            if d["changed"]:
                d["after_policy"], d["after_expires_at"], d["after_indeterminate"] = d["new_policy"], d["new_expires_at"], d["new_indeterminate"]
            else:
                d["after_policy"], d["after_expires_at"], d["after_indeterminate"] = d["before_policy"], d["before_expires_at"], d["before_indeterminate"]
            results.append(d)
        changed = [r for r in results if r["changed"]]
        sem_data = [r for r in results if r["start_date"] is None and not r["new_indeterminate"]]
        return {
            "total_documents_in_scope": len(results),
            "changed_count": len(changed),
            "unchanged_count": len(results) - len(changed),
            "newly_covered_count": sum(1 for r in changed if r["before_policy_id"] is None),
            "already_expired_count": sum(1 for r in changed if r["after_expires_at"] is not None and r["after_expires_at"] < hoje),
            "missing_trigger_count": len(sem_data),
            "sample": [
                {k: r[k] for k in ("document_id", "document_name", "before_policy", "before_expires_at", "before_indeterminate",
                                   "after_policy", "after_expires_at", "after_indeterminate", "changed")}
                for r in changed[:10]
            ],
        }

    @staticmethod
    async def health_check(conn: asyncpg.Connection, company_id: UUID) -> dict[str, Any]:
        """
        Fase 14.3 — dois achados de governança, sem precisar abrir cada
        documento um por um: (1) políticas ativas nunca atribuídas a nada
        (existem, mas não protegem nenhum documento — provavelmente esquecidas
        na criação); (2) documentos sem NENHUMA política aplicável (nem
        empresa toda, nem pasta ancestral) — o oposto do "Ver cálculo" da
        14.1, que resolve o vencedor quando HÁ candidatos.
        """
        policies_without_assignments = await conn.fetch(
            """
            SELECT rp.id, rp.name
            FROM public.retention_policies rp
            WHERE rp.company_id = $1 AND rp.active AND rp.archived_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.retention_policy_assignments rpa WHERE rpa.policy_id = rp.id)
            ORDER BY rp.name
            """,
            company_id,
        )
        docs_without_policy = await conn.fetch(
            """
            SELECT d.id, d.name, f.name AS folder_name, d.folder_id::text AS folder_id
            FROM public.documents d
            JOIN public.folders f ON f.id = d.folder_id
            WHERE d.company_id = $1 AND d.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM public.retention_policy_assignments rpa
                JOIN public.retention_policies rp ON rp.id = rpa.policy_id
                WHERE rpa.company_id = d.company_id AND rp.active AND rp.archived_at IS NULL
                  AND (rpa.folder_path IS NULL OR rpa.folder_path @> f.path)
                  AND public.retention_assignment_applies(rpa.match_tipo_fiscal, rpa.match_field_id, rpa.match_field_value, d.id, d.tipo_fiscal)
              )
            ORDER BY d.created_at DESC
            LIMIT 51
            """,
            company_id,
        )
        docs_list = [dict(r) for r in docs_without_policy[:50]]
        return {
            "policies_without_assignments": [dict(r) for r in policies_without_assignments],
            "documents_without_policy_sample": docs_list,
            "documents_without_policy_has_more": len(docs_without_policy) > 50,
        }

    @staticmethod
    async def explain_retention(conn: asyncpg.Connection, document_id: UUID) -> dict[str, Any]:
        """
        "Ver cálculo": todas as políticas que valem para o documento, cada uma
        com a própria data, e qual define o prazo (a mais longa; a trava só
        desempata e impede a exclusão até o prazo dela acabar).
        """
        rows = await conn.fetch(
            """
            SELECT c.policy_id, c.policy_name, c.locked, c.is_indeterminate, c.expires_at,
                   (c.assignment_folder_path IS NULL) AS company_wide, true AS eligible
            FROM public.document_retention_candidates($1) c
            ORDER BY c.is_indeterminate DESC, c.expires_at DESC NULLS LAST, c.locked DESC
            """,
            document_id,
        )
        candidates = [dict(r) for r in rows]
        winner = candidates[0] if candidates else None
        for c in candidates:
            c["is_winner"] = c is winner
        # B3.4.2: a política e a data que valiam quando o documento entrou.
        foto = await conn.fetchrow(
            """
            SELECT policy_name, expires_at, is_indeterminate, captured_at, policy->>'duration_months' AS duration_months
            FROM public.document_retention_snapshots WHERE document_id = $1
            """,
            document_id,
        )
        return {"winner": winner, "candidates": candidates, "inicio": dict(foto) if foto else None}

    # -------------------------------------------------------------------
    # Fila de revisão (5.5 — só registro + decisão humana, sem executar exclusão)
    # -------------------------------------------------------------------
    @staticmethod
    async def list_queue(conn: asyncpg.Connection, company_id: UUID, status_filter: str | None = None) -> list[asyncpg.Record]:
        conditions = ["q.company_id = $1"]
        params: list[Any] = [company_id]
        if status_filter is not None:
            params.append(status_filter)
            conditions.append(f"q.status = ${len(params)}")
        return await conn.fetch(
            f"""
            SELECT q.*, d.name AS document_name, d.deleted_at AS document_deleted_at, d.folder_id::text AS folder_id,
                   f.name AS folder_name, ru.full_name AS reviewed_by_name, fu.full_name AS first_approved_by_name
            FROM public.retention_review_queue q
            JOIN public.documents d ON d.id = q.document_id
            LEFT JOIN public.folders f ON f.id = d.folder_id
            LEFT JOIN public.users ru ON ru.id = q.reviewed_by
            LEFT JOIN public.users fu ON fu.id = q.first_approved_by
            WHERE {' AND '.join(conditions)}
            ORDER BY q.computed_expires_at
            """,
            *params,
        )

    @staticmethod
    async def decide_queue_item(
        conn: asyncpg.Connection, queue_id: UUID, *, decision: str, notes: str | None,
        deferred_until: Any | None, reviewed_by: str,
    ) -> asyncpg.Record:
        # Aprovação dupla (B3.4.5): com a regra da empresa ligada, a primeira
        # aprovação só fica registrada; a segunda, de outra pessoa, aprova.
        item = await conn.fetchrow(
            """
            SELECT q.id, q.company_id, q.first_approved_by, q.first_approved_at, c.retention_double_approval AS dupla,
                   u.full_name AS primeiro_nome
            FROM public.retention_review_queue q JOIN public.companies c ON c.id = q.company_id
            LEFT JOIN public.users u ON u.id = q.first_approved_by
            WHERE q.id = $1
            """,
            queue_id,
        )
        if item is not None and item["dupla"] and decision == "approved":
            if item["first_approved_by"] is None:
                return await conn.fetchrow(
                    """
                    UPDATE public.retention_review_queue
                    SET first_approved_by = $2, first_approved_at = now(), review_notes = coalesce($3, review_notes)
                    WHERE id = $1 RETURNING *, true AS aguardando_segunda
                    """,
                    queue_id, reviewed_by, notes,
                )
            if str(item["first_approved_by"]) == str(reviewed_by):
                from fastapi import HTTPException, status
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail="A segunda aprovação precisa ser de outra pessoa.")
            primeira = f'1ª aprovação: {item["primeiro_nome"] or "outra pessoa"} em {item["first_approved_at"]:%d/%m/%Y %H:%M}'
            notes = f"{notes} ({primeira})" if notes else primeira
        return await conn.fetchrow(
            """
            UPDATE public.retention_review_queue
            SET status = $2, review_notes = $3, deferred_until = $4, reviewed_by = $5, reviewed_at = now(),
                first_approved_by = CASE WHEN $2 = 'approved' THEN first_approved_by END,
                first_approved_at = CASE WHEN $2 = 'approved' THEN first_approved_at END
            WHERE id = $1
            RETURNING *
            """,
            queue_id, decision, notes, deferred_until, reviewed_by,
        )

    # -------------------------------------------------------------------
    # Execução real do descarte (5.4-5.6) — a ÚNICA função deste arquivo
    # que apaga um documento de verdade. Só aceita item já 'approved' na
    # fila; reverifica hold no instante da execução (pode ter mudado desde
    # a aprovação); e gera o certificado ANTES de apagar, na mesma
    # transação — se o INSERT do certificado falhar, o DELETE nunca roda.
    # -------------------------------------------------------------------
    @staticmethod
    async def execute_purge(
        conn: asyncpg.Connection, admin_conn: asyncpg.Connection, *, queue_id: UUID, executed_by: str,
    ) -> dict[str, Any] | None:
        queue_item = await conn.fetchrow(
            "SELECT * FROM public.retention_review_queue WHERE id = $1 AND status = 'approved'", queue_id,
        )
        if queue_item is None:
            return None

        if await RetentionService.document_is_under_hold(conn, queue_item["document_id"]):
            raise UnderHoldError()

        doc = await admin_conn.fetchrow(
            """
            SELECT d.id, d.name, d.company_id, d.storage_path, d.content_hash,
              (
                SELECT string_agg(anc.name, ' / ' ORDER BY nlevel(anc.path))
                FROM public.folders anc
                WHERE anc.company_id = d.company_id AND anc.path @> f.path
              ) AS folder_path
            FROM public.documents d
            LEFT JOIN public.folders f ON f.id = d.folder_id
            WHERE d.id = $1
            """,
            queue_item["document_id"],
        )
        if doc is None:
            return None

        executed_by_name = await admin_conn.fetchval(
            "SELECT COALESCE(full_name, username, 'usuário') FROM public.users WHERE id = $1", executed_by,
        )
        reviewed_by_name = None
        if queue_item["reviewed_by"]:
            reviewed_by_name = await admin_conn.fetchval(
                "SELECT COALESCE(full_name, username) FROM public.users WHERE id = $1", queue_item["reviewed_by"],
            )
        legal_basis = None
        if queue_item["policy_id"]:
            legal_basis = await admin_conn.fetchval(
                "SELECT legal_basis FROM public.retention_policies WHERE id = $1", queue_item["policy_id"],
            )

        async with admin_conn.transaction():
            certificate = await admin_conn.fetchrow(
                """
                INSERT INTO public.destruction_certificates
                  (company_id, document_id, document_name_snapshot, document_sha256, folder_path_snapshot,
                   queue_item_id, policy_name_snapshot, legal_basis_snapshot,
                   reviewed_by, reviewed_by_name_snapshot, reviewed_at, review_notes,
                   executed_by, executed_by_name_snapshot)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING *
                """,
                doc["company_id"], doc["id"], doc["name"], doc["content_hash"], doc["folder_path"],
                queue_item["id"], queue_item["policy_name_snapshot"], legal_basis,
                queue_item["reviewed_by"], reviewed_by_name, queue_item["reviewed_at"], queue_item["review_notes"],
                executed_by, executed_by_name,
            )
            await admin_conn.execute("DELETE FROM public.documents WHERE id = $1", doc["id"])
            await admin_conn.execute(
                """
                INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
                VALUES ($1::uuid, $2::uuid, 'delete', 'document', $3::uuid, $4, $5::jsonb)
                """,
                executed_by, str(doc["company_id"]), str(doc["id"]), doc["name"],
                json.dumps({
                    "reason": "retention_purge",
                    "certificate_id": str(certificate["id"]),
                    "policy_name": queue_item["policy_name_snapshot"],
                }),
            )

        return {"certificate": dict(certificate), "storage_path": doc["storage_path"]}
