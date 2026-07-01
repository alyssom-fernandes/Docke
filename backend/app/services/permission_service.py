"""Equivalente Python de user_has_access para validação prévia de UX.

ATENÇÃO: Este service existe apenas para UX/validação prévia (ex: desabilitar
botões antes de chamar a API). A autorização REAL é feita pelo RLS no Postgres
via função user_has_access(). Nunca usar este service como substituto do RLS.
Implementado em M1.3/M1.4.
"""


class PermissionService:
    pass
