"""FA-A4-03: lista de documentos paginada por cursor (sem OFFSET)."""
import datetime

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_retencao_v2 import _doc, empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


async def _todas(api, h, e, sort, direcao):  # noqa: F811
    nomes, cursor = [], None
    for _ in range(10):
        params = {"company_id": e["co"], "folder_id": e["fiscal"], "limit": 2, "sort": sort, "dir": direcao}
        if cursor:
            params["cursor"] = cursor
        r = await api.get(API + "/documents", params=params, headers=h)
        assert r.status_code == 200, r.text
        nomes += [d["name"] for d in r.json()]
        cursor = r.headers.get("x-next-cursor")
        if not cursor:
            break
    return nomes


@pytest.mark.asyncio
async def test_cursor_percorre_tudo_sem_repetir(api, admin, empresa):  # noqa: F811
    h = _token(empresa["user"])
    base = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    nomes = ["Bravo.pdf", "alfa.pdf", "Charlie.pdf", "delta.pdf", "Eco.pdf"]
    for i, n in enumerate(nomes):
        await _doc(admin, empresa, empresa["fiscal"], n, base + datetime.timedelta(days=i))
    esperado = sorted(nomes, key=str.lower)
    assert await _todas(api, h, empresa, "name", "asc") == esperado
    assert await _todas(api, h, empresa, "name", "desc") == esperado[::-1]
    # Por data, do mais novo ao mais antigo.
    assert await _todas(api, h, empresa, "created_at", "desc") == nomes[::-1]
    # Cursor estragado é recusado com mensagem clara.
    r = await api.get(API + "/documents", params={"company_id": empresa["co"], "folder_id": empresa["fiscal"], "limit": 2, "cursor": "xx"}, headers=h)
    assert r.status_code == 422
