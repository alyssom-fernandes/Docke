"""Comparação de versões por partes: arquivo, páginas, anotações e metadados (B2.7.5)."""
import io
import json
import uuid

import pytest

from app.routers.version_compare import comparar_paginas
from app.services import storage_service
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


def test_comparar_paginas():
    assert comparar_paginas(["a", "b", "c"], ["a", "B"]) == {"antes": 3, "depois": 2, "alteradas": [2], "incluidas": [], "removidas": [3]}
    assert comparar_paginas(["a"], ["a", "x"])["incluidas"] == [2]


def _pdf(n: int) -> bytes:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument.new()
    for _ in range(n):
        pdf.new_page(200, 300)
    buf = io.BytesIO()
    pdf.save(buf)
    pdf.close()
    return buf.getvalue()


@pytest.mark.asyncio
async def test_resumo_por_partes(api, admin, empresa):  # noqa: F811
    if not storage_service.is_mock():
        pytest.skip("precisa do storage simulado")
    h = _token(empresa["user"])
    doc = uuid.UUID(await _doc(admin, empresa, empresa["raiz"], "Contrato.pdf", "contrato"))
    ids = []
    for n, paginas in ((1, 2), (2, 3)):
        key = f"{empresa['co']}/comp-{uuid.uuid4().hex}.pdf"
        storage_service.put_object_bytes(key, _pdf(paginas), "application/pdf")
        ids.append(await admin.fetchval(
            "INSERT INTO public.document_versions (document_id, version_number, storage_key, size_bytes, mime_type, uploaded_by, created_at)"
            " VALUES ($1, $2, $3, 10, 'application/pdf', $4, now() - make_interval(hours => $5)) RETURNING id",
            doc, n, key, uuid.UUID(empresa["user"]), 10 - n * 5,
        ))
    await admin.execute(
        "INSERT INTO public.document_comments (company_id, document_id, version_id, user_id, body, page, x, y) VALUES ($1, $2, $3, $4, 'Rubricar', 1, 0.5, 0.5)",
        uuid.UUID(empresa["co"]), doc, ids[0], uuid.UUID(empresa["user"]),
    )
    await admin.execute(
        "INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata, created_at)"
        " VALUES ($1, $2, 'update_metadata', 'document', $3, 'Contrato.pdf', 'metadata', $4::jsonb, now() - interval '3 hours')",
        uuid.UUID(empresa["user"]), uuid.UUID(empresa["co"]), doc, json.dumps({"field_label": "Vigência", "old_value": "2025", "new_value": "2026"}),
    )
    r = await api.get(API + f"/documents/{doc}/versions/compare-summary", params={"a": str(ids[1]), "b": str(ids[0])}, headers=h)
    assert r.status_code == 200, r.text
    j = r.json()
    assert (j["versao_antes"], j["versao_depois"]) == (1, 2)
    assert j["paginas"]["antes"] == 2 and j["paginas"]["depois"] == 3 and j["paginas"]["incluidas"] == [3]
    assert [x["body"] for x in j["anotacoes"]["antes"]] == ["Rubricar"] and j["anotacoes"]["depois"] == []
    assert j["metadados"][0]["campo"] == "Vigência" and j["metadados"][0]["depois"] == "2026"
    await admin.execute("DELETE FROM public.activity_log WHERE item_id = $1", doc)
