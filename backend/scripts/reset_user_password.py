"""
Redefine a senha de UM usuário existente no Supabase Auth, via Admin API.

Uso (a partir da raiz do repositório):
    py backend/scripts/reset_user_password.py <email> <nova-senha>

Salvaguardas (deliberadas — não remover):
  - Filtra por e-mail NO LADO DO CLIENTE. A Admin API do GoTrue ignora
    silenciosamente parâmetros de filtro desconhecidos e devolve a listagem
    padrão; confiar nela já causou um incidente real (senha da conta admin
    de produção sobrescrita). Mesma proteção usada em app/seed/demo_data.py.
  - NUNCA cria conta: se o e-mail não existir, aborta.
  - Se houver mais de uma conta com o mesmo e-mail, aborta.
  - Não altera nada além da senha, e nunca a imprime.

Credenciais: variáveis de ambiente SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
têm prioridade; na ausência delas, caem no backend/.env. (O .env local desta
máquina aponta pro Supabase local via Docker — para agir na PRODUÇÃO, exporte
as variáveis com os valores do painel do Supabase antes de rodar.)
"""
import json
import os
import sys
import urllib.request
from pathlib import Path

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        env[key.strip()] = value.strip().strip('"').strip("'")
    return env


def request(url: str, key: str, method: str = "GET", body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def main() -> None:
    if len(sys.argv) != 3:
        print("Uso: py backend/scripts/reset_user_password.py <email> <nova-senha>")
        sys.exit(1)
    email, password = sys.argv[1], sys.argv[2]
    if len(password) < 8:
        print("ERRO: a senha precisa ter no mínimo 8 caracteres.")
        sys.exit(1)

    env = load_env(ENV_PATH) if ENV_PATH.exists() else {}
    base = (os.environ.get("SUPABASE_URL") or env.get("SUPABASE_URL", "")).rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not base or not key:
        print(f"ERRO: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (env vars ou {ENV_PATH}).")
        sys.exit(1)
    if "127.0.0.1" in base or "localhost" in base:
        print(f"AVISO: SUPABASE_URL aponta pro ambiente LOCAL ({base}), não pra produção.")
        print("Para produção, exporte SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY antes de rodar. Abortando.")
        sys.exit(1)

    status, payload = request(f"{base}/auth/v1/admin/users?per_page=200", key)
    if status != 200:
        print(f"ERRO ao listar usuários (HTTP {status}): {payload}")
        sys.exit(1)

    matches = [u for u in payload.get("users", []) if u.get("email", "").lower() == email.lower()]
    if not matches:
        print(f"ERRO: nenhum usuário com o e-mail {email}. Nada foi alterado (este script nunca cria contas).")
        sys.exit(1)
    if len(matches) > 1:
        print(f"ERRO: {len(matches)} contas com o e-mail {email}. Abortando por segurança — nada foi alterado.")
        sys.exit(1)

    user_id = matches[0]["id"]
    status, payload = request(f"{base}/auth/v1/admin/users/{user_id}", key, method="PUT", body={"password": password})
    if status != 200:
        print(f"ERRO ao atualizar a senha (HTTP {status}): {payload}")
        sys.exit(1)

    print(f"OK — senha redefinida para {email} (id {user_id}). Faça login com a senha nova.")


if __name__ == "__main__":
    main()
