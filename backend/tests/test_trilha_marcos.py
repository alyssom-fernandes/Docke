"""X3-12: marcos diários da trilha assinados pela API, conferidos na verificação."""
import datetime
import json
import uuid

import pytest

from app.services.activity_service import ActivityService
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_retencao_v2 import empresa  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


async def _evento(admin, e):
    await admin.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
        VALUES ($1::uuid, $2::uuid, 'audit_verify', 'config', $2::uuid, 'Trilha de auditoria', 'config', $3::jsonb)
        """,
        e["user"], e["co"], json.dumps({"teste": True}),
    )


@pytest.mark.asyncio
async def test_marco_assinado_confere_e_pega_reescrita(api, admin, empresa):  # noqa: F811
    co = uuid.UUID(empresa["co"])
    await _evento(admin, empresa)
    assert await ActivityService.gravar_marcos(admin) >= 1
    # Uma segunda rodada no mesmo dia não grava outro marco da mesma empresa.
    await _evento(admin, empresa)
    await ActivityService.gravar_marcos(admin)
    assert await admin.fetchval("SELECT count(*) FROM public.activity_log_checkpoints WHERE company_id = $1", co) == 1

    r = await api.get(API + "/activity/verify-integrity", params={"company_id": empresa["co"]}, headers=_token(empresa["user"]))
    assert r.status_code == 200, r.text
    assert r.json()["intact"] is True
    assert r.json()["checkpoints"] == {"total": 1, "ok": 1, "first_bad": None}

    # Um marco com assinatura válida para um hash que não está mais na cadeia
    # é o que sobra quando alguém reescreve o passado e recalcula tudo.
    quando = datetime.datetime.now(datetime.timezone.utc)
    falso = b"\x01" * 32
    await admin.execute(
        "INSERT INTO public.activity_log_checkpoints (company_id, last_hash, signature, created_at) VALUES ($1, $2, $3, $4)",
        co, falso, ActivityService.assinar_marco(co, falso, quando), quando,
    )
    # E um com assinatura que não confere.
    await admin.execute(
        "INSERT INTO public.activity_log_checkpoints (company_id, last_hash, signature, created_at) VALUES ($1, $2, 'x', now())",
        co, falso,
    )
    marcos = await ActivityService.conferir_marcos(admin, co)
    assert marcos["total"] == 3 and marcos["ok"] == 1
    assert "reescrita" in marcos["first_bad"]["reason"]
    r = await api.get(API + "/activity/verify-integrity", params={"company_id": empresa["co"]}, headers=_token(empresa["user"]))
    assert r.json()["intact"] is False
