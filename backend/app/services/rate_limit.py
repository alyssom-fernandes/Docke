"""
ADR-027 — Rate limiting em memória (dicionário com TTL).
Sem Redis: o volume de uso do Docke não justifica uma camada externa
(decisão explícita do adendo). Válido apenas para um único processo/máquina.
"""
import time
from collections import defaultdict

_buckets: dict[str, list[float]] = defaultdict(list)
_lockouts: dict[str, float] = {}


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
