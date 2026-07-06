"""Equivalente Python de user_has_access para validação prévia de UX.

ATENÇÃO: Este service existe apenas para UX/validação prévia (ex: desabilitar
botões antes de chamar a API). A autorização REAL é feita pelo RLS no Postgres
via função user_has_access(). Nunca usar este service como substituto do RLS.
Implementado em M1.3/M1.4.
"""
from typing import NamedTuple


class AccessGrant(NamedTuple):
    """Uma linha de user_company_access já carregada em memória."""
    folder_path: str | None  # None = acesso à empresa toda
    permission_level: str


class PermissionService:
    """Espelho em Python de public.user_has_access() — mesma regra de
    especificidade (Invariante I7): o path mais profundo que seja ancestral
    (ou igual) ao alvo sempre prevalece, independente de ser mais ou menos
    permissivo que o ancestral.
    """

    @staticmethod
    def resolve(grants: list[AccessGrant], target_path: str | None) -> str | None:
        """
        Retorna o permission_level resolvido para target_path, ou None se o
        usuário não tem nenhuma concessão que cubra esse alvo.

        target_path=None representa a raiz da empresa (documento sem pasta).
        """
        candidates = [
            g for g in grants
            if g.folder_path is None or (target_path is not None and PermissionService._is_ancestor_or_equal(g.folder_path, target_path))
        ]
        if not candidates:
            return None
        # Mais específico primeiro: folder_path=None conta como nível 0 (menos específico).
        candidates.sort(key=lambda g: PermissionService._depth(g.folder_path), reverse=True)
        return candidates[0].permission_level

    @staticmethod
    def _depth(path: str | None) -> int:
        if path is None:
            return 0
        return path.count(".") + 1

    @staticmethod
    def _is_ancestor_or_equal(ancestor_path: str, target_path: str) -> bool:
        """Equivalente a ltree `@>` (ancestor_path é ancestral ou igual a target_path)."""
        if ancestor_path == target_path:
            return True
        return target_path.startswith(ancestor_path + ".")
