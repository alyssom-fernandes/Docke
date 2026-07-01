"""
M4.11 — T3: Transação de move de pasta com 4 níveis.

Verifica que mover uma pasta L2 atualiza atomicamente todos os
seus descendentes (L3, L4) com paths corretos.

Estrutura inicial:
  root (L1)
    └── L2 (a mover)
          └── L3
                └── L4

Após mover L2 para outro_root (L1b):
  outro_root (L1b)
    └── L2 (movida)
          └── L3 (path atualizado)
                └── L4 (path atualizado)
"""
import uuid

import asyncpg
import pytest


def uid() -> str:
    return uuid.uuid4().hex[:12]


@pytest.mark.asyncio
async def test_folder_move_4_levels(admin, two_companies):
    co_a = two_companies["co_a"]

    # Cria 5 pastas (2 raízes + hierarquia de 4 níveis)
    ids = {k: str(uuid.uuid4()) for k in ("root", "other_root", "l2", "l3", "l4")}
    pfx = uid()

    paths = {
        "root": f"{pfx}root",
        "other_root": f"{pfx}oroot",
        "l2": f"{pfx}root.{pfx}l2",
        "l3": f"{pfx}root.{pfx}l2.{pfx}l3",
        "l4": f"{pfx}root.{pfx}l2.{pfx}l3.{pfx}l4",
    }

    for name, fid in ids.items():
        pid = ids.get("root") if name == "l2" else (
            ids.get("l2") if name == "l3" else (
                ids.get("l3") if name == "l4" else None
            )
        )
        await admin.execute(
            "INSERT INTO public.folders (id, name, company_id, parent_id, path) VALUES ($1, $2, $3, $4, $5::ltree)",
            fid, name, co_a, pid, paths[name],
        )

    # Executa o move atômico (replica lógica de routers/folders.py PATCH move)
    old_path = paths["l2"]
    new_parent_path = paths["other_root"]
    old_nlevel = old_path.count(".") + 1  # = 2

    async with admin.transaction():
        # Atualiza todos os descendentes
        await admin.execute(
            """
            UPDATE public.folders
            SET path = ($1::ltree || subpath(path, $2))::ltree,
                parent_id = CASE WHEN id = $3::uuid THEN $4::uuid ELSE parent_id END
            WHERE path <@ $5::ltree AND company_id = $6::uuid
            """,
            new_parent_path, old_nlevel - 1,
            ids["l2"], ids["other_root"],
            old_path, co_a,
        )

    # Verifica paths após move
    rows = await admin.fetch(
        "SELECT id, path::text FROM public.folders WHERE id = ANY($1::uuid[])",
        list(ids.values()),
    )
    path_map = {str(r["id"]): r["path"] for r in rows}

    expected_l2 = f"{new_parent_path}.{pfx}l2"
    expected_l3 = f"{expected_l2}.{pfx}l3"
    expected_l4 = f"{expected_l3}.{pfx}l4"

    assert path_map[ids["l2"]] == expected_l2, f"L2 path incorreto: {path_map[ids['l2']]}"
    assert path_map[ids["l3"]] == expected_l3, f"L3 path incorreto: {path_map[ids['l3']]}"
    assert path_map[ids["l4"]] == expected_l4, f"L4 path incorreto: {path_map[ids['l4']]}"
    # root e other_root não devem ter mudado
    assert path_map[ids["root"]] == paths["root"]
    assert path_map[ids["other_root"]] == paths["other_root"]

    # Cleanup
    await admin.execute("DELETE FROM public.folders WHERE id = ANY($1::uuid[])", list(ids.values()))
