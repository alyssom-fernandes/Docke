"""
Lixeira, legal hold e retenção travada (achados A6-37, X2-04, X3-07 e A5-65 da
avaliação de 25/11/2026). Cada teste roda numa transação revertida no fim.

- A lista da lixeira só mostra o que saiu de pastas que a pessoa enxerga.
- Restaurar uma pasta traz de volta os documentos que foram com ela, e só eles.
- Documento sob legal hold ou com retenção travada vigente não vai para a
  lixeira, não é apagado, não perde versão e é pulado pela purga automática.
"""
import uuid

import asyncpg
import pytest

from app.services.folders_service import FoldersService
from app.services.trash_service import TrashService


async def _base(conn):
    """Empresa com as pastas Fiscal (com a subpasta Notas) e RH, e um admin."""
    co, user = str(uuid.uuid4()), str(uuid.uuid4())
    await conn.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Empresa Lixeira')", co)
    await conn.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", user, f"{user[:8]}@test.local")
    await conn.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Admin Lixeira', 'usuario')",
        user, f"lixeira_{user[:6]}",
    )
    await conn.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')",
        user, co,
    )
    pastas = {}
    for nome, pai in (("Fiscal", None), ("Notas", "Fiscal"), ("RH", None)):
        fid = str(uuid.uuid4())
        label = "f" + fid.replace("-", "")
        path = f"{pastas[pai]['path']}.{label}" if pai else label
        await conn.execute(
            "INSERT INTO public.folders (id, company_id, parent_id, path, name, created_by) "
            "VALUES ($1, $2, $3, $4::ltree, $5, $6)",
            fid, co, pastas[pai]["id"] if pai else None, path, nome, user,
        )
        pastas[nome] = {"id": fid, "path": path}
    return co, user, pastas


async def _doc(conn, co, user, folder_id, nome, *, deleted_at_sql="NULL"):
    did = str(uuid.uuid4())
    await conn.execute(
        f"""
        INSERT INTO public.documents
            (id, company_id, folder_id, name, mime_type, file_type, size_bytes, storage_path,
             content_hash, ocr_status, uploaded_by, deleted_at, deleted_original_folder_id, trash_expires_at)
        VALUES ($1, $2, $3, $4, 'application/pdf', 'pdf', 10, $5, $6, 'done', $7,
                {deleted_at_sql}, CASE WHEN {deleted_at_sql} IS NULL THEN NULL ELSE $3::uuid END,
                CASE WHEN {deleted_at_sql} IS NULL THEN NULL ELSE now() + interval '30 days' END)
        """,
        did, co, folder_id, nome, f"documents/{co}/{did}.pdf", uuid.uuid4().hex * 2, user,
    )
    await conn.execute(
        "INSERT INTO public.document_versions (document_id, version_number, storage_key, size_bytes, mime_type, uploaded_by)"
        " VALUES ($1, 1, $2, 10, 'application/pdf', $3), ($1, 2, $2 || '.v2', 10, 'application/pdf', $3)",
        did, f"documents/{co}/{did}.pdf", user,
    )
    return did


async def _ativo(conn, doc_id) -> bool:
    return await conn.fetchval("SELECT deleted_at IS NULL FROM public.documents WHERE id = $1", doc_id)


@pytest.mark.asyncio
async def test_lixeira_lista_so_o_que_saiu_de_pastas_com_acesso(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            co, admin_user, pastas = await _base(conn)
            await _doc(conn, co, admin_user, pastas["Fiscal"]["id"], "Nota fiscal.pdf", deleted_at_sql="now()")
            await _doc(conn, co, admin_user, pastas["RH"]["id"], "Holerite.pdf", deleted_at_sql="now()")

            fiscal_only = str(uuid.uuid4())
            await conn.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", fiscal_only, f"{fiscal_only[:8]}@test.local")
            await conn.execute(
                "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Só Fiscal', 'usuario')",
                fiscal_only, f"fiscal_{fiscal_only[:6]}",
            )
            await conn.execute(
                "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path)"
                " VALUES ($1, $2, 'operador', $3::ltree)",
                fiscal_only, co, pastas["Fiscal"]["path"],
            )

            nomes_admin = {r["name"] for r in await TrashService.list_deleted_documents(conn, co, admin_user)}
            nomes_fiscal = {r["name"] for r in await TrashService.list_deleted_documents(conn, co, fiscal_only)}
            assert nomes_admin == {"Nota fiscal.pdf", "Holerite.pdf"}
            assert nomes_fiscal == {"Nota fiscal.pdf"}
        finally:
            await tr.rollback()


@pytest.mark.asyncio
async def test_restaurar_pasta_traz_os_documentos_que_foram_com_ela(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            co, user, pastas = await _base(conn)
            d1 = await _doc(conn, co, user, pastas["Fiscal"]["id"], "NF 1.pdf")
            d2 = await _doc(conn, co, user, pastas["Notas"]["id"], "NF 2.pdf")
            # Excluído por conta própria antes da pasta: continua na lixeira.
            d3 = await _doc(conn, co, user, pastas["Fiscal"]["id"], "Rascunho.pdf", deleted_at_sql="now() - interval '1 hour'")

            await FoldersService.soft_delete_folder_cascade(conn, pastas["Fiscal"]["path"])
            assert not await _ativo(conn, d1) and not await _ativo(conn, d2)

            pasta = await TrashService.get_deleted_folder(conn, pastas["Fiscal"]["id"])
            voltaram = await TrashService.restore_folder_cascade(
                conn, folder_id=pasta["id"], new_parent_id=None, path=str(pasta["path"]), deleted_at=pasta["deleted_at"],
            )
            assert voltaram == 2
            assert await _ativo(conn, d1) and await _ativo(conn, d2)
            assert not await _ativo(conn, d3)
            assert await conn.fetchval(
                "SELECT count(*) FROM public.folders WHERE company_id = $1 AND deleted_at IS NOT NULL", co
            ) == 0
        finally:
            await tr.rollback()


@pytest.mark.asyncio
async def test_legal_hold_bloqueia_lixeira_exclusao_e_versao(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            co, user, pastas = await _base(conn)
            doc = await _doc(conn, co, user, pastas["Fiscal"]["id"], "Contrato sob hold.pdf")
            outro = await _doc(conn, co, user, pastas["Fiscal"]["id"], "Outro.pdf")
            hold = await conn.fetchval(
                "INSERT INTO public.legal_holds (company_id, resource_type, resource_id, reason, created_by)"
                " VALUES ($1, 'document', $2, 'Processo trabalhista', $3) RETURNING id",
                co, doc, user,
            )

            for sql in (
                "UPDATE public.documents SET deleted_at = now() WHERE id = $1",
                "DELETE FROM public.documents WHERE id = $1",
                "DELETE FROM public.document_versions WHERE document_id = $1 AND version_number = 1",
            ):
                with pytest.raises(asyncpg.exceptions.RaiseError, match="DOCKE_EXCLUSAO_BLOQUEADA:legal_hold:Contrato sob hold.pdf"):
                    async with conn.transaction():
                        await conn.execute(sql, doc)

            # A pasta com um documento sob hold também não vai para a lixeira, e nada muda.
            with pytest.raises(asyncpg.exceptions.RaiseError):
                await FoldersService.soft_delete_folder_cascade(conn, pastas["Fiscal"]["path"])
            assert await _ativo(conn, outro)
            assert await conn.fetchval("SELECT deleted_at IS NULL FROM public.folders WHERE id = $1", pastas["Fiscal"]["id"])

            # Liberado o hold, a exclusão volta a funcionar.
            await conn.execute("UPDATE public.legal_holds SET released_at = now() WHERE id = $1", hold)
            await conn.execute("UPDATE public.documents SET deleted_at = now() WHERE id = $1", doc)
            assert not await _ativo(conn, doc)
        finally:
            await tr.rollback()


@pytest.mark.asyncio
async def test_retencao_travada_vigente_bloqueia_e_vencida_libera(admin_pool):
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            co, user, pastas = await _base(conn)
            doc = await _doc(conn, co, user, pastas["RH"]["id"], "Ficha de registro.pdf")
            politica = await conn.fetchval(
                "INSERT INTO public.retention_policies (company_id, name, duration_months, locked, created_by)"
                " VALUES ($1, 'CLT 5 anos', 60, true, $2) RETURNING id",
                co, user,
            )
            await conn.execute(
                "INSERT INTO public.retention_policy_assignments (company_id, folder_path, policy_id, created_by)"
                " VALUES ($1, $2::ltree, $3, $4)",
                co, pastas["RH"]["path"], politica, user,
            )
            with pytest.raises(asyncpg.exceptions.RaiseError, match="DOCKE_EXCLUSAO_BLOQUEADA:retencao"):
                async with conn.transaction():
                    await conn.execute("UPDATE public.documents SET deleted_at = now() WHERE id = $1", doc)

            # Prazo vencido (documento de 6 anos atrás): pode sair.
            await conn.execute("UPDATE public.documents SET created_at = now() - interval '6 years' WHERE id = $1", doc)
            await conn.execute("UPDATE public.documents SET deleted_at = now() WHERE id = $1", doc)
            assert not await _ativo(conn, doc)

            # Política não travada não bloqueia nada.
            doc2 = await _doc(conn, co, user, pastas["RH"]["id"], "Recibo.pdf")
            await conn.execute("UPDATE public.retention_policies SET locked = false WHERE id = $1", politica)
            await conn.execute("UPDATE public.documents SET deleted_at = now() WHERE id = $1", doc2)
            assert not await _ativo(conn, doc2)
        finally:
            await tr.rollback()


@pytest.mark.asyncio
async def test_purga_automatica_pula_documento_sob_hold(admin_pool, monkeypatch):
    from app.services import storage_service
    from app.workers import maintenance_worker

    monkeypatch.setattr(storage_service, "delete_object", lambda *_a, **_k: None)
    async with admin_pool.acquire() as conn:
        tr = conn.transaction()
        await tr.start()
        try:
            co, user, pastas = await _base(conn)
            protegido = await _doc(conn, co, user, pastas["Fiscal"]["id"], "Protegido.pdf", deleted_at_sql="now() - interval '40 days'")
            comum = await _doc(conn, co, user, pastas["Fiscal"]["id"], "Comum.pdf", deleted_at_sql="now() - interval '40 days'")
            await conn.execute(
                "UPDATE public.documents SET trash_expires_at = now() - interval '1 day' WHERE id = ANY($1::uuid[])",
                [protegido, comum],
            )
            await conn.execute(
                "INSERT INTO public.legal_holds (company_id, resource_type, resource_id, reason, created_by)"
                " VALUES ($1, 'folder', $2, 'Fiscalização', $3)",
                co, pastas["Fiscal"]["id"], user,
            )
            await maintenance_worker._purge_expired_trash(conn)
            assert await conn.fetchval("SELECT count(*) FROM public.documents WHERE id = $1", protegido) == 1
            # O hold é na pasta: o outro documento dela também fica.
            assert await conn.fetchval("SELECT count(*) FROM public.documents WHERE id = $1", comum) == 1

            await conn.execute("UPDATE public.legal_holds SET released_at = now() WHERE company_id = $1", co)
            await maintenance_worker._purge_expired_trash(conn)
            assert await conn.fetchval(
                "SELECT count(*) FROM public.documents WHERE id = ANY($1::uuid[])", [protegido, comum]
            ) == 0
        finally:
            await tr.rollback()
