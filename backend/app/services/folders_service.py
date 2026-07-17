"""
FoldersService — CRUD de pastas, move com ltree, templates de pasta.
NUNCA lida com permissões reais (isso é RLS) nem com documentos (isso é
documents_service) — só orquestra as queries que folders.py precisa.
"""
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from app.services import storage_service
from app.services.documents_service import DocumentsService


class FoldersService:
    @staticmethod
    async def list_folders(
        conn: asyncpg.Connection, *, company_id: UUID, parent_id: UUID | None, flat: bool,
    ) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              f.id::text,
              f.name,
              f.path::text,
              f.parent_id::text,
              f.company_id::text,
              f.created_by::text,
              f.created_at,
              public.user_has_access(auth.uid(), f.path, f.company_id) AS my_permission,
              (SELECT count(*) FROM public.folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL) AS child_count,
              (SELECT count(*) FROM public.documents d WHERE d.folder_id = f.id AND d.deleted_at IS NULL) AS document_count
            FROM public.folders f
            WHERE f.company_id = $1
              AND f.deleted_at IS NULL
              AND (
                $3::boolean
                OR ($2::uuid IS NULL AND f.parent_id IS NULL OR f.parent_id = $2)
              )
            ORDER BY f.path
            """,
            company_id, parent_id, flat,
        )

    @staticmethod
    async def frequent_folders(
        conn: asyncpg.Connection, *, user_id: str, company_id: UUID, limit: int,
    ) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              f.id::text,
              f.name,
              f.path::text,
              f.parent_id::text,
              f.company_id::text,
              COUNT(al.id) AS activity_count,
              MAX(al.created_at) AS last_activity
            FROM public.folders f
            JOIN public.documents d ON d.folder_id = f.id AND d.deleted_at IS NULL
            JOIN public.activity_log al
              ON al.item_id = d.id
              AND al.item_type = 'document'
              AND al.user_id = $1::uuid
              AND al.created_at >= now() - interval '30 days'
              AND al.action IN ('upload', 'view', 'download')
            WHERE f.company_id = $2
              AND f.deleted_at IS NULL
            GROUP BY f.id, f.name, f.path, f.parent_id, f.company_id
            ORDER BY activity_count DESC, last_activity DESC
            LIMIT $3
            """,
            user_id, company_id, limit,
        )

    @staticmethod
    async def get_parent_folder(conn: asyncpg.Connection, parent_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT path::text, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            parent_id,
        )

    @staticmethod
    async def generate_path_label(conn: asyncpg.Connection) -> str:
        """Gera label ltree único: sequência numérica curta (evita caracteres inválidos)."""
        return await conn.fetchval(
            "SELECT 'f' || floor(extract(epoch FROM now()) * 1000)::text || lpad((random()*9999)::int::text, 4, '0')"
        )

    @staticmethod
    async def check_permission(conn: asyncpg.Connection, user_id: str, path: str | None, company_id: UUID) -> str | None:
        return await conn.fetchval(
            "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
            user_id, path, company_id,
        )

    @staticmethod
    async def insert_folder(
        conn: asyncpg.Connection, *, company_id: UUID, parent_id: UUID | None, path: str, name: str, created_by: str,
    ) -> asyncpg.Record:
        return await conn.fetchrow(
            """
            INSERT INTO public.folders (company_id, parent_id, path, name, created_by)
            VALUES ($1, $2, $3::ltree, $4, $5)
            RETURNING id::text, name, path::text, parent_id::text, company_id::text, created_at
            """,
            company_id, parent_id, path, name, created_by,
        )

    @staticmethod
    async def rename_folder(conn: asyncpg.Connection, folder_id: UUID, name: str) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            UPDATE public.folders
            SET name = $2
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING id::text, name, path::text, parent_id::text, company_id::text, created_at
            """,
            folder_id, name,
        )

    @staticmethod
    async def get_folder_for_move(conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        """R8: SELECT ... FOR UPDATE trava a linha até o fim da transação da
        request (get_db já abre uma transaction explícita por request), evitando
        corrida entre dois moves concorrentes da mesma pasta."""
        return await conn.fetchrow(
            "SELECT path::text, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
            folder_id,
        )

    @staticmethod
    async def get_target_parent(conn: asyncpg.Connection, parent_id: UUID, company_id) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT path::text FROM public.folders WHERE id = $1 AND deleted_at IS NULL AND company_id = $2",
            parent_id, company_id,
        )

    @staticmethod
    async def move_folder_atomic(
        conn: asyncpg.Connection, *, folder_id: UUID, new_parent_path: str | None,
        old_nlevel: int, new_parent_id: UUID | None, old_path: str,
    ) -> None:
        """
        Atualiza a pasta + todos os descendentes atomicamente (R4/R8).
        subpath(path, old_nlevel - 1) = sufixo a partir do label da própria pasta movida.
        """
        await conn.execute(
            """
            UPDATE public.folders
            SET path = CASE
                    WHEN $2::text IS NULL THEN subpath(path, $3)
                    ELSE ($2::ltree || subpath(path, $3))
                END,
                parent_id = CASE WHEN id = $1 THEN $4 ELSE parent_id END
            WHERE (id = $1 OR path <@ $5::ltree)
              AND deleted_at IS NULL
            """,
            folder_id, new_parent_path, old_nlevel - 1, new_parent_id, old_path,
        )

    @staticmethod
    async def get_folder_after_move(conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id::text, name, path::text, parent_id::text, company_id::text FROM public.folders WHERE id = $1",
            folder_id,
        )

    @staticmethod
    async def get_folder_for_delete(conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT f.name, f.path::text, f.company_id::text,
                   public.user_has_access(auth.uid(), f.path, f.company_id) AS permission
            FROM public.folders f
            WHERE f.id = $1 AND f.deleted_at IS NULL
            """,
            folder_id,
        )

    @staticmethod
    async def log_delete_activity(conn: asyncpg.Connection, *, folder_id: UUID, company_id: str, name: str) -> None:
        """
        activity_log_insert (RLS) permite qualquer authenticated inserir sua
        própria linha — sem isso, exclusão de pasta nunca aparecia no log de
        atividade nem no aviso de pré-purga da lixeira (que depende de saber
        quem excluiu).
        """
        await conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)
            VALUES (auth.uid(), $1::uuid, 'delete', 'folder', $2::uuid, $3)
            """,
            company_id, folder_id, name,
        )

    @staticmethod
    async def soft_delete_folder_cascade(admin_conn: asyncpg.Connection, path: str) -> None:
        """
        Soft delete via service role (bypassa RLS para evitar o bloqueio implícito
        de UPDATE que torna a linha invisível ao próprio SELECT do usuário).
        trash_expires_at (ADR-025/030): retention_days da empresa no momento da exclusão.
        """
        await admin_conn.execute(
            """
            UPDATE public.folders f
            SET deleted_at = now(),
                trash_expires_at = now() + (c.retention_days || ' days')::interval
            FROM public.companies c
            WHERE f.path <@ $1::ltree AND f.deleted_at IS NULL AND c.id = f.company_id
            """,
            path,
        )
        await admin_conn.execute(
            """
            UPDATE public.documents d
            SET deleted_at = now(),
                deleted_original_folder_id = d.folder_id,
                trash_expires_at = now() + (c.retention_days || ' days')::interval
            FROM public.folders f
            JOIN public.companies c ON c.id = f.company_id
            WHERE d.folder_id = f.id
              AND f.path <@ $1::ltree
              AND d.deleted_at IS NULL
            """,
            path,
        )

    # ─── Copiar estrutura de pastas (entre empresas ou na mesma empresa) ────

    @staticmethod
    async def get_folder_for_copy(conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        """Mesmo padrão de get_folder_for_delete — permission vem via RLS/auth.uid()."""
        return await conn.fetchrow(
            """
            SELECT f.id::text, f.name, f.path::text, f.company_id::text,
                   public.user_has_access(auth.uid(), f.path, f.company_id) AS permission
            FROM public.folders f
            WHERE f.id = $1 AND f.deleted_at IS NULL
            """,
            folder_id,
        )

    @staticmethod
    async def get_subtree(conn: asyncpg.Connection, *, company_id: str, path: str) -> list[asyncpg.Record]:
        """Pasta + todos os descendentes, em ordem topológica (path ASC garante
        que o ancestral sempre aparece antes de qualquer descendente — mesma
        premissa usada em list_folders para montar a árvore no cliente)."""
        return await conn.fetch(
            """
            SELECT id::text, name, parent_id::text, path::text
            FROM public.folders
            WHERE company_id = $1::uuid AND path <@ $2::ltree AND deleted_at IS NULL
            ORDER BY path
            """,
            company_id, path,
        )

    @staticmethod
    async def find_folder_name_conflict(
        conn: asyncpg.Connection, *, parent_id: UUID | None, company_id: str, name: str,
    ) -> UUID | None:
        return await conn.fetchval(
            """
            SELECT id FROM public.folders
            WHERE company_id = $1::uuid AND name = $3 AND deleted_at IS NULL
              AND (($2::uuid IS NULL AND parent_id IS NULL) OR parent_id = $2::uuid)
            """,
            company_id, parent_id, name,
        )

    @staticmethod
    async def resolve_unique_folder_name(
        conn: asyncpg.Connection, *, parent_id: UUID | None, company_id: str, name: str,
    ) -> str:
        """Mesmo padrão de DocumentsService.resolve_unique_name — sufixo " (1)",
        " (2)"... em vez de bloquear a cópia por colisão de nome."""
        if await FoldersService.find_folder_name_conflict(conn, parent_id=parent_id, company_id=company_id, name=name) is None:
            return name
        n = 1
        while True:
            candidate = f"{name} ({n})"
            if await FoldersService.find_folder_name_conflict(conn, parent_id=parent_id, company_id=company_id, name=candidate) is None:
                return candidate
            n += 1

    @staticmethod
    async def copy_folder_tree(
        conn: asyncpg.Connection, *,
        subtree: list[asyncpg.Record], source_root_id: str,
        target_company_id: UUID, target_parent_id: UUID | None, target_parent_path: str | None,
        created_by: str,
    ) -> tuple[dict[str, str], dict[str, str], asyncpg.Record]:
        """
        Recria a subárvore inteira (pasta copiada + todos os descendentes) sob
        um novo pai, em outra empresa (ou na mesma). Preserva a hierarquia
        relativa, mas gera paths/labels novos — nunca reaproveita o path de
        origem, mesmo copiando pra dentro da mesma empresa.

        Retorna (id_map, path_map, novo_registro_da_raiz):
        - id_map: {old_folder_id: new_folder_id}
        - path_map: {old_path: new_path} — usado depois pra traduzir folder_field.folder_path
        """
        # id_to_new: {old_folder_id: (new_folder_id, new_path)} — uma única fonte
        # pra resolver "onde entra o próximo filho", indexada por id (não por path,
        # que não serve pra achar o pai de uma linha — path_map abaixo é só o
        # subproduto exposto pra copy_folder_fields traduzir folder_field.folder_path).
        id_to_new: dict[str, tuple[str, str]] = {}
        path_map: dict[str, str] = {}
        id_map: dict[str, str] = {}
        new_root: asyncpg.Record | None = None

        for row in subtree:
            is_root = row["id"] == source_root_id
            if is_root:
                new_parent_id = target_parent_id
                new_parent_path = target_parent_path
            else:
                parent_new_id, parent_new_path = id_to_new[row["parent_id"]]
                new_parent_id = UUID(parent_new_id)
                new_parent_path = parent_new_path

            resolved_name = await FoldersService.resolve_unique_folder_name(
                conn, parent_id=new_parent_id, company_id=str(target_company_id), name=row["name"],
            )
            label = await FoldersService.generate_path_label(conn)
            new_path = f"{new_parent_path}.{label}" if new_parent_path else label

            new_row = await FoldersService.insert_folder(
                conn, company_id=target_company_id, parent_id=new_parent_id,
                path=new_path, name=resolved_name, created_by=created_by,
            )
            id_to_new[row["id"]] = (new_row["id"], new_row["path"])
            id_map[row["id"]] = new_row["id"]
            path_map[row["path"]] = new_row["path"]
            if is_root:
                new_root = new_row

        assert new_root is not None
        return id_map, path_map, new_root

    @staticmethod
    async def copy_folder_fields(
        conn: asyncpg.Connection, *,
        source_company_id: str, source_path: str, path_map: dict[str, str],
        target_company_id: UUID, created_by: str,
    ) -> int:
        """
        Copia a CONFIGURAÇÃO de campos customizados (ADENDO-08) aplicada às
        pastas copiadas — só as aplicações específicas de pasta dentro da
        subárvore (folder_path <@ source_path), nunca os padrões da empresa
        toda (folder_path IS NULL), que não fazem sentido herdar cruzando
        empresa. Não copia os VALORES preenchidos por documento — só a
        definição de quais campos existem em cada pasta.
        """
        rows = await conn.fetch(
            """
            SELECT ff.folder_path::text, ff.mode, ff.required, ff.display_order, ff.column_width,
                   cf.label, cf.field_key, cf.type, cf.format_config
            FROM public.folder_field ff
            JOIN public.custom_field cf ON cf.id = ff.custom_field_id
            WHERE ff.company_id = $1::uuid AND ff.folder_path IS NOT NULL AND ff.folder_path <@ $2::ltree
              AND cf.archived_at IS NULL
            """,
            source_company_id, source_path,
        )
        count = 0
        for row in rows:
            new_folder_path = path_map.get(row["folder_path"])
            if new_folder_path is None:
                continue  # segurança: não deveria acontecer, path sempre vem da própria subárvore copiada

            target_field_id = await conn.fetchval(
                "SELECT id FROM public.custom_field WHERE company_id = $1::uuid AND field_key = $2 AND archived_at IS NULL",
                target_company_id, row["field_key"],
            )
            if target_field_id is None:
                target_field_id = await conn.fetchval(
                    """
                    INSERT INTO public.custom_field (company_id, label, field_key, type, format_config, created_by)
                    VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6::uuid)
                    RETURNING id
                    """,
                    target_company_id, row["label"], row["field_key"], row["type"], row["format_config"], created_by,
                )

            await conn.execute(
                """
                INSERT INTO public.folder_field
                  (company_id, folder_path, custom_field_id, mode, required, display_order, column_width, created_by)
                VALUES ($1::uuid, $2::ltree, $3::uuid, $4, $5, $6, $7, $8::uuid)
                ON CONFLICT (company_id, folder_path, custom_field_id) DO NOTHING
                """,
                target_company_id, new_folder_path, target_field_id,
                row["mode"], row["required"], row["display_order"], row["column_width"], created_by,
            )
            count += 1
        return count

    @staticmethod
    async def copy_folder_documents(
        conn: asyncpg.Connection, *, id_map: dict[str, str], target_company_id: UUID, uploaded_by: str,
    ) -> int:
        """
        Duplica os documentos de cada pasta copiada — copia o arquivo físico no
        storage (sem passar pelo fluxo de upload do usuário) e cria uma linha
        nova em documents. content_hash fica NULL propositalmente: a constraint
        uq_document_hash_per_company é por empresa, e copiar o hash original
        poderia colidir (cópia pra mesma empresa) ou interferir na detecção de
        duplicata de uploads futuros — deduplicação não é o objetivo aqui.
        OCR não é reenfileirado: é literalmente o mesmo arquivo, o texto já
        extraído (ocr_text/ocr_status/ocr_completed_at) é copiado direto.
        """
        count = 0
        for old_folder_id, new_folder_id in id_map.items():
            docs = await conn.fetch(
                """
                SELECT name, mime_type, file_type, size_bytes, storage_path,
                       sector, competencia, tipo_fiscal, ocr_status, ocr_text, ocr_completed_at
                FROM public.documents
                WHERE folder_id = $1::uuid AND deleted_at IS NULL
                """,
                old_folder_id,
            )
            for doc in docs:
                new_document_id = uuid4()
                dot_idx = doc["name"].rfind(".")
                ext = doc["name"][dot_idx + 1:] if dot_idx != -1 else "bin"
                new_storage_path = storage_service.storage_key(str(target_company_id), str(new_document_id), ext)
                storage_service.copy_object(doc["storage_path"], new_storage_path)

                final_name = await DocumentsService.resolve_unique_name(conn, UUID(new_folder_id), doc["name"])

                await conn.execute(
                    """
                    INSERT INTO public.documents
                      (id, folder_id, company_id, name, mime_type, file_type, size_bytes, storage_path,
                       sector, competencia, tipo_fiscal, ocr_status, ocr_text, ocr_completed_at, uploaded_by)
                    VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::uuid)
                    """,
                    new_document_id, UUID(new_folder_id), target_company_id, final_name,
                    doc["mime_type"], doc["file_type"], doc["size_bytes"], new_storage_path,
                    doc["sector"], doc["competencia"], doc["tipo_fiscal"],
                    doc["ocr_status"], doc["ocr_text"], doc["ocr_completed_at"], uploaded_by,
                )
                count += 1
        return count

    @staticmethod
    async def log_copy_activity(conn: asyncpg.Connection, *, folder_id: str, company_id: str, name: str) -> None:
        await conn.execute(
            """
            INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot)
            VALUES (auth.uid(), $1::uuid, 'copy', 'folder', $2::uuid, $3)
            """,
            company_id, folder_id, name,
        )
