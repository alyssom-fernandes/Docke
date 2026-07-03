"""
Seed do modo demo — M5.1.

Usa conexão direta com service role (asyncpg), sem RLS, conforme R1/Parte3.
NUNCA exposto como endpoint HTTP — executado como script administrativo:

    python -m app.seed.demo_data

Dados criados:
  - 1 usuário demo  (username=demo@docke.app, admin nas 3 empresas)
  - 3 empresas fictícias
  - 4 pastas raiz por empresa (Fiscal, RH, Bancário, Contratos)
  - ~50 documentos distribuídos (ocr=done maioria, 2-3 failed, 3 na lixeira)
  - activity_log simulado nos últimos 7 dias
"""

from __future__ import annotations

import asyncio
import hashlib
import random
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg
import httpx

from app.config import settings


# ---------------------------------------------------------------------------
# Dados fictícios
# ---------------------------------------------------------------------------

COMPANIES = [
    ("Comércio Alfa Modelo Ltda",   "CNPJ: 12.345.678/0001-90"),
    ("Serviços Beta Referência SA", "CNPJ: 23.456.789/0001-01"),
    ("Indústria Gama Exemplo Ltda", "CNPJ: 34.567.890/0001-12"),
]

FOLDERS = ["Fiscal", "RH", "Bancário", "Contratos"]

# (name_template, ext, folder_index)
DOCUMENTS = [
    ("NF-e_Fornecedor_{n}.xml",     "xml",  0),
    ("SPED_Fiscal_{n}.txt",          "txt",  0),
    ("DCTF_Mensal_{n}.pdf",          "pdf",  0),
    ("Extrato_Banco_{n}.pdf",        "pdf",  2),
    ("Conciliação_{n}.xlsx",         "xlsx", 2),
    ("Boleto_{n}.pdf",               "pdf",  2),
    ("Contrato_Prestação_{n}.docx",  "docx", 3),
    ("Procuração_{n}.pdf",           "pdf",  3),
    ("Aditivo_{n}.docx",             "docx", 3),
    ("Holerite_{n}.pdf",             "pdf",  1),
    ("Admissão_{n}.pdf",             "pdf",  1),
    ("Rescisão_{n}.pdf",             "pdf",  1),
    ("Planilha_RH_{n}.xlsx",         "xlsx", 1),
    ("Imagem_Doc_{n}.jpg",           "jpg",  0),
    ("Relatorio_{n}.pdf",            "pdf",  2),
]

OCR_TEXTS = [
    "Nota fiscal eletrônica emitida em conformidade com a legislação vigente. "
    "CNPJ emitente: 12.345.678/0001-90. Valor total: R$ 1.250,00.",
    "Relatório de conciliação bancária referente ao período. "
    "Saldo inicial: R$ 50.000,00. Saldo final: R$ 48.750,00.",
    "Contrato de prestação de serviços firmado entre as partes. "
    "Vigência: 12 meses. Valor mensal: R$ 3.000,00.",
    "Folha de pagamento dos colaboradores. Total de funcionários: 8. "
    "Total bruto: R$ 32.000,00. INSS: R$ 3.520,00.",
    "Declaração de Débitos e Créditos Tributários Federais. "
    "Competência: mês de referência. PIS/COFINS: R$ 1.800,00.",
    "Extrato bancário consolidado. Créditos: R$ 85.000,00. Débitos: R$ 72.000,00.",
    "Aditivo contratual alterando o prazo de vigência por mais 6 meses.",
    "Documento de rescisão de contrato de trabalho. Aviso prévio cumprido.",
    "Imagem digitalizada de documento original. Conteúdo verificado.",
    "Sped Fiscal — Registro C100. Valor das operações: R$ 45.000,00.",
]

DEMO_USER_USERNAME = "demo@docke.app"
DEMO_USER_FULLNAME = "Usuário Demo"
DEMO_USER_EMAIL = "demo@docke.app"
DEMO_USER_PASSWORD = "DockeDemo2026!"

ACTIONS = ["upload", "view", "download", "view", "view", "download"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def fake_hash(name: str, company_id: str) -> str:
    return hashlib.sha256(f"{name}{company_id}{random.random()}".encode()).hexdigest()


def rand_date(days_back: int = 7) -> datetime:
    delta = timedelta(seconds=random.randint(0, days_back * 86400))
    return datetime.now(timezone.utc) - delta


def make_label() -> str:
    return "f" + str(int(datetime.now(timezone.utc).timestamp() * 1000)) + str(random.randint(1000, 9999))


# ---------------------------------------------------------------------------
# Main seed
# ---------------------------------------------------------------------------

async def _ensure_demo_auth_account() -> str:
    """
    Garante que existe uma conta real no Supabase Auth para o usuário demo
    (mesmo padrão do ADR-033 em companies.py: Admin API, email_confirm=True,
    sem disparar e-mail de convite). Idempotente: se já existir, reaproveita
    o id em vez de recriar — evita acumular contas órfãs no Auth a cada reset.
    """
    async with httpx.AsyncClient() as client:
        # ATENÇÃO: a Admin API do GoTrue/Supabase NÃO filtra por e-mail via
        # query param — ela ignora silenciosamente qualquer parâmetro
        # desconhecido e devolve a listagem padrão. Filtrar do lado do
        # cliente é obrigatório aqui; usar existing[0] sem filtrar pegaria
        # o primeiro usuário da lista (ex: a conta admin real de produção),
        # não necessariamente o usuário demo. Isso já causou um incidente
        # real (senha e nome da conta admin real sobrescritos) — nunca
        # remover este filtro explícito por e-mail.
        list_resp = await client.get(
            f"{settings.SUPABASE_URL}/auth/v1/admin/users",
            headers={
                "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
            },
            params={"per_page": 200},
            timeout=10.0,
        )
        all_users = list_resp.json().get("users", []) if list_resp.status_code == 200 else []
        existing = [u for u in all_users if u.get("email", "").lower() == DEMO_USER_EMAIL.lower()]
        if existing:
            user_id = existing[0]["id"]
            await client.put(
                f"{settings.SUPABASE_URL}/auth/v1/admin/users/{user_id}",
                headers={
                    "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
                    "Content-Type": "application/json",
                },
                json={"password": DEMO_USER_PASSWORD},
                timeout=10.0,
            )
            return user_id

        create_resp = await client.post(
            f"{settings.SUPABASE_URL}/auth/v1/admin/users",
            headers={
                "apikey": settings.SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
            },
            json={"email": DEMO_USER_EMAIL, "password": DEMO_USER_PASSWORD, "email_confirm": True},
            timeout=10.0,
        )
        if create_resp.status_code not in (200, 201):
            raise RuntimeError(f"Falha ao criar conta demo no Supabase Auth: {create_resp.text}")
        return create_resp.json()["id"]


async def run_seed() -> None:
    demo_user_id = await _ensure_demo_auth_account()
    print(f"✔ Conta demo no Supabase Auth pronta (id={demo_user_id[:8]}…).")

    conn = await asyncpg.connect(settings.asyncpg_url)
    print("✔ Conectado ao banco de dados.")

    try:
        await conn.execute("BEGIN")

        # ------------------------------------------------------------------
        # 0. Limpar dados de demo anteriores (idempotente) — mantém o
        #    usuário demo (mesmo id do Auth), só limpa as empresas fictícias.
        # ------------------------------------------------------------------
        await conn.execute(
            "DELETE FROM public.companies WHERE name = ANY($1::text[])",
            [c[0] for c in COMPANIES],
        )
        print("✔ Dados anteriores removidos.")

        # ------------------------------------------------------------------
        # 1. Criar/atualizar usuário demo em public.users (mesmo id do Auth)
        # ------------------------------------------------------------------
        await conn.execute(
            """
            INSERT INTO public.users (id, username, full_name, role)
            VALUES ($1::uuid, $2, $3, 'admin')
            ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name
            """,
            demo_user_id,
            DEMO_USER_USERNAME,
            DEMO_USER_FULLNAME,
        )
        print(f"✔ Usuário demo criado: {DEMO_USER_USERNAME} (id={demo_user_id[:8]}…)")

        for company_name, _ in COMPANIES:
            # ---------------------------------------------------------------
            # 2. Criar empresa
            # ---------------------------------------------------------------
            company_id = str(uuid.uuid4())
            await conn.execute(
                "INSERT INTO public.companies (id, name) VALUES ($1::uuid, $2)",
                company_id,
                company_name,
            )

            # ---------------------------------------------------------------
            # 3. Conceder acesso admin ao usuário demo
            # ---------------------------------------------------------------
            await conn.execute(
                """
                INSERT INTO public.user_company_access
                    (user_id, company_id, permission_level, folder_path)
                VALUES ($1::uuid, $2::uuid, 'admin', NULL)
                """,
                demo_user_id,
                company_id,
            )

            # ---------------------------------------------------------------
            # 4. Criar pastas raiz
            # ---------------------------------------------------------------
            folder_ids: list[str] = []
            for folder_name in FOLDERS:
                folder_id = str(uuid.uuid4())
                label = make_label()
                await conn.execute(
                    """
                    INSERT INTO public.folders
                        (id, company_id, parent_id, path, name, created_by)
                    VALUES ($1::uuid, $2::uuid, NULL, $3::ltree, $4, $5::uuid)
                    """,
                    folder_id,
                    company_id,
                    label,
                    folder_name,
                    demo_user_id,
                )
                folder_ids.append(folder_id)
                await asyncio.sleep(0.001)  # garante labels distintos

            # ---------------------------------------------------------------
            # 5. Criar documentos
            # ---------------------------------------------------------------
            docs_created: list[tuple[str, str]] = []  # (doc_id, name)

            for i in range(1, 18):  # ~17 docs por empresa → ~51 total
                tmpl, ext, folder_idx = random.choice(DOCUMENTS)
                doc_name = tmpl.format(n=str(i).zfill(2))
                folder_id = folder_ids[folder_idx]

                doc_id = str(uuid.uuid4())
                size = random.randint(50_000, 5_000_000)
                content_hash = fake_hash(doc_name, company_id)
                ocr_text = random.choice(OCR_TEXTS)

                # 2 docs com OCR failed, 3 na lixeira (para os últimos docs)
                if i >= 16:
                    ocr_status = "failed"
                    ocr_text = None
                elif i == 15:
                    ocr_status = "failed"
                    ocr_text = None
                else:
                    ocr_status = "done"

                deleted_at = None
                deleted_original_folder_id = None
                if i >= 14 and i <= 16:
                    # Coloca na lixeira (soft-delete) — só para os últimos 3
                    deleted_at = rand_date(5)
                    deleted_original_folder_id = folder_id

                ts_search = (
                    f"to_tsvector('portuguese', unaccent('{ocr_text[:200]}'))"
                    if ocr_text
                    else "to_tsvector('portuguese', '')"
                )

                mime_map = {
                    "pdf": "application/pdf",
                    "xml": "application/xml",
                    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "jpg": "image/jpeg",
                    "txt": "text/plain",
                }
                mime_type = mime_map.get(ext, "application/octet-stream")

                created_at = rand_date(30)

                await conn.execute(
                    """
                    INSERT INTO public.documents
                        (id, company_id, folder_id, name, mime_type, file_type, size_bytes,
                         storage_path, content_hash, ocr_status, ocr_text,
                         ocr_completed_at, deleted_at, deleted_original_folder_id,
                         uploaded_by, created_at)
                    VALUES
                        ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
                         $8, $9, $10, $11,
                         $12, $13, $14,
                         $15::uuid, $16)
                    """,
                    doc_id,
                    company_id,
                    folder_id,
                    doc_name,
                    mime_type,
                    ext,
                    size,
                    f"documents/{company_id}/{doc_id}.{ext}",
                    content_hash,
                    ocr_status,
                    ocr_text,
                    datetime.now(timezone.utc) if ocr_status == "done" else None,
                    deleted_at,
                    deleted_original_folder_id,
                    demo_user_id,
                    created_at,
                )
                docs_created.append((doc_id, doc_name))

            # ---------------------------------------------------------------
            # 6. Atividade simulada (últimos 7 dias)
            # ---------------------------------------------------------------
            non_deleted_docs = [d for d in docs_created if docs_created.index(d) < 13]
            for _ in range(20):
                doc_id, doc_name = random.choice(non_deleted_docs)
                action = random.choice(ACTIONS)
                await conn.execute(
                    """
                    INSERT INTO public.activity_log
                        (user_id, company_id, action, item_type, item_id,
                         item_name_snapshot, created_at)
                    VALUES ($1::uuid, $2::uuid, $3, 'document', $4::uuid, $5, $6)
                    """,
                    demo_user_id,
                    company_id,
                    action,
                    doc_id,
                    doc_name,
                    rand_date(7),
                )

            print(f"  ✔ {company_name}: {len(docs_created)} docs, {len(folder_ids)} pastas")

        await conn.execute("COMMIT")
        print("\n✅ Seed concluído com sucesso!")
        print(f"   Login demo: {DEMO_USER_EMAIL} / {DEMO_USER_PASSWORD}")
        print("   Empresas: Comércio Alfa Modelo Ltda | Serviços Beta Referência SA | Indústria Gama Exemplo Ltda")

    except Exception as exc:
        await conn.execute("ROLLBACK")
        print(f"\n❌ Erro durante o seed: {exc}")
        raise
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(run_seed())
