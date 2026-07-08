"""
ADR-027 — Rate limiting em memória (dicionário com TTL).
Sem Redis: o volume de uso do Docke não justifica uma camada externa
(decisão explícita do adendo). Válido apenas para um único processo/máquina.
"""
import hashlib
import time
from collections import defaultdict

from fastapi import Request

_buckets: dict[str, list[float]] = defaultdict(list)
_lockouts: dict[str, float] = {}


def client_ip_hash(request: Request) -> str:
    """
    IP real do cliente para fins de rate-limit por IP.

    A Fly.io termina a conexão TCP na borda e encaminha pra máquina através
    da própria malha de rede — `request.client.host` normalmente reflete o
    IP interno da borda da Fly, não o do cliente real. Isso tornaria o
    bloqueio por IP um "balde" efetivamente compartilhado por todo mundo
    (um atacante travaria o login de todos, não só o dele). A Fly injeta o
    header `Fly-Client-IP` com o IP real do cliente antes de encaminhar a
    requisição — não é definido pelo cliente, então não pode ser forjado.
    Cai pra request.client.host só em dev local (sem o proxy da Fly).
    """
    ip = request.headers.get("fly-client-ip") or (request.client.host if request.client else "unknown")
    return hashlib.sha256(ip.encode()).hexdigest()


def _prune(bucket: list[float], window_seconds: int) -> None:
    cutoff = time.time() - window_seconds
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)


def check_and_record(key: str, max_count: int, window_seconds: int) -> bool:
    """Registra uma tentativa e retorna True se está dentro do limite."""
    bucket = _buckets[key]
    _prune(bucket, window_seconds)
    if len(bucket) >= max_count:
        return False
    bucket.append(time.time())
    return True


def is_locked_out(key: str) -> float | None:
    """Retorna segundos restantes de bloqueio, ou None se não está bloqueado."""
    until = _lockouts.get(key)
    if until is None:
        return None
    remaining = until - time.time()
    if remaining <= 0:
        del _lockouts[key]
        return None
    return remaining


def record_failed_attempt(key: str, max_attempts: int, window_seconds: int, lockout_seconds: int) -> bool:
    """
    Registra uma falha (ex: senha incorreta). Se exceder max_attempts dentro
    da janela, ativa o bloqueio e retorna True (bloqueio recém-ativado).
    """
    allowed = check_and_record(key, max_attempts, window_seconds)
    if not allowed:
        _lockouts[key] = time.time() + lockout_seconds
        return True
    return False
