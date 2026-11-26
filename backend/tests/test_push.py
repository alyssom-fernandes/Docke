"""Avisos no celular por Web Push (B4.4.5): cifra da RFC 8291, inscrição e envio."""
import uuid
from unittest.mock import patch

import asyncpg
import httpx
import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import ec

from app.services import webpush
from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


def test_cifra_bate_com_o_vetor_da_rfc_8291():
    k = ec.derive_private_key(int.from_bytes(webpush.ub64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), "big"), ec.SECP256R1())
    out = webpush.cifrar(
        b"When I grow up, I want to be a watermelon",
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
        chave_servidor=k, salt=webpush.ub64("DGv6ra1nlYgDCS1FRnbzlw"),
    )
    assert webpush.b64u(out) == (
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_y"
        "l95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
    )


@pytest_asyncio.fixture(loop_scope="session")
async def cenario(admin: asyncpg.Connection):
    co, uid = str(uuid.uuid4()), str(uuid.uuid4())
    await admin.execute("INSERT INTO public.companies (id, name) VALUES ($1, 'Posto Push')", co)
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", uid, f"{uid[:8]}@test.local")
    await admin.execute("INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Pessoa Push', 'usuario')", uid, f"p_{uid[:6]}")
    await admin.execute("INSERT INTO public.user_company_access (user_id, company_id, permission_level) VALUES ($1, $2, 'admin')", uid, co)
    yield {"co": co, "uid": uid}
    await admin.execute("DELETE FROM public.notifications WHERE company_id = $1", uuid.UUID(co))
    await admin.execute("DELETE FROM public.companies WHERE id = $1", uuid.UUID(co))
    await admin.execute("DELETE FROM public.users WHERE id = $1", uid)
    await admin.execute("DELETE FROM auth.users WHERE id = $1", uid)


@pytest.mark.asyncio
async def test_inscrever_e_enviar(api, admin, cenario):  # noqa: F811
    from app.config import settings
    from app.routers.push import enviar_pendentes

    priv, pub = webpush.gerar_chaves()
    _, ua_pub = webpush.gerar_chaves()
    corpo = {"endpoint": f"https://push.exemplo.test/{uuid.uuid4().hex}", "keys": {"p256dh": ua_pub, "auth": "BTBZMqHH6r4Tts7J_aSIgg"}}
    with patch.object(settings, "VAPID_PUBLIC_KEY", ""), patch.object(settings, "VAPID_PRIVATE_KEY", ""):
        assert (await api.post(API + "/push/subscribe", json=corpo, headers=_token(cenario["uid"]))).status_code == 503
    with patch.object(settings, "VAPID_PUBLIC_KEY", pub), patch.object(settings, "VAPID_PRIVATE_KEY", priv):
        assert (await api.post(API + "/push/subscribe", json=corpo, headers=_token(cenario["uid"]))).status_code == 201
        await admin.execute(
            "INSERT INTO public.notifications (user_id, company_id, type, message) VALUES ($1, $2, 'folder_activity', 'Documento novo na pasta RH')",
            uuid.UUID(cenario["uid"]), uuid.UUID(cenario["co"]),
        )
        pedidos = []

        def responder(req: httpx.Request) -> httpx.Response:
            pedidos.append(req)
            return httpx.Response(201)

        async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
            assert await enviar_pendentes(admin, client) == 1
        req = pedidos[0]
        assert req.headers["Content-Encoding"] == "aes128gcm" and req.headers["Authorization"].startswith("vapid t=")
        assert b"Documento novo" not in req.content  # vai cifrado
        assert await admin.fetchval("SELECT count(*) FROM public.notifications WHERE company_id = $1 AND pushed_at IS NULL", uuid.UUID(cenario["co"])) == 0

        # Aparelho que saiu (410): a inscrição é apagada.
        await admin.execute(
            "INSERT INTO public.notifications (user_id, company_id, type, message) VALUES ($1, $2, 'folder_activity', 'Outro aviso')",
            uuid.UUID(cenario["uid"]), uuid.UUID(cenario["co"]),
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(410))) as client:
            await enviar_pendentes(admin, client)
        assert await admin.fetchval("SELECT count(*) FROM public.push_subscriptions WHERE endpoint = $1", corpo["endpoint"]) == 0
