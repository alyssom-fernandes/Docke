"""Copiar estrutura com prévia, escolhas e documentos em partes (A4-47, A4-48)."""
import uuid

import pytest

from tests.test_admin_scope import _token, api  # noqa: F401 — fixture reaproveitada
from tests.test_listas import empresa, _doc  # noqa: F401 — fixture reaproveitada

API = "/api/v1"


@pytest.mark.asyncio
async def test_previa_nao_grava_e_copia_leva_lgpd_acessos_e_documentos(api, admin, empresa):  # noqa: F811
    h, co = _token(empresa["user"]), empresa["co"]
    await _doc(admin, empresa, empresa["sub"], "Nota 1.pdf", "texto")
    await _doc(admin, empresa, empresa["sub"], "Nota 2.pdf", "texto")
    await admin.execute("UPDATE public.folders SET sensitivity = 'pessoal' WHERE id = $1", uuid.UUID(empresa["sub"]))

    # Uma pessoa com acesso só à subpasta (concessão presa ao caminho).
    outra = str(uuid.uuid4())
    await admin.execute("INSERT INTO auth.users (id, email) VALUES ($1, $2)", outra, f"{outra[:8]}@test.local")
    await admin.execute(
        "INSERT INTO public.users (id, username, full_name, role) VALUES ($1, $2, 'Pessoa Concedida', 'usuario')",
        outra, f"cop_{outra[:6]}",
    )
    sub_path = await admin.fetchval("SELECT path::text FROM public.folders WHERE id = $1", uuid.UUID(empresa["sub"]))
    await admin.execute(
        "INSERT INTO public.user_company_access (user_id, company_id, permission_level, folder_path) VALUES ($1, $2, 'visualizador', $3::ltree)",
        outra, co, sub_path,
    )
    try:
        antes = await admin.fetchval("SELECT count(*) FROM public.folders WHERE company_id = $1", uuid.UUID(co))
        r = await api.post(API + f"/folders/{empresa['raiz']}/copy-structure/preview",
                           json={"target_company_id": co}, headers=h)
        assert r.status_code == 200, r.text
        p = r.json()
        assert (p["folders"], p["documents"], p["sensitive_folders"], p["access_grants"]) == (2, 2, 1, 1)
        assert p["root_name"] == "Fiscal (1)" and p["root_renamed"] is True and p["same_company"] is True
        assert await admin.fetchval("SELECT count(*) FROM public.folders WHERE company_id = $1", uuid.UUID(co)) == antes

        r = await api.post(API + f"/folders/{empresa['raiz']}/copy-structure",
                           json={"target_company_id": co, "include_access": True}, headers=h)
        assert r.status_code == 201, r.text
        c = r.json()
        assert (c["folders_copied"], c["documents_copied"], c["sensitivity_copied"], c["access_copied"]) == (2, 0, 1, 1)
        assert c["name"] == "Fiscal (1)" and c["root_renamed"] is True
        assert len(c["pairs"]) == 2

        # Documentos em partes: um par por vez.
        par = next(x for x in c["pairs"] if x["source_folder_id"] == empresa["sub"])
        r = await api.post(API + "/folders/copy-documents", json={"target_company_id": co, "pairs": [par]}, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["documents_copied"] == 2
        assert await admin.fetchval(
            "SELECT count(*) FROM public.documents WHERE folder_id = $1 AND deleted_at IS NULL", uuid.UUID(par["target_folder_id"]),
        ) == 2

        # Pasta de destino de outra empresa (ou inexistente) é recusada.
        r = await api.post(API + "/folders/copy-documents",
                           json={"target_company_id": str(uuid.uuid4()), "pairs": [par]}, headers=h)
        assert r.status_code == 404, r.text
    finally:
        await admin.execute("DELETE FROM public.user_company_access WHERE user_id = $1", outra)
        await admin.execute("DELETE FROM public.users WHERE id = $1", outra)
        await admin.execute("DELETE FROM auth.users WHERE id = $1", outra)
