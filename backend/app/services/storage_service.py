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
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.config import settings

# Diretório do mock — usa TMPDIR do sistema para não poluir o projeto
MOCK_DIR = Path(tempfile.gettempdir()) / "docke_mock_storage"
MOCK_DIR.mkdir(parents=True, exist_ok=True)

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
    safe_key = key.replace("/", "__")
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
    safe_key = key.replace("/", "__")
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
    safe_key = key.replace("/", "__")
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
    safe_key = key.replace("/", "__")
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
        disposition = f'attachment; filename="{filename}"'
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

    safe_key = key.replace("/", "__")
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
    safe_key = key.replace("/", "__")
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
    safe_key = key.replace("/", "__")
    path = MOCK_DIR / safe_key
    if not path.exists():
        return None
    return path.read_bytes()


def is_mock() -> bool:
    return not _r2_configured
