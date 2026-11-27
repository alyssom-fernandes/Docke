"""Respostas das rotas de empresa e pessoas (X3-16)."""
from datetime import datetime

from app.schemas.base import Resposta


class EmpresaDaPessoa(Resposta):
    """Empresa que a pessoa acessa (GET /companies)."""

    id: str
    name: str
    created_at: datetime
    permission_level: str
    # Recursos ligados na empresa, já com os padrões aplicados.
    features: dict[str, bool]


class Empresa(Resposta):
    """Dados da empresa (GET /companies/{id})."""

    id: str
    name: str
    created_at: datetime


class ConcessaoDaEmpresa(Resposta):
    """Concessão de acesso (GET /companies/{id}/members): uma linha por pasta."""

    access_id: str
    user_id: str
    role: str
    full_name: str | None
    username: str | None
    created_at: datetime
    folder_id: str | None
    folder_name: str | None


class ConcessaoDireta(Resposta):
    access_id: str
    role: str
    folder_id: str | None
    folder_name: str | None
    # Datas como o banco escreve no JSON (texto ISO).
    created_at: str | None
    expires_at: str | None


class ConcessaoPorGrupo(Resposta):
    group_id: str
    group_name: str
    role: str
    folder_id: str | None
    folder_name: str | None


class PessoaDaEmpresa(Resposta):
    """Pessoa com o que define o que ela vê (GET /companies/{id}/people)."""

    user_id: str
    username: str | None
    full_name: str | None
    is_active: bool
    role: str
    must_change_password: bool | None
    email: str | None
    last_sign_in_at: datetime | None
    mfa_enabled: bool
    grants: list[ConcessaoDireta]
    via_groups: list[ConcessaoPorGrupo]
    company_count: int
    avatar_url: str | None
