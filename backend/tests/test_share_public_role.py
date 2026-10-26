"""
Rotas públicas de link (/s/{token}/...) no papel docke_share_public
(migration 20261026000002, get_db_share_public): o papel alcança o que essas
rotas fazem — resolver o link, ler nome e versão do documento, gravar o acesso
e a notificação de link — e nada além. Roda numa transação revertida no fim.
"""
import uuid

import asyncpg
import pytest


@pytest.mark.asyncio
async def test_share_public_role_reaches_only_what_the_link_needs(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            company_id, user_id, folder_id, doc_id = (str(uuid.uuid4()) for _ in range(4))
            await conn.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Link Público')", company_id)
            await conn.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user_id, f"{user_id[:8]}@test.local")
            await conn.execute(
                "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Usuário Link', 'usuario')",
                user_id, f"publico_{user_id[:6]}",
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
                        $4, $5, 'done', 'texto sigiloso do OCR', now(), $6::uuid)
                """,
                doc_id, company_id, folder_id, f"documents/{company_id}/{doc_id}.pdf", "0" * 64, user_id,
            )
            token_hash = uuid.uuid4().hex
            share_id = str(await conn.fetchval(
                """
                INSERT INTO public.shares (resource_type, resource_id, company_id, token_hash, created_by)
                VALUES ('document', $1::uuid, $2::uuid, $3, $4::uuid)
                RETURNING id
                """,
                doc_id, company_id, token_hash, user_id,
            ))

            await conn.execute("SET LOCAL ROLE docke_share_public")

            # O que as rotas públicas fazem (SharesService e notification_service).
            row = await conn.fetchrow(
                "SELECT s.id, s.resource_type, s.resource_id, s.company_id, s.password_hash, s.expires_at,"
                " s.revoked_at, s.expired_at, s.pin_to_version_id FROM public.shares s WHERE s.token_hash = $1",
                token_hash,
            )
            assert str(row["id"]) == share_id
            assert await conn.fetchval("SELECT name FROM public.documents WHERE id = $1", doc_id) == "Contrato.pdf"
            await conn.execute(
                "INSERT INTO public.share_accesses (share_id, ip_hash, user_agent, success) VALUES ($1, 'ip', 'pytest', true)",
                share_id,
            )
            await conn.execute(
                "UPDATE public.shares SET view_count = view_count + 1, last_accessed_at = now() WHERE id = $1", share_id
            )
            await conn.execute(
                "INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, message)"
                " VALUES ($1, $2, 'share_accessed', 'document', $3, 'Seu link foi acessado 1 vez hoje.')",
                user_id, company_id, doc_id,
            )

            # E nada além: chave HMAC, usuários, texto do OCR, trilha de auditoria,
            # revogar link, outros tipos de notificação.
            for sql in (
                "SELECT key FROM public.activity_log_hmac_key",
                "SELECT username FROM public.users",
                "SELECT ocr_text FROM public.documents",
                "SELECT count(*) FROM public.activity_log",
                "UPDATE public.shares SET revoked_at = now()",
            ):
                with pytest.raises(asyncpg.InsufficientPrivilegeError):
                    async with conn.transaction():
                        await conn.execute(sql)
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                async with conn.transaction():
                    await conn.execute(
                        "INSERT INTO public.notifications (user_id, company_id, type, message)"
                        " VALUES ($1, $2, 'version_added', 'x')",
                        user_id, company_id,
                    )
        finally:
            await tr.rollback()
