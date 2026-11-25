"""
Exportação completa de uma empresa (achado X2-16 da avaliação de 25/11/2026).

Gera um ou mais ZIPs (partes de até ~1 GB) com:
- documentos/<árvore de pastas>/<arquivo>: todos os documentos fora da lixeira;
- manifesto.csv (na última parte): caminho no ZIP, pasta, nome, tipo, tamanho,
  SHA-256 registrado e o conferido na exportação, datas, quem enviou, situação
  do texto e os metadados — serve de relatório de conferência;
- estrutura-de-pastas.csv e trilha-de-auditoria.csv (na primeira parte);
- LEIA-ME.txt explicando o conteúdo e como conferir os hashes.

Os CSV usam ponto e vírgula e BOM UTF-8 (abrem direto no Excel em português).
Cada parte sobe para o storage assim que fecha e o arquivo local é apagado: o
disco da máquina nunca guarda mais que uma parte por vez.
"""
from __future__ import annotations

import csv
import hashlib
import io
import os
import re
import tempfile
import unicodedata
import zipfile
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import UUID

import asyncpg

PART_LIMIT_BYTES = 1_000_000_000
EXPORT_TTL_DAYS = 7
_INVALID = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def safe_name(name: str) -> str:
    """Nome que abre em Windows, macOS e Linux (sem / \\ : * ? " < > |)."""
    n = _INVALID.sub("_", name or "").strip().rstrip(".")
    return (n or "_")[:150]


def slug(text: str) -> str:
    t = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", t).strip("-").lower()[:40] or "empresa"


def folder_paths(folders: list[dict]) -> dict[str, str]:
    """id da pasta → "Fiscal/Notas", seguindo parent_id."""
    by_id = {str(f["id"]): f for f in folders}
    cache: dict[str, str] = {}

    def path(fid: str, depth: int = 0) -> str:
        if fid in cache:
            return cache[fid]
        f = by_id.get(fid)
        if f is None or depth > 64:
            return ""
        parent = str(f["parent_id"]) if f["parent_id"] else None
        own = safe_name(f["name"])
        full = f"{path(parent, depth + 1)}/{own}" if parent and parent in by_id else own
        cache[fid] = full
        return full

    return {fid: path(fid) for fid in by_id}


async def gather(conn: asyncpg.Connection, company_id: UUID) -> dict[str, Any]:
    company = await conn.fetchrow("SELECT id, name, cnpj FROM public.companies WHERE id = $1", company_id)
    folders = [dict(r) for r in await conn.fetch(
        "SELECT id, parent_id, name, path::text AS path, created_at FROM public.folders"
        " WHERE company_id = $1 AND deleted_at IS NULL ORDER BY path",
        company_id,
    )]
    docs = [dict(r) for r in await conn.fetch(
        """
        SELECT d.id, d.folder_id, d.name, d.mime_type, d.size_bytes, d.storage_path, d.content_hash,
               d.created_at, d.updated_at, d.ocr_status, u.username AS enviado_por
        FROM public.documents d
        LEFT JOIN public.users u ON u.id = d.uploaded_by
        WHERE d.company_id = $1 AND d.deleted_at IS NULL AND d.content_hash IS NOT NULL
        ORDER BY d.folder_id, d.name
        """,
        company_id,
    )]
    fields: dict[str, list[str]] = {}
    for r in await conn.fetch(
        """
        SELECT dfv.document_id, cf.label, dfv.value_text
        FROM public.document_field_value dfv
        JOIN public.custom_field cf ON cf.id = dfv.custom_field_id
        WHERE dfv.company_id = $1
        ORDER BY cf.label
        """,
        company_id,
    ):
        fields.setdefault(str(r["document_id"]), []).append(f"{r['label']}={r['value_text']}")
    trail = [dict(r) for r in await conn.fetch(
        """
        SELECT a.created_at, u.username, a.action, a.item_type, a.item_name_snapshot, a.ip::text AS ip,
               a.event_category, encode(a.hash, 'hex') AS hash
        FROM public.activity_log a
        LEFT JOIN public.users u ON u.id = a.user_id
        WHERE a.company_id = $1
        ORDER BY a.created_at, a.id
        """,
        company_id,
    )]
    return {"company": dict(company), "folders": folders, "docs": docs, "fields": fields, "trail": trail}


def _csv_bytes(header: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
    w.writerow(header)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


def _iso(value) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    return str(value)


def _leia_me(company: dict, n_docs: int, gerado: datetime) -> bytes:
    return (
        f"Exportação completa do Docke — {company['name']}\r\n"
        f"Gerada em {gerado.strftime('%d/%m/%Y %H:%M')} (UTC), com {n_docs} documento(s).\r\n\r\n"
        "Conteúdo:\r\n"
        "- documentos/: os arquivos, na mesma árvore de pastas do Docke (itens da lixeira não entram).\r\n"
        "- manifesto.csv (na última parte): um documento por linha, com o caminho dentro do ZIP, o SHA-256\r\n"
        "  registrado no envio, o SHA-256 conferido agora e se os dois batem, datas, quem enviou e metadados.\r\n"
        "- estrutura-de-pastas.csv e trilha-de-auditoria.csv (nesta primeira parte).\r\n\r\n"
        "Para conferir um arquivo: calcule o SHA-256 dele (no Windows: certutil -hashfile ARQUIVO SHA256;\r\n"
        "no macOS e Linux: shasum -a 256 ARQUIVO) e compare com a coluna sha256_registrado do manifesto.\r\n"
    ).encode("utf-8")


def build_and_upload(
    data: dict[str, Any],
    *,
    read_object: Callable[[str], bytes | None],
    upload: Callable[[str, str], int],
    key_prefix: str,
    part_limit: int = PART_LIMIT_BYTES,
    now: datetime | None = None,
) -> dict[str, Any]:
    """
    Monta as partes e sobe cada uma assim que fecha. `upload(key, path)` envia o
    arquivo e devolve o tamanho. Roda numa thread (E/S bloqueante).
    """
    now = now or datetime.now(timezone.utc)
    company, docs = data["company"], data["docs"]
    paths = folder_paths(data["folders"])
    base = f"docke-{slug(company['name'])}-{now.strftime('%Y-%m-%d')}"
    parts: list[dict[str, Any]] = []
    manifest: list[list[Any]] = []
    used_names: set[str] = set()
    mismatches = 0
    total_bytes = 0

    with tempfile.TemporaryDirectory(prefix="docke-export-") as workdir:
        state: dict[str, Any] = {"zf": None, "path": None, "size": 0, "docs": 0}

        def open_part() -> None:
            n = len(parts) + 1
            state["path"] = os.path.join(workdir, f"{base}-parte-{n}.zip")
            state["zf"] = zipfile.ZipFile(state["path"], "w", compression=zipfile.ZIP_STORED, allowZip64=True)
            state["size"], state["docs"] = 0, 0
            if n == 1:
                state["zf"].writestr("LEIA-ME.txt", _leia_me(company, len(docs), now), zipfile.ZIP_DEFLATED)
                state["zf"].writestr("estrutura-de-pastas.csv", _csv_bytes(
                    ["caminho", "criada_em"],
                    [[paths.get(str(f["id"]), ""), _iso(f["created_at"])] for f in data["folders"]],
                ), zipfile.ZIP_DEFLATED)
                state["zf"].writestr("trilha-de-auditoria.csv", _csv_bytes(
                    ["data_hora", "usuario", "acao", "tipo_item", "item", "ip", "categoria", "hash"],
                    [[_iso(t["created_at"]), t["username"] or "", t["action"], t["item_type"],
                      t["item_name_snapshot"], t["ip"] or "", t["event_category"], t["hash"] or ""]
                     for t in data["trail"]],
                ), zipfile.ZIP_DEFLATED)

        def close_part(final: bool) -> None:
            zf = state["zf"]
            if final:
                zf.writestr("manifesto.csv", _csv_bytes(
                    ["parte", "caminho_no_zip", "pasta", "nome", "tipo", "tamanho_bytes", "sha256_registrado",
                     "sha256_conferido", "confere", "enviado_em", "atualizado_em", "enviado_por",
                     "texto_extraido", "metadados", "id_docke"],
                    manifest,
                ), zipfile.ZIP_DEFLATED)
            zf.close()
            name = os.path.basename(state["path"])
            size = upload(f"{key_prefix}/{name}", state["path"])
            os.remove(state["path"])
            parts.append({"key": f"{key_prefix}/{name}", "name": name, "size_bytes": size, "documents": state["docs"]})

        open_part()
        for doc in docs:
            content = read_object(doc["storage_path"])
            folder = paths.get(str(doc["folder_id"]), "")
            arc = f"documentos/{folder}/{safe_name(doc['name'])}" if folder else f"documentos/{safe_name(doc['name'])}"
            base_arc, n = arc, 2
            while arc.lower() in used_names:
                stem, dot, ext = base_arc.rpartition(".")
                arc = f"{stem} ({n}).{ext}" if dot else f"{base_arc} ({n})"
                n += 1
            used_names.add(arc.lower())

            if content is None:
                conferido, confere = "", "arquivo ausente no armazenamento"
                mismatches += 1
            else:
                if state["docs"] > 0 and state["size"] + len(content) > part_limit:
                    close_part(final=False)
                    open_part()
                conferido = hashlib.sha256(content).hexdigest()
                confere = "sim" if conferido == (doc["content_hash"] or "") else "não"
                if confere != "sim":
                    mismatches += 1
                info = zipfile.ZipInfo(arc, date_time=doc["created_at"].astimezone(timezone.utc).timetuple()[:6])
                info.compress_type = zipfile.ZIP_STORED
                state["zf"].writestr(info, content)
                state["size"] += len(content)
                state["docs"] += 1
                total_bytes += len(content)
            manifest.append([
                len(parts) + 1, arc if content is not None else "", folder, doc["name"], doc["mime_type"],
                doc["size_bytes"], doc["content_hash"] or "", conferido, confere, _iso(doc["created_at"]),
                _iso(doc["updated_at"]), doc["enviado_por"] or "", doc["ocr_status"],
                " | ".join(data["fields"].get(str(doc["id"]), [])), str(doc["id"]),
            ])
        close_part(final=True)

    return {"parts": parts, "document_count": len(docs), "total_bytes": total_bytes, "hash_mismatches": mismatches}
