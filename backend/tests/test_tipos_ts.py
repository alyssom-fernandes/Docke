"""Os tipos do frontend (frontend/src/lib/api-types.ts) batem com o OpenAPI da API (X3-16)."""
import difflib

from scripts.gerar_tipos_ts import DESTINO, texto_atual


def test_tipos_do_frontend_em_dia():
    esperado = texto_atual()
    assert DESTINO.exists(), f"{DESTINO} não existe: rode python scripts/gerar_tipos_ts.py em backend/."
    atual = DESTINO.read_text(encoding="utf-8").replace("\r\n", "\n")
    if atual != esperado:
        diferenca = "".join(difflib.unified_diff(
            atual.splitlines(keepends=True), esperado.splitlines(keepends=True),
            fromfile="api-types.ts (no repositório)", tofile="api-types.ts (gerado agora)", n=1,
        ))
        raise AssertionError(
            "frontend/src/lib/api-types.ts está desatualizado: em backend/, rode "
            "python scripts/gerar_tipos_ts.py e inclua o arquivo no commit.\n" + diferenca[:6000]
        )
