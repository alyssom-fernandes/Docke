"""
NF-e lida no ato do envio (benchmark FA-A4-12, B1.1.10, B2.5.5, B2.5.6).

O worker de miniaturas chama `processar_pendentes` a cada volta: todo XML ainda
sem linha em document_nfe é lido uma vez. Sendo NF-e/NFC-e, guarda a chave e o
cabeçalho da nota e preenche tipo fiscal e competência do documento quando
estiverem vazios (sem IA e sem OCR: o dado vem do próprio XML, 100% preciso).
"""
import asyncio
import logging
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

import asyncpg

logger = logging.getLogger("docke.nfe")

_XML_MIMES = ("application/xml", "text/xml")
_LOTE = 20


def ler(xml_bytes: bytes) -> dict[str, Any] | None:
    """Campos da nota a partir do XML; None quando não é NF-e/NFC-e."""
    from app.services.documents_service import _NFE_NS, DocumentsService
    from app.services.file_signature import safe_xml_fromstring

    campos = DocumentsService.extract_nfe_fields(xml_bytes)
    if not campos:
        return None
    modelo = None
    try:
        root = safe_xml_fromstring(xml_bytes)
        el = root.find(".//nfe:infNFe/nfe:ide/nfe:mod", _NFE_NS)
        modelo = el.text.strip() if el is not None and el.text else None
    except Exception:
        pass
    chave = "".join(ch for ch in (campos.get("chave_acesso") or "") if ch.isdigit())
    campos["chave"] = chave if len(chave) == 44 else None
    campos["modelo"] = modelo
    return campos


def _data(valor: str | None) -> datetime | None:
    if not valor:
        return None
    try:
        return datetime.fromisoformat(valor)
    except ValueError:
        try:
            return datetime.combine(date.fromisoformat(valor[:10]), datetime.min.time())
        except ValueError:
            return None


def _valor(texto: str | None) -> Decimal | None:
    if not texto:
        return None
    try:
        return Decimal(texto).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return None


async def gravar(conn: asyncpg.Connection, document_id, company_id, campos: dict[str, Any] | None) -> None:
    if campos is None:
        await conn.execute(
            "INSERT INTO public.document_nfe (document_id, company_id, reconhecida) VALUES ($1, $2, false) "
            "ON CONFLICT (document_id) DO NOTHING",
            document_id, company_id,
        )
        return
    emissao = _data(campos.get("data_emissao"))
    await conn.execute(
        """
        INSERT INTO public.document_nfe (
          document_id, company_id, reconhecida, chave, modelo, numero, serie, data_emissao, natureza_operacao,
          emitente_cnpj, emitente_nome, destinatario_doc, destinatario_nome, valor_total)
        VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (document_id) DO UPDATE SET
          reconhecida = true, chave = EXCLUDED.chave, modelo = EXCLUDED.modelo, numero = EXCLUDED.numero,
          serie = EXCLUDED.serie, data_emissao = EXCLUDED.data_emissao, natureza_operacao = EXCLUDED.natureza_operacao,
          emitente_cnpj = EXCLUDED.emitente_cnpj, emitente_nome = EXCLUDED.emitente_nome,
          destinatario_doc = EXCLUDED.destinatario_doc, destinatario_nome = EXCLUDED.destinatario_nome,
          valor_total = EXCLUDED.valor_total, lida_em = now()
        """,
        document_id, company_id, campos.get("chave"), campos.get("modelo"), campos.get("numero"), campos.get("serie"),
        emissao, campos.get("natureza_operacao"), campos.get("emitente_cnpj"), campos.get("emitente_nome"),
        campos.get("destinatario_cnpj"), campos.get("destinatario_nome"), _valor(campos.get("valor_total")),
    )
    # Tipo fiscal e competência só quando estão vazios: o que alguém já
    # preencheu à mão prevalece.
    tipo = "NFC-e" if campos.get("modelo") == "65" else "NF-e"
    competencia = date(emissao.year, emissao.month, 1) if emissao else None
    await conn.execute(
        """
        UPDATE public.documents
        SET tipo_fiscal = coalesce(tipo_fiscal, $2), competencia = coalesce(competencia, $3)
        WHERE id = $1 AND (tipo_fiscal IS NULL OR (competencia IS NULL AND $3::date IS NOT NULL))
        """,
        document_id, tipo, competencia,
    )


async def processar_pendentes(conn: asyncpg.Connection) -> int:
    """Lê os XMLs ainda não lidos (novos primeiro). Devolve quantos leu."""
    from app.services import storage_service

    rows = await conn.fetch(
        """
        SELECT d.id, d.company_id, d.storage_path
        FROM public.documents d
        LEFT JOIN public.document_nfe n ON n.document_id = d.id
        WHERE n.document_id IS NULL AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
          AND d.mime_type = ANY($1::text[])
        ORDER BY d.created_at DESC
        LIMIT $2
        """,
        list(_XML_MIMES), _LOTE,
    )
    feitos = 0
    for r in rows:
        try:
            dados = await asyncio.to_thread(storage_service.read_object, r["storage_path"])
        except Exception:
            logger.warning("NF-e: não foi possível ler o XML do doc %s.", r["id"])
            continue
        if dados is None:
            continue
        await gravar(conn, r["id"], r["company_id"], ler(dados))
        feitos += 1
    return feitos


async def da_nota(conn: asyncpg.Connection, document_id) -> dict[str, Any] | None:
    """Dados da nota e as outras cópias da mesma chave na empresa (RLS do chamador)."""
    row = await conn.fetchrow(
        """
        SELECT chave, modelo, numero, serie, data_emissao, natureza_operacao, emitente_cnpj, emitente_nome,
               destinatario_doc, destinatario_nome, valor_total, company_id
        FROM public.document_nfe WHERE document_id = $1 AND reconhecida
        """,
        document_id,
    )
    if row is None:
        return None
    nota = dict(row)
    nota["valor_total"] = float(nota["valor_total"]) if nota["valor_total"] is not None else None
    duplicatas: list[dict[str, Any]] = []
    if nota["chave"]:
        dups = await conn.fetch(
            """
            SELECT d.id::text, d.name, d.folder_id::text, f.name AS folder_name
            FROM public.document_nfe n
            JOIN public.documents d ON d.id = n.document_id AND d.deleted_at IS NULL
            JOIN public.folders f ON f.id = d.folder_id
            WHERE n.company_id = $1 AND n.chave = $2 AND n.document_id <> $3
            ORDER BY d.created_at
            LIMIT 10
            """,
            nota["company_id"], nota["chave"], document_id,
        )
        duplicatas = [dict(d) for d in dups]
    nota.pop("company_id")
    nota["duplicatas"] = duplicatas
    return nota
