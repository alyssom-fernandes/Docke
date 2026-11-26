"""
Montagem da exportação completa (app/services/export_service.py), sem banco e
sem storage: os ZIPs são abertos de volta e conferidos.
"""
import csv
import hashlib
import io
import zipfile
from datetime import datetime, timezone

from app.services.export_service import build_and_upload, folder_paths, safe_name

T = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)


def _doc(i, folder, name, content, *, hash_ok=True, path=None):
    return {
        "id": f"00000000-0000-0000-0000-{i:012d}", "folder_id": folder, "name": name,
        "mime_type": "application/pdf", "size_bytes": len(content or b""),
        "storage_path": path or f"documents/c/{i}.pdf",
        "content_hash": hashlib.sha256(content).hexdigest() if (content and hash_ok) else "0" * 64,
        "created_at": T, "updated_at": T, "ocr_status": "done", "enviado_por": "maria",
    }


def _cenario():
    folders = [
        {"id": "f1", "parent_id": None, "name": "Fiscal", "path": "a", "created_at": T},
        {"id": "f2", "parent_id": "f1", "name": "Notas: 2026", "path": "a.b", "created_at": T},
        {"id": "f3", "parent_id": None, "name": "RH", "path": "c", "created_at": T},
    ]
    blobs = {f"documents/c/{i}.pdf": bytes([i]) * 600 for i in range(1, 5)}
    docs = [
        _doc(1, "f1", "NF 1.pdf", blobs["documents/c/1.pdf"]),
        _doc(2, "f2", "NF 2.pdf", blobs["documents/c/2.pdf"]),
        _doc(3, "f3", "Holerite.pdf", blobs["documents/c/3.pdf"], hash_ok=False),
        _doc(4, "f3", "holerite.pdf", blobs["documents/c/4.pdf"]),  # mesmo nome ignorando maiúsculas
        _doc(5, "f3", "Sumiu.pdf", b"x", path="documents/c/nao-existe.pdf"),
    ]
    data = {
        "company": {"id": "c", "name": "Posto Exemplo Ltda", "cnpj": None},
        "folders": folders, "docs": docs,
        "fields": {docs[0]["id"]: ["Fornecedor=Distribuidora X", "Competência=11/2026"]},
        "trail": [{"created_at": T, "username": "maria", "action": "upload", "item_type": "document",
                   "item_name_snapshot": "NF 1.pdf", "ip": "10.0.0.1", "event_category": "document", "hash": "ab"}],
    }
    return data, blobs


def _run(part_limit):
    data, blobs = _cenario()
    enviados = {}

    def upload(key, path):
        enviados[key] = open(path, "rb").read()
        return len(enviados[key])

    result = build_and_upload(data, read_object=blobs.get, upload=upload, key_prefix="exports/c/e1",
                              part_limit=part_limit, now=T)
    return result, enviados


def test_caminhos_seguros_e_arvore():
    assert safe_name('Notas: 2026/11 "x"?') == "Notas_ 2026_11 _x__"
    paths = folder_paths(_cenario()[0]["folders"])
    assert paths == {"f1": "Fiscal", "f2": "Fiscal/Notas_ 2026", "f3": "RH"}


def test_uma_parte_com_manifesto_trilha_e_conferencia():
    result, enviados = _run(part_limit=10_000_000)
    assert len(result["parts"]) == 1 and result["document_count"] == 5
    assert result["hash_mismatches"] == 2  # um hash divergente e um arquivo ausente
    z = zipfile.ZipFile(io.BytesIO(next(iter(enviados.values()))))
    nomes = set(z.namelist())
    assert {"LEIA-ME.txt", "estrutura-de-pastas.csv", "trilha-de-auditoria.csv", "manifesto.csv"} <= nomes
    assert "documentos/Fiscal/Notas_ 2026/NF 2.pdf" in nomes
    assert "documentos/RH/Holerite.pdf" in nomes and "documentos/RH/holerite (2).pdf" in nomes

    linhas = list(csv.reader(io.StringIO(z.read("manifesto.csv").decode("utf-8-sig")), delimiter=";"))
    cab, dados = linhas[0], {r[3]: dict(zip(linhas[0], r)) for r in linhas[1:]}
    assert cab[:4] == ["parte", "caminho_no_zip", "pasta", "nome"]
    assert dados["NF 1.pdf"]["confere"] == "sim"
    assert dados["NF 1.pdf"]["metadados"] == "Fornecedor=Distribuidora X | Competência=11/2026"
    assert dados["Holerite.pdf"]["confere"] == "não"
    assert dados["Sumiu.pdf"]["confere"] == "arquivo ausente no armazenamento"
    assert z.read("documentos/Fiscal/NF 1.pdf") == bytes([1]) * 600


def test_divide_em_partes_e_o_manifesto_vai_na_ultima():
    result, enviados = _run(part_limit=1300)  # cabem 2 arquivos de 600 bytes por parte
    assert [p["documents"] for p in result["parts"]] == [2, 2]
    assert [p["name"] for p in result["parts"]] == [
        "docke-posto-exemplo-ltda-2026-11-01-parte-1.zip", "docke-posto-exemplo-ltda-2026-11-01-parte-2.zip",
    ]
    primeira = zipfile.ZipFile(io.BytesIO(enviados["exports/c/e1/" + result["parts"][0]["name"]]))
    ultima = zipfile.ZipFile(io.BytesIO(enviados["exports/c/e1/" + result["parts"][1]["name"]]))
    assert "trilha-de-auditoria.csv" in primeira.namelist() and "manifesto.csv" not in primeira.namelist()
    assert "manifesto.csv" in ultima.namelist()
