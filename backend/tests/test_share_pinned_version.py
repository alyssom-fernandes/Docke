"""
Exclusão definitiva de documento com link fixado numa versão.

Antes da migration 20261026000001, shares.pin_to_version_id não tinha
ON DELETE: o DELETE em documents (lixeira, purge, retenção, reset da demo)
estourava ForeignKeyViolationError ao cascatear para document_versions.
Roda numa transação revertida no fim.
"""
import uuid

import pytest


@pytest.mark.asyncio
async def test_deleting_document_removes_link_pinned_to_its_version(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            company_id, user_id, folder_id, doc_id = (str(uuid.uuid4()) for _ in range(4))
            await conn.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Link Fixado')", company_id)
            await conn.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user_id, f"{user_id[:8]}@test.local")
            await conn.execute(
                "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Usuário Link', 'usuario')",
                user_id, f"link_{user_id[:6]}",
            )
            await conn.execute(
                "INSERT INTO public.folders (id, company_id, parent_id, path, name, created_by) "
                "VALUES ($1::uuid, $2::uuid, NULL, $3::ltree, 'Contratos', $4::uuid)",
                folder_id, company_id, f"f{folder_id.replace('-', '')}", user_id,
            )
            await conn.execute(
                """
                INSERT INTO public.documents
                    (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                     storage_path, content_hash, ocr_status, ocr_text, ocr_completed_at, uploaded_by)
                VALUES ($1::uuid, $2::uuid, $3::uuid, 'Contrato.pdf', 'application/pdf', 'pdf', 10,
                        $4, $5, 'done', '', now(), $6::uuid)
                """,
                doc_id, company_id, folder_id, f"documents/{company_id}/{doc_id}.pdf", "0" * 64, user_id,
            )
            version_id = await conn.fetchval(
                """
                INSERT INTO public.document_versions
                    (document_id, version_number, storage_key, size_bytes, mime_type, ocr_text, ocr_status, uploaded_by)
                VALUES ($1::uuid, 1, $2, 10, 'application/pdf', '', 'done', $3::uuid)
                RETURNING id
                """,
                doc_id, f"documents/{company_id}/{doc_id}.pdf", user_id,
            )
            await conn.execute("UPDATE public.documents SET current_version_id = $2 WHERE id = $1", doc_id, version_id)
            share_id = await conn.fetchval(
                """
                INSERT INTO public.shares
                    (resource_type, resource_id, company_id, token_hash, pin_to_version_id, created_by)
                VALUES ('document', $1::uuid, $2::uuid, $3, $4, $5::uuid)
                RETURNING id
                """,
                doc_id, company_id, uuid.uuid4().hex, version_id, user_id,
            )

            # Exclusão definitiva — o mesmo DELETE da lixeira/purge/retenção.
            await conn.execute("DELETE FROM public.documents WHERE id = $1", doc_id)

            assert await conn.fetchval("SELECT count(*) FROM public.document_versions WHERE id = $1", version_id) == 0
            assert await conn.fetchval("SELECT count(*) FROM public.shares WHERE id = $1", share_id) == 0
        finally:
            await tr.rollback()
