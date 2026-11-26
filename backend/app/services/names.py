"""
Regras de nome de pasta e de documento (achado A4-40 da avaliação de 25/11/2026):
o renomear já barrava caracteres inválidos e duplicados, mas criar pasta não.
Agora a mesma regra vale em toda criação, renomeação e movimento.
"""
import re

from fastapi import HTTPException, status

FORBIDDEN = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
MAX_LEN = 150


def clean_name(raw: str, *, kind: str = "pasta") -> str:
    name = " ".join((raw or "").split())
    if not name:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Dê um nome para a {kind}.")
    if name in (".", "..") or name.endswith("."):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="O nome não pode terminar com ponto.")
    if FORBIDDEN.search(name):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail='O nome não pode ter \\ / : * ? " < > | (o Windows e o macOS não aceitam).',
        )
    if len(name) > MAX_LEN:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=f"Use no máximo {MAX_LEN} caracteres.")
    return name
