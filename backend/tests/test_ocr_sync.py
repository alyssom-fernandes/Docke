"""
M4.11 — T4: Sincronização ocr_jobs ↔ documents (invariante R3).

Verifica que:
1. Um documento confirmado (upload confirm) tem exatamente 1 job OCR pending.
2. Ao marcar o job como 'done', o documento reflete ocr_status='done' e ocr_text preenchido.
3. A atualização é atômica — não pode haver job 'done' com doc 'pending'.
"""
import uuid

import asyncpg
import pytest


@pytest.mark.asyncio
async def test_ocr_r3_invariant(admin, two_companies):
    co_a = two_companies["co_a"]
    user_a = two_companies["user_a"]

    # Cria pasta obrigatória (folder_id NOT NULL em documents)
    folder_id = str(uuid.uuid4())
    folder_path = f"ocrtestfolder{folder_id.replace('-','')[:10]}"
    await admin.execute(
        "INSERT INTO public.folders (id, name, company_id, path) VALUES ($1, 'ocr_test', $2, $3::ltree)",
        folder_id, co_a, folder_path,
    )

    doc_id = str(uuid.uuid4())
    storage_key = f"test/{doc_id}.pdf"

    # Insere documento + job em transação única (replica confirm endpoint)
    async with admin.transaction():
        await admin.execute(
            """
            INSERT INTO public.documents
              (id, name, folder_id, company_id, uploaded_by, storage_path,
               mime_type, file_type, size_bytes, content_hash, ocr_status)
            VALUES ($1, 'test_doc.pdf', $2, $3, $4, $5,
                    'application/pdf', 'pdf', 1024, $6, 'pending')
            """,
            doc_id, folder_id, co_a, user_a, storage_key, f"hash_{doc_id[:8]}",
        )
        await admin.execute(
            "INSERT INTO public.ocr_jobs (document_id, status, attempts) VALUES ($1, 'pending', 0)",
            doc_id,
        )

    # T4.1: Verifica estado inicial consistente
    doc = await admin.fetchrow("SELECT ocr_status FROM public.documents WHERE id = $1", doc_id)
    jobs = await admin.fetch("SELECT status FROM public.ocr_jobs WHERE document_id = $1", doc_id)

    assert doc["ocr_status"] == "pending"
    assert len(jobs) == 1
    assert jobs[0]["status"] == "pending"

    # T4.2: Simula worker processando — atualiza ambos na mesma transação (R3)
    ocr_text = "Nota Fiscal Eletrônica — Empresa A"
    async with admin.transaction():
        await admin.execute(
            "UPDATE public.documents SET ocr_text = $1, ocr_status = 'done' WHERE id = $2",
            ocr_text, doc_id,
        )
        await admin.execute(
            "UPDATE public.ocr_jobs SET status = 'done', finished_at = now() WHERE document_id = $1",
            doc_id,
        )

    doc_after = await admin.fetchrow("SELECT ocr_status, ocr_text FROM public.documents WHERE id = $1", doc_id)
    job_after = await admin.fetchrow("SELECT status FROM public.ocr_jobs WHERE document_id = $1", doc_id)

    assert doc_after["ocr_status"] == "done", "Documento deve ser 'done' após OCR"
    assert doc_after["ocr_text"] == ocr_text, "ocr_text deve estar preenchido"
    assert job_after["status"] == "done", "Job deve ser 'done' junto com o documento"

    # T4.3: Invariante R3 — não pode existir job 'done' com doc 'pending'
    pending_docs_with_done_jobs = await admin.fetchval(
        """
        SELECT COUNT(*) FROM public.ocr_jobs j
        JOIN public.documents d ON d.id = j.document_id
        WHERE j.status = 'done' AND d.ocr_status = 'pending'
        AND j.document_id = $1
        """,
        doc_id,
    )
    assert pending_docs_with_done_jobs == 0, "R3 violado: job done mas doc pending"

    # Cleanup
    await admin.execute("DELETE FROM public.ocr_jobs WHERE document_id = $1", doc_id)
    await admin.execute("DELETE FROM public.documents WHERE id = $1", doc_id)
    await admin.execute("DELETE FROM public.folders WHERE id = $1", folder_id)
