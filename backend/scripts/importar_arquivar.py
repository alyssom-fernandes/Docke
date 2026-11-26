#!/usr/bin/env python3
"""
Importador para migrar o Arquivar (ou qualquer pasta de arquivos) para o Docke
— achado X2-07 da avaliação de 25/11/2026.

O que faz:
- recria a árvore de pastas da origem dentro de uma pasta do Docke (ou na raiz);
- envia os arquivos em paralelo, direto para o armazenamento, com a DATA
  ORIGINAL (do manifesto ou, sem ele, a data de modificação do arquivo);
- grava os metadados do manifesto (campos que não existirem são criados como texto);
- confere cada arquivo pelo SHA-256: o calculado aqui tem de ser igual ao que a
  API calcula sobre o objeto guardado;
- pode ser interrompido e rodado de novo: o que já entrou é pulado (estado em
  <relatório>.estado.jsonl);
- no fim, escreve o relatório de conferência (CSV) e um resumo por pasta:
  arquivos na origem × importados × já existiam (mesmo conteúdo) × falhas.

Só usa a biblioteca padrão do Python 3.10+. Exemplo (PowerShell):

    python importar_arquivar.py --origem "D:\\Exportacao Arquivar\\Posto Centro" `
        --empresa "Posto Centro Ltda" --email voce@empresa.com.br `
        --manifesto "D:\\Exportacao Arquivar\\manifesto.csv" --pasta-destino "Arquivar"

A senha é pedida no terminal (não aparece na tela) ou lida de DOCKE_SENHA.
Use primeiro --simular para ver o que seria feito, sem enviar nada.

Manifesto (opcional), CSV com ; ou , e cabeçalho. Colunas reconhecidas:
  caminho            caminho do arquivo relativo à pasta --origem (obrigatória)
  data_original      2024-03-15, 15/03/2024 ou 15/03/2024 14:30
  campo:<Rótulo>     valor do metadado <Rótulo> (ex.: campo:Fornecedor)
"""
from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import getpass
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API_PADRAO = "https://docke-api.fly.dev/api/v1"
PERMITIDAS = {"pdf", "xlsx", "xls", "csv", "docx", "doc", "xml", "jpg", "jpeg", "png", "gif", "txt"}
MULTIPART_LIMIAR = 20 * 1024 * 1024
LIMITE = 200 * 1024 * 1024


class ErroApi(Exception):
    def __init__(self, status: int, detalhe: str):
        super().__init__(f"HTTP {status}: {detalhe}")
        self.status = status
        self.detalhe = detalhe


class Api:
    def __init__(self, base: str):
        self.base = base.rstrip("/")
        self.token: str | None = None
        self._lock = threading.Lock()

    def _req(self, metodo: str, caminho: str, corpo=None, params=None, tentativas: int = 4):
        url = self.base + caminho + (("?" + urllib.parse.urlencode(params)) if params else "")
        dados = json.dumps(corpo).encode() if corpo is not None else None
        for i in range(tentativas):
            req = urllib.request.Request(url, data=dados, method=metodo)
            req.add_header("Content-Type", "application/json")
            if self.token:
                req.add_header("Authorization", f"Bearer {self.token}")
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    texto = r.read().decode() or "null"
                    return json.loads(texto)
            except urllib.error.HTTPError as e:
                try:
                    detalhe = json.loads(e.read().decode()).get("detail", "")
                except Exception:
                    detalhe = e.reason
                if e.code in (502, 503, 504, 429) and i < tentativas - 1:
                    time.sleep(3 * (i + 1) ** 2)
                    continue
                raise ErroApi(e.code, str(detalhe)) from None
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if i < tentativas - 1:
                    time.sleep(3 * (i + 1) ** 2)
                    continue
                raise

    def get(self, c, **p):
        return self._req("GET", c, params=p or None)

    def post(self, c, corpo=None, **p):
        return self._req("POST", c, corpo, params=p or None)

    def put(self, c, corpo=None):
        return self._req("PUT", c, corpo)


def put_arquivo(url: str, dados: bytes, content_type: str | None, tentativas: int = 4) -> str | None:
    for i in range(tentativas):
        req = urllib.request.Request(url, data=dados, method="PUT")
        if content_type:
            req.add_header("Content-Type", content_type)
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                return r.headers.get("ETag")
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if i == tentativas - 1:
                raise
            time.sleep(3 * (i + 1) ** 2)
    return None


def sha256_arquivo(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for bloco in iter(lambda: f.read(1024 * 1024), b""):
            h.update(bloco)
    return h.hexdigest()


def ler_data(texto: str) -> datetime | None:
    texto = (texto or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(texto, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def ler_manifesto(caminho: Path) -> dict[str, dict]:
    bruto = caminho.read_bytes()
    texto = None
    for enc in ("utf-8-sig", "cp1252"):
        try:
            texto = bruto.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    dialeto = ";" if texto.splitlines()[0].count(";") >= texto.splitlines()[0].count(",") else ","
    linhas = csv.DictReader(texto.splitlines(), delimiter=dialeto)
    out = {}
    for row in linhas:
        rel = (row.get("caminho") or "").strip().replace("\\", "/").strip("/")
        if not rel:
            continue
        campos = {k.split(":", 1)[1].strip(): (v or "").strip() for k, v in row.items() if k and k.startswith("campo:") and (v or "").strip()}
        out[rel.lower()] = {"data": ler_data(row.get("data_original", "")), "campos": campos}
    return out


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Importa uma pasta (exportação do Arquivar) para o Docke.")
    ap.add_argument("--origem", required=True, help="pasta com os arquivos exportados")
    ap.add_argument("--empresa", required=True, help="nome ou CNPJ da empresa no Docke")
    ap.add_argument("--email", default="", help="e-mail de login (ou DOCKE_TOKEN com uma sessão já aberta)")
    ap.add_argument("--api", default=os.environ.get("DOCKE_API", API_PADRAO))
    ap.add_argument("--manifesto", help="CSV com caminho, data_original e campo:<Rótulo>")
    ap.add_argument("--pasta-destino", default="", help="pasta do Docke onde a árvore entra (criada se faltar); vazio = raiz")
    ap.add_argument("--relatorio", default="relatorio-importacao.csv")
    ap.add_argument("--paralelo", type=int, default=4, help="envios simultâneos (padrão 4)")
    ap.add_argument("--simular", action="store_true", help="só lista o que seria feito")
    a = ap.parse_args()

    origem = Path(a.origem).resolve()
    if not origem.is_dir():
        print(f"Pasta de origem não encontrada: {origem}")
        return 2
    manifesto = ler_manifesto(Path(a.manifesto)) if a.manifesto else {}

    arquivos = sorted(p for p in origem.rglob("*") if p.is_file())
    ignorados = [p for p in arquivos if p.suffix.lower().lstrip(".") not in PERMITIDAS or p.stat().st_size == 0 or p.stat().st_size > LIMITE]
    validos = [p for p in arquivos if p not in set(ignorados)]
    print(f"Origem: {origem}\n{len(arquivos)} arquivo(s); {len(validos)} serão enviados, {len(ignorados)} fora do padrão (extensão, vazio ou acima de 200 MB).")
    if a.simular:
        for p in ignorados:
            print(f"  ignorado: {p.relative_to(origem)}")
        print("Simulação: nada foi enviado.")
        return 0

    api = Api(a.api)
    if os.environ.get("DOCKE_TOKEN"):
        api.token = os.environ["DOCKE_TOKEN"]  # sessão já aberta (ex.: ensaio na demo)
    else:
        senha = os.environ.get("DOCKE_SENHA") or getpass.getpass("Senha do Docke: ")
        api.token = api.post("/auth/login", {"email": a.email, "password": senha})["access_token"]
    empresas = api.get("/companies")
    alvo = a.empresa.strip().lower()
    digitos = "".join(c for c in alvo if c.isdigit())
    empresa = next((e for e in empresas if e["name"].lower() == alvo or (digitos and (e.get("cnpj") or "") == digitos)), None)
    if empresa is None:
        print("Empresa não encontrada entre as que você acessa: " + ", ".join(e["name"] for e in empresas))
        return 2
    cid = empresa["id"]

    # Pastas existentes: caminho por nome → id
    pastas = api.get("/folders", company_id=cid, flat="true")
    por_id = {f["id"]: f for f in pastas}

    def nome_completo(f):
        partes = []
        while f:
            partes.append(f["name"])
            f = por_id.get(f.get("parent_id"))
        return "/".join(reversed(partes)).lower()

    cache = {nome_completo(f): f["id"] for f in pastas}
    lock_pastas = threading.Lock()

    def garantir_pasta(rel_dir: str) -> str:
        partes = [p for p in rel_dir.split("/") if p]
        atual_id, atual_nome = None, ""
        for parte in partes:
            atual_nome = f"{atual_nome}/{parte}".strip("/")
            with lock_pastas:
                if atual_nome.lower() not in cache:
                    nova = api.post("/folders", {"name": parte, "parent_id": atual_id, "company_id": cid})
                    cache[atual_nome.lower()] = nova["id"]
                atual_id = cache[atual_nome.lower()]
        return atual_id

    # Campos de metadados por rótulo
    campos = {c["label"].lower(): c["id"] for c in api.get("/custom-fields", company_id=cid)}
    lock_campos = threading.Lock()

    def campo_id(rotulo: str) -> str:
        with lock_campos:
            if rotulo.lower() not in campos:
                novo = api.post("/custom-fields", {"company_id": cid, "label": rotulo, "type": "texto"})
                campos[rotulo.lower()] = novo["id"]
            return campos[rotulo.lower()]

    estado_path = Path(a.relatorio + ".estado.jsonl")
    feitos: dict[str, dict] = {}
    if estado_path.exists():
        for linha in estado_path.read_text(encoding="utf-8").splitlines():
            r = json.loads(linha)
            if r["situacao"] in ("importado", "ja_existia"):
                feitos[r["caminho"]] = r
    lock_estado = threading.Lock()
    estado_f = open(estado_path, "a", encoding="utf-8")

    def registrar(r: dict) -> dict:
        with lock_estado:
            estado_f.write(json.dumps(r, ensure_ascii=False) + "\n")
            estado_f.flush()
        return r

    destino_raiz = a.pasta_destino.strip("/\\")

    def enviar(p: Path) -> dict:
        rel = p.relative_to(origem).as_posix()
        if rel in feitos:
            return feitos[rel]
        info = manifesto.get(rel.lower(), {})
        data = info.get("data") or datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc)
        sha = sha256_arquivo(p)
        base = {"caminho": rel, "sha256_origem": sha, "tamanho": p.stat().st_size}
        try:
            pasta_rel = "/".join(x for x in (destino_raiz, os.path.dirname(rel)) if x)
            pasta_id = garantir_pasta(pasta_rel) if pasta_rel else None
            if pasta_id is None:
                raise ErroApi(422, "Arquivos na raiz da origem precisam de --pasta-destino (o Docke guarda documentos em pastas).")
            corpo = {"folder_id": pasta_id, "company_id": cid, "name": p.name, "size_bytes": p.stat().st_size,
                     "content_type": "application/octet-stream", "original_created_at": data.isoformat()}
            dados = p.read_bytes()
            if len(dados) >= MULTIPART_LIMIAR:
                m = api.post("/documents/multipart/create", corpo)
                partes = []
                for n in range(1, m["total_parts"] + 1):
                    url = api.post(f"/documents/multipart/{m['document_id']}/part-url",
                                   {"upload_id": m["upload_id"], "part_number": n})["upload_url"]
                    trecho = dados[(n - 1) * m["part_size"]: n * m["part_size"]]
                    partes.append({"part_number": n, "etag": put_arquivo(url, trecho, None)})
                conf = api.post(f"/documents/multipart/{m['document_id']}/complete", {"upload_id": m["upload_id"], "parts": partes})
                doc_id = m["document_id"]
            else:
                u = api.post("/documents/upload-url", corpo)
                try:
                    put_arquivo(u["upload_url"], dados, u.get("content_type"))
                except Exception:
                    try:
                        api.post(f"/documents/{u['document_id']}/abort-upload")
                    except Exception:
                        pass
                    raise
                conf = api.post(f"/documents/{u['document_id']}/confirm")
                doc_id = u["document_id"]
            sha_api = (conf or {}).get("content_hash", "")
            if info.get("campos"):
                api.put(f"/documents/{doc_id}/field-values",
                        [{"custom_field_id": campo_id(k), "value": v} for k, v in info["campos"].items()])
            situacao = "importado" if sha_api == sha else "hash_divergente"
            return registrar({**base, "situacao": situacao, "documento": doc_id, "sha256_docke": sha_api,
                              "pasta": pasta_rel, "obs": ""})
        except ErroApi as e:
            if e.status == 409 and "idêntico" in e.detalhe:
                return registrar({**base, "situacao": "ja_existia", "documento": "", "sha256_docke": sha,
                                  "pasta": "", "obs": e.detalhe})
            return registrar({**base, "situacao": "falha", "documento": "", "sha256_docke": "", "pasta": "", "obs": e.detalhe})
        except Exception as e:  # rede, disco
            return registrar({**base, "situacao": "falha", "documento": "", "sha256_docke": "", "pasta": "", "obs": str(e)})

    resultados = []
    inicio = time.time()
    with cf.ThreadPoolExecutor(max_workers=max(1, a.paralelo)) as ex:
        for i, r in enumerate(ex.map(enviar, validos), 1):
            resultados.append(r)
            if i % 10 == 0 or i == len(validos):
                print(f"  {i}/{len(validos)} ({time.time() - inicio:.0f} s)", flush=True)
    estado_f.close()

    with open(a.relatorio, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["caminho_origem", "tamanho", "sha256_origem", "situacao", "sha256_docke", "documento_docke", "pasta_docke", "observacao"])
        for r in resultados:
            w.writerow([r["caminho"], r["tamanho"], r["sha256_origem"], r["situacao"], r.get("sha256_docke", ""),
                        r.get("documento", ""), r.get("pasta", ""), r.get("obs", "")])
        for p in ignorados:
            w.writerow([p.relative_to(origem).as_posix(), p.stat().st_size, "", "fora_do_padrao", "", "", "",
                        "extensão não aceita, arquivo vazio ou acima de 200 MB"])

    # Resumo por pasta de origem
    resumo: dict[str, dict[str, int]] = {}
    for r in resultados:
        pasta = os.path.dirname(r["caminho"]) or "(raiz)"
        s = resumo.setdefault(pasta, {"origem": 0, "importado": 0, "ja_existia": 0, "falha": 0, "hash_divergente": 0})
        s["origem"] += 1
        s[r["situacao"]] = s.get(r["situacao"], 0) + 1
    with open(a.relatorio.replace(".csv", "") + "-resumo.csv", "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["pasta_origem", "arquivos", "importados", "ja_existiam", "falhas", "hash_divergente"])
        for pasta, s in sorted(resumo.items()):
            w.writerow([pasta, s["origem"], s["importado"], s["ja_existia"], s["falha"], s["hash_divergente"]])

    tot = {k: sum(1 for r in resultados if r["situacao"] == k) for k in ("importado", "ja_existia", "falha", "hash_divergente")}
    print(f"\nConferência: {len(validos)} na origem · {tot['importado']} importados e conferidos pelo SHA-256 · "
          f"{tot['ja_existia']} já existiam (mesmo conteúdo) · {tot['falha']} falhas · {tot['hash_divergente']} com hash divergente · "
          f"{len(ignorados)} fora do padrão.")
    print(f"Relatório: {a.relatorio} (e o resumo por pasta). Rode de novo para tentar só as falhas.")
    return 0 if tot["falha"] == 0 and tot["hash_divergente"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
