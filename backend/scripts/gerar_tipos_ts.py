"""
Gera frontend/src/lib/api-types.ts a partir do OpenAPI da própria API (X3-16).

Só biblioteca padrão e o app: lê app.openapi() e escreve uma interface
TypeScript por modelo, mais o mapa Respostas ("GET /documents" → tipo da
resposta) das rotas que declaram response_model.

Uso, em backend/:
  python scripts/gerar_tipos_ts.py           # reescreve o arquivo
  python scripts/gerar_tipos_ts.py --check   # só confere (sai com 1 se desatualizado)

O teste tests/test_tipos_ts.py falha quando o arquivo não bate com a API.
"""
import json
import re
import sys
from pathlib import Path
from typing import Any

BACKEND = Path(__file__).resolve().parent.parent
DESTINO = BACKEND.parent / "frontend" / "src" / "lib" / "api-types.ts"
PREFIXO = "/api/v1"
# Esquemas internos do FastAPI para o 422 (a API responde problem+json) e que
# mudam de uma versão do FastAPI para outra.
IGNORADOS = {"HTTPValidationError", "ValidationError"}
METODOS = ("get", "post", "put", "patch", "delete")

CABECALHO = """\
/* eslint-disable */
// Gerado por backend/scripts/gerar_tipos_ts.py a partir do OpenAPI da API.
// Não edite à mão: em backend/, rode `python scripts/gerar_tipos_ts.py`.
"""


def _nome(ref: str) -> str:
    return re.sub(r"\W", "_", ref.rsplit("/", 1)[-1])


def _chave(nome: str) -> str:
    return nome if re.fullmatch(r"[A-Za-z_$][\w$]*", nome) else json.dumps(nome, ensure_ascii=False)


def _comentario(texto: str | None, recuo: str) -> list[str]:
    if not texto:
        return []
    linhas = [linha.rstrip() for linha in texto.strip().replace("*/", "*\\/").splitlines()]
    if len(linhas) == 1:
        return [f"{recuo}/** {linhas[0]} */"]
    return [f"{recuo}/**", *(f"{recuo} * {linha}".rstrip() for linha in linhas), f"{recuo} */"]


def _uniao(partes: list[str]) -> str:
    vistas: list[str] = []
    for p in partes:
        if p not in vistas:
            vistas.append(p)
    if "unknown" in vistas:
        return "unknown"
    return " | ".join(vistas) if vistas else "never"


def _tipo(s: Any, recuo: str = "") -> str:
    if s is True or s == {}:
        return "unknown"
    if not isinstance(s, dict):
        return "unknown"
    if "$ref" in s:
        return _nome(s["$ref"])
    if "const" in s:
        return json.dumps(s["const"], ensure_ascii=False)
    if "enum" in s:
        return _uniao([json.dumps(v, ensure_ascii=False) for v in s["enum"]])
    for chave in ("anyOf", "oneOf"):
        if chave in s:
            return _uniao([_tipo(x, recuo) for x in s[chave]])
    if "allOf" in s:
        partes = [_tipo(x, recuo) for x in s["allOf"]]
        return partes[0] if len(partes) == 1 else " & ".join(partes)
    tipo = s.get("type")
    if isinstance(tipo, list):
        return _uniao([_tipo({**s, "type": t}, recuo) for t in tipo])
    if tipo == "string":
        return "string"
    if tipo in ("integer", "number"):
        return "number"
    if tipo == "boolean":
        return "boolean"
    if tipo == "null":
        return "null"
    if tipo == "array":
        if "prefixItems" in s:
            return "[" + ", ".join(_tipo(x, recuo) for x in s["prefixItems"]) + "]"
        item = _tipo(s.get("items", {}), recuo)
        return f"({item})[]" if " " in item else f"{item}[]"
    if tipo == "object" or "properties" in s:
        if s.get("properties"):
            return _objeto(s, recuo)
        extra = s.get("additionalProperties")
        valor = _tipo(extra, recuo) if isinstance(extra, dict) else "unknown"
        return f"Record<string, {valor}>"
    return "unknown"


def _objeto(s: dict[str, Any], recuo: str) -> str:
    obrigatorios = set(s.get("required", []))
    dentro = recuo + "  "
    linhas = ["{"]
    for nome, prop in s["properties"].items():
        linhas += _comentario(prop.get("description"), dentro)
        opcional = "" if nome in obrigatorios else "?"
        linhas.append(f"{dentro}{_chave(nome)}{opcional}: {_tipo(prop, dentro)};")
    linhas.append(recuo + "}")
    return "\n".join(linhas)


def _resposta(op: dict[str, Any]) -> str | None:
    """Tipo da resposta de sucesso, só quando aponta para modelos declarados."""
    for codigo in ("200", "201"):
        conteudo = op.get("responses", {}).get(codigo, {}).get("content", {})
        esquema = conteudo.get("application/json", {}).get("schema")
        if esquema and "$ref" in json.dumps(esquema):
            return _tipo(esquema, "  ")
    return None


def gerar_texto(spec: dict[str, Any]) -> str:
    saida = [CABECALHO]
    esquemas = spec.get("components", {}).get("schemas", {})
    for nome in sorted(esquemas):
        if nome in IGNORADOS:
            continue
        s = esquemas[nome]
        saida += _comentario(s.get("description"), "")
        if s.get("properties"):
            saida.append(f"export interface {_nome(nome)} {_objeto(s, '')}")
        else:
            saida.append(f"export type {_nome(nome)} = {_tipo(s)};")
        saida.append("")

    rotas = []
    for caminho in sorted(spec.get("paths", {})):
        for metodo in METODOS:
            op = spec["paths"][caminho].get(metodo)
            if op is None:
                continue
            tipo = _resposta(op)
            if tipo is not None:
                curto = caminho[len(PREFIXO):] if caminho.startswith(PREFIXO) else caminho
                rotas.append(f"  {json.dumps(f'{metodo.upper()} {curto}')}: {tipo};")
    saida.append("/** Resposta de cada rota com contrato declarado (caminho sem /api/v1). */")
    saida.append("export interface Respostas {")
    saida += rotas
    saida.append("}")
    return "\n".join(saida) + "\n"


def texto_atual() -> str:
    if str(BACKEND) not in sys.path:
        sys.path.insert(0, str(BACKEND))
    from app.main import app

    return gerar_texto(app.openapi())


def main(argv: list[str]) -> int:
    texto = texto_atual()
    existente = DESTINO.read_text(encoding="utf-8").replace("\r\n", "\n") if DESTINO.exists() else None
    if "--check" in argv:
        if existente != texto:
            print(f"{DESTINO} está desatualizado: rode python scripts/gerar_tipos_ts.py em backend/.")
            return 1
        print("Tipos em dia.")
        return 0
    DESTINO.write_text(texto, encoding="utf-8", newline="\n")
    print(f"Escrito {DESTINO.relative_to(BACKEND.parent)} ({texto.count(chr(10))} linhas).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
