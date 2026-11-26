"""
Batimento dos workers (achado X3-11): cada laço marca quando passou por
aqui; /health/workers diz se algum parou. Um worker parado não derruba a
máquina (o /health continua "ok" para a Fly), mas fica visível para quem
monitora, em vez de a fila de OCR ou de exportação parar em silêncio.
"""
import time

# Quanto tempo sem batimento até considerar o worker atrasado (segundos).
LIMITES = {"ocr": 300, "exportacao": 300, "estatisticas": 1800, "manutencao": 7200}

_ultimo: dict[str, float] = {}
_inicio = time.time()


def beat(nome: str) -> None:
    _ultimo[nome] = time.time()


def snapshot() -> dict:
    agora = time.time()
    workers = {}
    for nome, limite in LIMITES.items():
        t = _ultimo.get(nome)
        if t is None:
            estado = "iniciando" if agora - _inicio < limite else "parado"
            workers[nome] = {"estado": estado, "segundos_desde": None}
        else:
            idade = int(agora - t)
            workers[nome] = {"estado": "ok" if idade <= limite else "atrasado", "segundos_desde": idade}
    geral = "ok" if all(w["estado"] in ("ok", "iniciando") for w in workers.values()) else "degradado"
    return {"status": geral, "workers": workers}
