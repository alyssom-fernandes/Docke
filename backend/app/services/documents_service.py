"""
DocumentsService — CRUD de documentos, upload/confirm, preview/download URL,
metadados, soft delete, restore. NUNCA lida com OCR (isso é ocr_service) nem
com permissões reais (isso é RLS) — só orquestra as queries que os routers
de documents.py precisam.

Convenção: todo método recebe a conexão (conn ou admin_conn) explicitamente
como primeiro argumento — nenhuma conexão é aberta aqui (I4/I9).
"""
import xml.etree.ElementTree as ET
from typing import Any
from uuid import UUID

import asyncpg

from app.services import storage_service

_MIME_MAP: dict[str, str] = {
    "pdf": "application/pdf",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "csv": "text/csv",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "xml": "application/xml",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "txt": "text/plain",
}

_NFE_NS = {"nfe": "http://www.portalfiscal.inf.br/nfe"}


class DocumentsService:
    # -- upload (fase 1) ----------------------------------------------------

    @staticmethod
    async def find_folder_for_upload(conn: asyncpg.Connection, folder_id: UUID, company_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT f.id, f.company_id, f.path,
                   public.user_has_access(auth.uid(), f.path, f.company_id) AS permission
            FROM public.folders f
            WHERE f.id = $1 AND f.company_id = $2 AND f.deleted_at IS NULL
            """,
            folder_id, company_id,
        )

    @staticmethod
    async def find_name_conflict(conn: asyncpg.Connection, folder_id: UUID, name: str) -> UUID | None:
        return await conn.fetchval(
            "SELECT id FROM public.documents WHERE folder_id = $1 AND name = $2 AND deleted_at IS NULL",
            folder_id, name,
        )

    @staticmethod
    async def insert_pending_document(
        admin_conn: asyncpg.Connection,
        *, document_id: UUID, folder_id: UUID, company_id: UUID, name: str,
        mime_type: str, file_type: str, size_bytes: int, storage_path: str, uploaded_by: str,
    ) -> asyncpg.Record:
        return await admin_conn.fetchrow(
            """
            INSERT INTO public.documents
              (id, folder_id, company_id, name, mime_type, file_type,
               size_bytes, storage_path, uploaded_by, ocr_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
            RETURNING id::text, name, storage_path, created_at
            """,
            document_id, folder_id, company_id, name, mime_type, file_type, size_bytes, storage_path, uploaded_by,
        )

    # -- confirm (fase 2) -----------------------------------------------------

    @staticmethod
    async def get_document_for_confirm(admin_conn: asyncpg.Connection, document_id: UUID, user_id: str) -> asyncpg.Record | None:
        # admin_conn nunca tem request.jwt.claims setado (não passa por get_db),
        # então auth.uid() seria sempre NULL aqui — por isso o user_id é passado
        # explícito como argumento de user_has_access() em vez de usado implicitamente.
        return await admin_conn.fetchrow(
            """
            SELECT d.id, d.storage_path, d.company_id, d.content_hash,
                   public.user_has_access(
                     $2::uuid,
                     (SELECT f.path FROM public.folders f WHERE f.id = d.folder_id),
                     d.company_id
                   ) AS permission
            FROM public.documents d
            WHERE d.id = $1
            """,
            document_id, user_id,
        )

    @staticmethod
    async def find_duplicate_by_hash(admin_conn: asyncpg.Connection, company_id: UUID, content_hash: str, exclude_id: UUID) -> UUID | None:
        return await admin_conn.fetchval(
            "SELECT id FROM public.documents WHERE company_id = $1 AND content_hash = $2 AND id != $3",
            company_id, content_hash, exclude_id,
        )

    @staticmethod
    async def confirm_upload_transaction(
        admin_conn: asyncpg.Connection, *, document_id: UUID, content_hash: str, user_id: str,
    ) -> asyncpg.Record:
        """Atualiza hash, cria ocr_job e registra activity_log numa única transação (R3)."""
        async with admin_conn.transaction():
            row = await admin_conn.fetchrow(
                """
                UPDATE public.documents
                SET content_hash = $2, updated_at = now()
                WHERE id = $1
                RETURNING id::text, name, folder_id, company_id, storage_path, content_hash,
                          size_bytes, ocr_status, created_at, updated_at
                """,
                document_id, content_hash,
            )
            await admin_conn.execute(
                "INSERT INTO public.ocr_jobs (document_id, status) VALUES ($1, 'pending')",
                document_id,
            )
            await admin_conn.execute(
                """
                INSERT INTO public.activity_log
                  (user_id, company_id, action, item_type, item_id, item_name_snapshot)
                VALUES ($1::uuid, $2::uuid, 'upload', 'document', $3::uuid, $4)
                """,
                user_id, str(row["company_id"]), str(document_id), row["name"],
            )
        return row

    # -- download / preview URLs ---------------------------------------------

    @staticmethod
    async def get_document_for_download(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id, name, storage_path, mime_type, size_bytes FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
            document_id,
        )

    @staticmethod
    async def fetch_documents_for_bulk_download(conn: asyncpg.Connection, ids: list[str]) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT id::text, name, storage_path, mime_type, size_bytes
            FROM public.documents
            WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
            ORDER BY name
            """,
            ids,
        )

    # -- bulk move ------------------------------------------------------------

    @staticmethod
    async def find_target_folder_for_move(conn: asyncpg.Connection, target_folder_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT f.id, f.company_id,
                   public.user_has_access(auth.uid(), f.path, f.company_id) AS permission
            FROM public.folders f
            WHERE f.id = $1 AND f.deleted_at IS NULL
            """,
            target_folder_id,
        )

    @staticmethod
    async def bulk_move_documents(conn: asyncpg.Connection, doc_ids: list[str], target_folder_id: UUID, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            UPDATE public.documents
            SET folder_id  = $2,
                company_id = $3,
                updated_at = now()
            WHERE id = ANY($1::uuid[])
              AND deleted_at IS NULL
              AND company_id = $3
            RETURNING id::text, name
            """,
            doc_ids, target_folder_id, company_id,
        )

    @staticmethod
    async def log_move_activity(admin_conn: asyncpg.Connection, *, user_id: str, doc_ids: list[str], company_id: UUID, target_folder_id: UUID) -> None:
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot, metadata)
            SELECT $1::uuid, $3::uuid, 'move', 'document', id::uuid, name, $4::jsonb
            FROM public.documents
            WHERE id = ANY($2::uuid[]) AND deleted_at IS NULL
            """,
            user_id, doc_ids, str(company_id), f'{{"target_folder_id": "{target_folder_id}"}}',
        )

    # -- bulk delete ------------------------------------------------------------

    @staticmethod
    async def fetch_documents_with_permission(conn: asyncpg.Connection, doc_ids: list[str]) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT d.id::text, d.name, d.company_id::text, d.uploaded_by::text,
                   public.user_has_access(
                     auth.uid(),
                     (SELECT f.path FROM public.folders f WHERE f.id = d.folder_id),
                     d.company_id
                   ) AS permission
            FROM public.documents d
            WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL
            """,
            doc_ids,
        )

    @staticmethod
    async def fetch_source_folders(conn: asyncpg.Connection, doc_ids: list[str]) -> list[asyncpg.Record]:
        return await conn.fetch(
            "SELECT DISTINCT folder_id, company_id FROM public.documents WHERE id = ANY($1::uuid[]) AND folder_id IS NOT NULL",
            doc_ids,
        )

    @staticmethod
    async def soft_delete_bulk(admin_conn: asyncpg.Connection, doc_ids: list[str]) -> list[asyncpg.Record]:
        return await admin_conn.fetch(
            """
            UPDATE public.documents d
            SET deleted_at = now(),
                deleted_original_folder_id = folder_id,
                trash_expires_at = now() + (c.retention_days || ' days')::interval
            FROM public.companies c
            WHERE d.id = ANY($1::uuid[]) AND d.deleted_at IS NULL AND c.id = d.company_id
            RETURNING d.id::text, d.name, d.company_id::text
            """,
            doc_ids,
        )

    @staticmethod
    async def log_bulk_delete_activity(admin_conn: asyncpg.Connection, *, user_id: str, doc_ids: list[str], company_id: str) -> None:
        await admin_conn.execute(
            """
            INSERT INTO public.activity_log
              (user_id, company_id, action, item_type, item_id, item_name_snapshot)
            SELECT $1::uuid, $3::uuid, 'delete', 'document', id::uuid, name
            FROM public.documents
            WHERE id = ANY($2::uuid[])
            """,
            user_id, doc_ids, company_id,
        )

    # -- preview / xml fields ---------------------------------------------------

    @staticmethod
    async def get_document_for_preview(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT id, name, storage_path, mime_type, size_bytes
            FROM public.documents
            WHERE id = $1 AND deleted_at IS NULL
            """,
            document_id,
        )

    @staticmethod
    async def get_document_for_xml(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            "SELECT id, name, storage_path, mime_type, file_type FROM public.documents WHERE id = $1 AND deleted_at IS NULL",
            document_id,
        )

    @staticmethod
    def extract_nfe_fields(xml_bytes: bytes) -> dict[str, Any] | None:
        """
        Faz parsing de um XML de NFe/NFCe e extrai os campos mais relevantes
        para conferência rápida sem precisar abrir o XML bruto.
        Retorna None se o XML não seguir o schema reconhecido (não é NFe).
        """
        try:
            root = ET.fromstring(xml_bytes)
        except ET.ParseError:
            return None

        inf_nfe = root.find(".//nfe:infNFe", _NFE_NS)
        if inf_nfe is None:
            return None

        def text(path: str) -> str | None:
            el = inf_nfe.find(path, _NFE_NS)
            return el.text.strip() if el is not None and el.text else None

        chave_acesso = (inf_nfe.get("Id") or "").replace("NFe", "") or None

        return {
            "recognized": True,
            "chave_acesso": chave_acesso,
            "numero": text("nfe:ide/nfe:nNF"),
            "serie": text("nfe:ide/nfe:serie"),
            "data_emissao": text("nfe:ide/nfe:dhEmi") or text("nfe:ide/nfe:dEmi"),
            "natureza_operacao": text("nfe:ide/nfe:natOp"),
            "emitente_nome": text("nfe:emit/nfe:xNome"),
            "emitente_cnpj": text("nfe:emit/nfe:CNPJ"),
            "destinatario_nome": text("nfe:dest/nfe:xNome"),
            "destinatario_cnpj": text("nfe:dest/nfe:CNPJ") or text("nfe:dest/nfe:CPF"),
            "valor_total": text("nfe:total/nfe:ICMSTot/nfe:vNF"),
        }

    # -- listagem / detalhe / patch -----------------------------------------------

    @staticmethod
    async def list_recent(conn: asyncpg.Connection, company_id: UUID, limit: int) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              d.id::text, d.name, d.folder_id::text, d.company_id::text,
              d.mime_type, d.file_type, d.size_bytes, d.ocr_status, d.created_at
            FROM public.documents d
            WHERE d.company_id = $1 AND d.deleted_at IS NULL
            ORDER BY d.created_at DESC
            LIMIT $2
            """,
            company_id, limit,
        )

    @staticmethod
    async def list_by_folder(conn: asyncpg.Connection, folder_id: UUID, company_id: UUID) -> list[asyncpg.Record]:
        return await conn.fetch(
            """
            SELECT
              d.id::text, d.name, d.folder_id::text, d.company_id::text,
              d.mime_type, d.file_type, d.size_bytes, d.storage_path, d.content_hash,
              d.sector, d.competencia, d.tipo_fiscal, d.ocr_status,
              d.uploaded_by::text, d.created_at, d.updated_at,
              EXISTS (
                SELECT 1 FROM public.favorites f
                WHERE f.document_id = d.id AND f.user_id = auth.uid()
              ) AS favorited
            FROM public.documents d
            WHERE d.folder_id = $1
              AND d.company_id = $2
              AND d.deleted_at IS NULL
            ORDER BY d.name
            """,
            folder_id, company_id,
        )

    @staticmethod
    async def get_document_detail(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT
              d.id::text, d.name, d.folder_id::text, d.company_id::text,
              d.mime_type, d.file_type, d.size_bytes, d.storage_path, d.content_hash,
              d.sector, d.competencia, d.tipo_fiscal, d.ocr_status, d.ocr_text,
              d.ocr_completed_at, d.uploaded_by::text, d.created_at, d.updated_at,
              d.deleted_original_folder_id::text
            FROM public.documents d
            WHERE d.id = $1 AND d.deleted_at IS NULL
            """,
            document_id,
        )

    @staticmethod
    async def patch_metadata(
        conn: asyncpg.Connection, document_id: UUID, *,
        name: str | None, sector: str | None, competencia, tipo_fiscal: str | None,
    ) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            UPDATE public.documents
            SET
              name        = COALESCE($2, name),
              sector      = COALESCE($3, sector),
              competencia = COALESCE($4, competencia),
              tipo_fiscal = COALESCE($5, tipo_fiscal),
              updated_at  = now()
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING
              id::text, name, folder_id::text, company_id::text,
              mime_type, file_type, size_bytes, sector, competencia,
              tipo_fiscal, ocr_status, created_at, updated_at
            """,
            document_id, name, sector, competencia, tipo_fiscal,
        )

    # -- delete / restore únicos -----------------------------------------------

    @staticmethod
    async def get_document_for_delete(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT d.id, d.folder_id, d.company_id, d.uploaded_by,
                   public.user_has_access(
                     auth.uid(),
                     (SELECT f.path FROM public.folders f WHERE f.id = d.folder_id),
                     d.company_id
                   ) AS permission
            FROM public.documents d
            WHERE d.id = $1 AND d.deleted_at IS NULL
            """,
            document_id,
        )

    @staticmethod
    async def soft_delete_single(admin_conn: asyncpg.Connection, document_id: UUID) -> None:
        await admin_conn.execute(
            """
            UPDATE public.documents d
            SET deleted_at = now(),
                deleted_original_folder_id = folder_id,
                trash_expires_at = now() + (c.retention_days || ' days')::interval
            FROM public.companies c
            WHERE d.id = $1 AND d.deleted_at IS NULL AND c.id = d.company_id
            """,
            document_id,
        )

    @staticmethod
    async def get_trashed_document(admin_conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            """
            SELECT id, folder_id, company_id, deleted_at,
                   deleted_original_folder_id
            FROM public.documents
            WHERE id = $1 AND deleted_at IS NOT NULL
            """,
            document_id,
        )

    @staticmethod
    async def find_folder_by_id(admin_conn: asyncpg.Connection, folder_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            "SELECT id, path, company_id FROM public.folders WHERE id = $1 AND deleted_at IS NULL",
            folder_id,
        )

    @staticmethod
    async def find_root_folder(admin_conn: asyncpg.Connection, company_id: UUID) -> asyncpg.Record | None:
        return await admin_conn.fetchrow(
            """
            SELECT id, path, company_id FROM public.folders
            WHERE company_id = $1 AND parent_id IS NULL AND deleted_at IS NULL
            ORDER BY created_at
            LIMIT 1
            """,
            company_id,
        )

    @staticmethod
    async def check_permission_for_path(admin_conn: asyncpg.Connection, user_id: str, path: str, company_id: UUID) -> str | None:
        return await admin_conn.fetchval(
            "SELECT public.user_has_access($1::uuid, $2::ltree, $3::uuid)",
            user_id, path, company_id,
        )

    @staticmethod
    async def restore_single(admin_conn: asyncpg.Connection, document_id: UUID, target_folder_id: UUID) -> asyncpg.Record:
        """I2: sincroniza company_id com o da pasta destino — o caller sempre
        resolve target_folder_id dentro da mesma empresa do documento hoje,
        mas o UPDATE não deve depender disso implicitamente."""
        return await admin_conn.fetchrow(
            """
            UPDATE public.documents d
            SET deleted_at = NULL,
                folder_id = $2,
                company_id = f.company_id,
                deleted_original_folder_id = NULL,
                updated_at = now()
            FROM public.folders f
            WHERE d.id = $1 AND f.id = $2
            RETURNING
              d.id::text, d.name, d.folder_id::text, d.company_id::text,
              d.mime_type, d.file_type, d.size_bytes, d.sector, d.competencia,
              d.tipo_fiscal, d.ocr_status, d.created_at, d.updated_at
            """,
            document_id, target_folder_id,
        )

    # -- OCR retry ------------------------------------------------------------

    @staticmethod
    async def get_document_for_ocr_retry(conn: asyncpg.Connection, document_id: UUID) -> asyncpg.Record | None:
        return await conn.fetchrow(
            """
            SELECT d.id, d.ocr_status, d.name,
                   public.user_has_access(
                     auth.uid(),
                     (SELECT f.path FROM public.folders f WHERE f.id = d.folder_id),
                     d.company_id
                   ) AS permission
            FROM public.documents d
            WHERE d.id = $1 AND d.deleted_at IS NULL
            """,
            document_id,
        )

    @staticmethod
    async def enqueue_ocr(admin_conn: asyncpg.Connection, document_id: UUID) -> None:
        """
        I3: único ponto do código que enfileira um novo ciclo de OCR — sempre os
        dois writes juntos (novo ocr_jobs + documents.ocr_status='pending').
        Chamado por retry manual, confirmação de upload de versão e restauração
        de versão. Centralizar aqui evita que os dois writes divirjam com o
        tempo se cada chamador reimplementasse o par de statements por conta própria.
        """
        await admin_conn.execute(
            "INSERT INTO public.ocr_jobs (document_id, status) VALUES ($1, 'pending')",
            document_id,
        )
        await admin_conn.execute(
            "UPDATE public.documents SET ocr_status = 'pending', updated_at = now() WHERE id = $1",
            document_id,
        )

    @staticmethod
    async def retry_ocr_transaction(admin_conn: asyncpg.Connection, document_id: UUID) -> None:
        async with admin_conn.transaction():
            await DocumentsService.enqueue_ocr(admin_conn, document_id)
