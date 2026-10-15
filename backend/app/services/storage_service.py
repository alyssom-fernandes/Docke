"""
StorageService — abstração sobre Cloudflare R2 (boto3/S3) com fallback mock.

Dois modos:
- R2 real: quando R2_ENDPOINT_URL, R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY estão configurados.
- Mock local: quando qualquer credencial está vazia. Salva arquivos em
  MOCK_DIR e gera URLs apontando para o endpoint interno de mock.

Invariante: nenhuma rota de usuário chama boto3 diretamente — só via este serviço.
"""

import hashlib
import os
import re
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

from app.config import settings


def _content_disposition(disposition_type: str, filename: str) -> str:
    """
    Monta o header Content-Disposition com filename escapado (aspas e barras
    invertidas removidas, nunca interpoladas cruas) + fallback filename*
    RFC 5987 pra nomes com acentos/caracteres não-ASCII.
    """
    safe = filename.replace("\\", "").replace('"', "")
    return f'{disposition_type}; filename="{safe}"; filename*=UTF-8\'\'{quote(filename)}'

# Diretório do mock — usa TMPDIR do sistema para não poluir o projeto
MOCK_DIR = Path(tempfile.gettempdir()) / "docke_mock_storage"
MOCK_DIR.mkdir(parents=True, exist_ok=True)

# Chaves do mock viram nome de arquivo dentro de MOCK_DIR. Só letras, números,
# ponto, hífen e sublinhado — sem isso, uma chave com ".." ou "\\" (separador
# no Windows) escaparia de MOCK_DIR pelas rotas mock, que não pedem token.
_MOCK_KEY_RE = re.compile(r"^[A-Za-z0-9._-]{1,255}$")


def is_valid_mock_key(safe_key: str) -> bool:
    return bool(_MOCK_KEY_RE.match(safe_key)) and ".." not in safe_key


def _mock_key(key: str) -> str:
    safe_key = key.replace("/", "__")
    if not is_valid_mock_key(safe_key):
        raise ValueError("Chave inválida para o mock storage.")
    return safe_key


_r2_configured = all([
    settings.R2_ENDPOINT_URL,
    settings.R2_ACCESS_KEY_ID,
    settings.R2_SECRET_ACCESS_KEY,
])

if _r2_configured:
    import boto3
    _s3 = boto3.client(
        "s3",
        endpoint_url=settings.R2_ENDPOINT_URL,
        aws_access_key_id=settings.R2_ACCESS_KEY_ID,
        aws_secret_access_key=settings.R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )
else:
    _s3 = None


def storage_key(company_id: str, document_id: str, ext: str) -> str:
    """Canonical storage path: documents/{company_id}/{document_id}.{ext}"""
    return f"documents/{company_id}/{document_id}.{ext}"


def put_object_bytes(key: str, data: bytes, content_type: str) -> None:
    """
    Upload direto (sem presigned URL) — uso interno de scripts administrativos
    (ex: seed do modo demo), nunca chamado a partir de rotas de usuário.
    """
    if _r2_configured:
        _s3.put_object(Bucket=settings.R2_BUCKET_NAME, Key=key, Body=data, ContentType=content_type)
        return
    mock_save(key, data)


def generate_upload_url(
    key: str,
    content_type: str,
    expires_in: int = 900,
) -> tuple[str, datetime]:
    """
    Gera URL pré-assinada para upload direto ao bucket.
    Retorna (upload_url, expires_at).
    """
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

    if _r2_configured:
        url = _s3.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.R2_BUCKET_NAME,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=expires_in,
        )
        return url, expires_at

    # Mock: aponta para endpoint interno do backend (PUT /api/v1/documents/mock-upload/:key)
    safe_key = _mock_key(key)
    url = f"http://localhost:8000/api/v1/documents/mock-upload/{safe_key}"
    return url, expires_at


def head_object(key: str) -> dict | None:
    """
    Verifica se o objeto existe no bucket.
    Retorna dict com metadados ou None se não existir.
    """
    if _r2_configured:
        try:
            return _s3.head_object(Bucket=settings.R2_BUCKET_NAME, Key=key)
        except Exception:
            return None

    # Mock: verifica no filesystem
    safe_key = _mock_key(key)
    path = MOCK_DIR / safe_key
    if path.exists():
        stat = path.stat()
        return {"ContentLength": stat.st_size}
    return None


def compute_sha256(key: str) -> str | None:
    """
    Calcula SHA-256 do objeto armazenado.
    Para R2: faz streaming do objeto (evita memória inteira para 50MB).
    Para mock: lê do filesystem.
    Retorna None se o objeto não existir.
    """
    if _r2_configured:
        try:
            response = _s3.get_object(Bucket=settings.R2_BUCKET_NAME, Key=key)
            sha256 = hashlib.sha256()
            for chunk in response["Body"].iter_chunks(chunk_size=65_536):
                sha256.update(chunk)
            return sha256.hexdigest()
        except Exception:
            return None

    # Mock: lê arquivo local
    safe_key = _mock_key(key)
    path = MOCK_DIR / safe_key
    if not path.exists():
        return None
    sha256 = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65_536), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def mock_save(key: str, data: bytes) -> None:
    """Salva dados no mock storage (chamado pelo endpoint interno de upload)."""
    safe_key = _mock_key(key)
    path = MOCK_DIR / safe_key
    path.write_bytes(data)


def generate_download_url(
    key: str,
    filename: str,
    content_type: str,
    expires_in: int = 3600,  # 1 hora
) -> tuple[str, datetime]:
    """
    Gera URL pré-assinada para download (Content-Disposition: attachment).
    Expira em 1 hora por padrão.
    """
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

    if _r2_configured:
        disposition = _content_disposition("attachment", filename)
        url = _s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": settings.R2_BUCKET_NAME,
                "Key": key,
                "ResponseContentDisposition": disposition,
                "ResponseContentType": content_type,
            },
            ExpiresIn=expires_in,
        )
        return url, expires_at

    safe_key = _mock_key(key)
    safe_filename = filename.replace('"', "").replace("/", "_")
    url = f"http://localhost:8000/api/v1/documents/mock-download/{safe_key}?filename={safe_filename}"
    return url, expires_at


def generate_preview_url(
    key: str,
    content_type: str,
    expires_in: int = 300,  # 5 minutos
) -> tuple[str, datetime]:
    """
    Gera URL pré-assinada para visualização inline (GET).
    Content-Disposition: inline — para abrir no browser em vez de baixar.
    Expira em 5 minutos por padrão.
    """
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

    if _r2_configured:
        url = _s3.generate_presigned_url(
            "get_object",
            Params={
                "Bucket": settings.R2_BUCKET_NAME,
                "Key": key,
                "ResponseContentDisposition": "inline",
                "ResponseContentType": content_type,
            },
            ExpiresIn=expires_in,
        )
        return url, expires_at

    # Mock: aponta para endpoint interno de preview
    safe_key = _mock_key(key)
    url = f"http://localhost:8000/api/v1/documents/mock-preview/{safe_key}"
    return url, expires_at


def read_object(key: str) -> bytes | None:
    """
    Lê o conteúdo completo de um objeto do storage.
    Para R2: faz GET e retorna os bytes (max 50MB).
    Para mock: lê do filesystem.
    Retorna None se o objeto não existir.
    """
    if _r2_configured:
        try:
            response = _s3.get_object(Bucket=settings.R2_BUCKET_NAME, Key=key)
            return response["Body"].read()
        except Exception:
            return None
    return mock_read(key)


def mock_read(key: str) -> bytes | None:
    """Lê arquivo do mock storage. Retorna None se não existir."""
    safe_key = _mock_key(key)
    path = MOCK_DIR / safe_key
    if not path.exists():
        return None
    return path.read_bytes()


def copy_object(source_key: str, dest_key: str) -> None:
    """
    Duplica um objeto já existente pra uma nova key, sem baixar/re-subir pelo
    cliente — usado por "copiar estrutura de pastas" ao levar os documentos
    junto (o R2 copia server-to-server; o mock replica o arquivo local).
    """
    if _r2_configured:
        _s3.copy_object(
            Bucket=settings.R2_BUCKET_NAME,
            CopySource={"Bucket": settings.R2_BUCKET_NAME, "Key": source_key},
            Key=dest_key,
        )
        return
    data = mock_read(source_key)
    if data is not None:
        mock_save(dest_key, data)


def delete_object(key: str) -> None:
    """
    Remove o objeto do storage (I11: exclusão permanente deve remover o
    arquivo físico, nunca deixar órfão indefinidamente). Silenciosa se o
    objeto já não existir — exclusão permanente é sempre idempotente.
    """
    if _r2_configured:
        _s3.delete_object(Bucket=settings.R2_BUCKET_NAME, Key=key)
        return
    safe_key = _mock_key(key)
    (MOCK_DIR / safe_key).unlink(missing_ok=True)


def is_mock() -> bool:
    return not _r2_configured


# ---------------------------------------------------------------------------
# Fase 12.1 — pipeline de derivados: DOCX/XLSX (e variantes .doc/.xls) não têm
# preview nativo no navegador, então convertemos pra PDF uma vez (via
# LibreOffice headless) e cacheamos o resultado no storage — conversões
# seguintes pro mesmo documento reaproveitam o PDF já gerado.
# ---------------------------------------------------------------------------

import subprocess
import uuid as _uuid

_CONVERTIBLE_EXTENSIONS = {"docx", "doc", "xlsx", "xls"}


def derivative_pdf_key(original_key: str) -> str:
    """derivatives/{mesmo caminho}.pdf — 1:1 com o objeto original."""
    return f"derivatives/{original_key}.pdf"


def convert_office_to_pdf(source_key: str, ext: str) -> bytes | None:
    """
    Baixa o objeto original, converte pra PDF via `soffice --headless` (timeout
    de 60s — documentos grandes/complexos podem ser lentos, mas isso é uma
    conversão sob demanda numa requisição HTTP, não pode ficar pendurado pra
    sempre) e devolve os bytes do PDF gerado. None se a conversão falhar.
    """
    if ext not in _CONVERTIBLE_EXTENSIONS:
        return None

    source_bytes = read_object(source_key)
    if source_bytes is None:
        return None

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = os.path.join(tmpdir, f"{_uuid.uuid4()}.{ext}")
        with open(input_path, "wb") as f:
            f.write(source_bytes)
        try:
            subprocess.run(
                ["soffice", "--headless", "--norestore", "--convert-to", "pdf", "--outdir", tmpdir, input_path],
                check=True, timeout=60, capture_output=True,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
            return None

        output_path = os.path.splitext(input_path)[0] + ".pdf"
        if not os.path.exists(output_path):
            return None
        with open(output_path, "rb") as f:
            return f.read()


# ---------------------------------------------------------------------------
# Fase 11.1 — multipart upload real: cada parte tem sua própria URL
# pré-assinada (S3 multipart API, suportado pelo R2 nativamente).
# ---------------------------------------------------------------------------

def create_multipart_upload(key: str, content_type: str) -> str:
    """Abre um multipart upload no storage e devolve o upload_id."""
    if _r2_configured:
        resp = _s3.create_multipart_upload(Bucket=settings.R2_BUCKET_NAME, Key=key, ContentType=content_type)
        return resp["UploadId"]
    # Mock: não precisa de upload_id real — as partes ficam em arquivos
    # separados no filesystem (key.part1, key.part2...) até o complete.
    return "mock-upload"


def generate_part_upload_url(key: str, upload_id: str, part_number: int, expires_in: int = 3600) -> str:
    """URL pré-assinada de PUT pra uma parte específica (1-indexed, como no S3)."""
    if _r2_configured:
        return _s3.generate_presigned_url(
            "upload_part",
            Params={"Bucket": settings.R2_BUCKET_NAME, "Key": key, "UploadId": upload_id, "PartNumber": part_number},
            ExpiresIn=expires_in,
        )
    safe_key = _mock_key(key)
    return f"http://localhost:8000/api/v1/documents/mock-upload-part/{safe_key}/{part_number}"


def complete_multipart_upload(key: str, upload_id: str, parts: list[dict]) -> None:
    """parts: [{"PartNumber": int, "ETag": str}, ...] — ordem não importa aqui,
    é reordenado por PartNumber antes de enviar (S3 exige ordem crescente)."""
    ordered = sorted(parts, key=lambda p: p["PartNumber"])
    if _r2_configured:
        _s3.complete_multipart_upload(
            Bucket=settings.R2_BUCKET_NAME, Key=key, UploadId=upload_id,
            MultipartUpload={"Parts": ordered},
        )
        return
    # Mock: concatena os arquivos de parte na ordem certa e limpa os temporários.
    safe_key = _mock_key(key)
    out_path = MOCK_DIR / safe_key
    with open(out_path, "wb") as out:
        for p in ordered:
            part_path = MOCK_DIR / f"{safe_key}.part{p['PartNumber']}"
            if part_path.exists():
                out.write(part_path.read_bytes())
                part_path.unlink()


def abort_multipart_upload(key: str, upload_id: str) -> None:
    """Cancela um multipart upload abandonado — sempre melhor esforço (mesmo
    padrão de delete_object), nunca deve travar o fluxo de cancelamento."""
    if _r2_configured:
        _s3.abort_multipart_upload(Bucket=settings.R2_BUCKET_NAME, Key=key, UploadId=upload_id)
        return
    safe_key = _mock_key(key)
    for part_path in MOCK_DIR.glob(f"{safe_key}.part*"):
        part_path.unlink(missing_ok=True)
