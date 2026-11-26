"""
Pedidos do titular (LGPD art. 18 e 19; benchmark B3.7.2).

Fluxo: o pedido chega pelo formulário público da empresa (se ela ligar o
canal) ou é registrado pelo admin quando vem por e-mail, telefone ou balcão.
Ganha protocolo e prazo (15 dias, art. 19, II), um responsável, a verificação
de identidade e um histórico de cada passo. Concluir exige identidade
verificada e resposta escrita; negar exige o motivo. Quem pediu pelo
formulário acompanha com o protocolo e o código que recebeu.

O CPF nunca é guardado em claro: só o resumo SHA-256 e os dois últimos
dígitos, para conferir na hora de atender.
"""
import hashlib
import re
import secrets
from datetime import date, timedelta
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services import rate_limit
from app.services.companies_service import CompaniesService

router = APIRouter(tags=["lgpd-requests"])

Tipo = Literal["confirmacao", "acesso", "correcao", "eliminacao", "portabilidade", "anonimizacao", "informacao", "revogacao", "oposicao"]
Canal = Literal["formulario", "email", "telefone", "presencial", "outro"]
Status = Literal["recebido", "verificando", "em_andamento", "concluido", "negado"]
PRAZO_DIAS = 15
TIPO_LABEL = {
    "confirmacao": "confirmação de tratamento", "acesso": "acesso aos dados", "correcao": "correção",
    "eliminacao": "eliminação", "portabilidade": "portabilidade", "anonimizacao": "anonimização ou bloqueio",
    "informacao": "informação sobre compartilhamento", "revogacao": "revogação do consentimento", "oposicao": "oposição ao tratamento",
}
_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _aleatorio(n: int) -> str:
    return "".join(secrets.choice(_ALFABETO) for _ in range(n))


def _sha(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


def _cpf(valor: str | None) -> tuple[str | None, str | None]:
    if not valor:
        return None, None
    d = re.sub(r"\D", "", valor)
    if len(d) != 11:
        raise HTTPException(status_code=422, detail="O CPF precisa ter 11 dígitos.")
    return _sha(d), d[-2:]


async def _exigir_admin(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID | str) -> None:
    if await get_app_role(conn, claims) == "supremo":
        return
    if not await CompaniesService.user_manages_company(conn, claims["sub"], UUID(str(company_id))):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores da empresa atendem pedidos do titular.")


async def _evento(admin_conn: asyncpg.Connection, request_id: str, user_id: str | None, tipo: str, detalhe: str | None) -> None:
    await admin_conn.execute(
        "INSERT INTO public.lgpd_request_events (request_id, user_id, tipo, detalhe) VALUES ($1::uuid, $2::uuid, $3, $4)",
        request_id, user_id, tipo, (detalhe or None) and detalhe[:4000],
    )


async def _trilha(admin_conn: asyncpg.Connection, *, user_id: str, company_id: str, action: str, pedido: asyncpg.Record | dict, meta: str) -> None:
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata, severity)
        VALUES ($1::uuid, $2::uuid, $3, 'config', $4::uuid, $5, 'config', jsonb_build_object('protocolo', $6::text, 'detalhe', $7::text), 'warning')
        """,
        user_id, company_id, action, str(pedido["id"]), f"Pedido do titular {pedido['protocolo']}", pedido["protocolo"], meta,
    )


async def _avisar(admin_conn: asyncpg.Connection, *, company_id: str, request_id: str, ator: str | None, msg: str, so: str | None = None) -> None:
    """Avisa os admins da empresa (ou só uma pessoa, com `so`)."""
    if so:
        alvos = [so]
    else:
        alvos = [r["user_id"] for r in await admin_conn.fetch(
            "SELECT DISTINCT user_id::text FROM public.user_company_access WHERE company_id = $1::uuid AND permission_level = 'admin' AND folder_path IS NULL",
            company_id,
        )]
    for alvo in alvos:
        if alvo == ator:
            continue
        await admin_conn.execute(
            """
            INSERT INTO public.notifications (user_id, company_id, type, resource_type, resource_id, actor_user_id, message)
            VALUES ($1::uuid, $2::uuid, 'lgpd_request', 'lgpd_request', $3::uuid, $4::uuid, $5)
            """,
            alvo, company_id, request_id, ator, msg,
        )


async def _criar(admin_conn: asyncpg.Connection, *, company_id: str, tipo: str, canal: str, nome: str, cpf: str | None,
                 contato: str | None, descricao: str | None, user_id: str | None, codigo: str | None) -> asyncpg.Record:
    cpf_sha, cpf_final = _cpf(cpf)
    prazo = date.today() + timedelta(days=PRAZO_DIAS)
    for _ in range(5):
        protocolo = f"LGPD-{date.today().year}-{_aleatorio(6)}"
        try:
            row = await admin_conn.fetchrow(
                """
                INSERT INTO public.lgpd_requests (company_id, protocolo, codigo_hash, tipo, canal, titular_nome, titular_cpf_sha256,
                                                  titular_cpf_final, contato, descricao, prazo, created_by)
                VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid)
                RETURNING id::text, protocolo, prazo, tipo, status
                """,
                company_id, protocolo, _sha(codigo) if codigo else None, tipo, canal, nome.strip(), cpf_sha, cpf_final,
                (contato or "").strip() or None, (descricao or "").strip() or None, prazo, user_id,
            )
            break
        except asyncpg.UniqueViolationError:
            continue
    else:  # pragma: no cover — 32^6 combinações por ano
        raise HTTPException(status_code=500, detail="Não foi possível gerar o protocolo. Tente de novo.")
    await _evento(admin_conn, row["id"], user_id, "criado", f"Pedido de {TIPO_LABEL[tipo]} recebido por {canal}.")
    return row


# ---------------------------------------------------------------------------
# Atendimento (admin da empresa)
# ---------------------------------------------------------------------------

class PedidoNovo(BaseModel):
    tipo: Tipo
    canal: Canal = "email"
    titular_nome: str = Field(..., min_length=2, max_length=200)
    titular_cpf: str | None = Field(None, max_length=20)
    contato: str | None = Field(None, max_length=200)
    descricao: str | None = Field(None, max_length=2000)


class PedidoMudanca(BaseModel):
    status: Status | None = None
    responsavel_id: UUID | None = None
    identidade_verificada: bool | None = None
    identidade_metodo: str | None = Field(None, max_length=200)
    prazo: date | None = None
    resposta: str | None = Field(None, max_length=4000)
    nota: str | None = Field(None, max_length=2000)


_COLUNAS = """
    r.id::text, r.protocolo, r.tipo, r.canal, r.titular_nome, r.titular_cpf_final, r.contato, r.descricao, r.status,
    r.identidade_verificada, r.identidade_metodo, r.responsavel_id::text, u.full_name AS responsavel_nome, r.prazo,
    r.resposta, r.created_at, r.updated_at, r.concluido_at,
    (r.status NOT IN ('concluido', 'negado') AND r.prazo < current_date) AS atrasado
"""


@router.get("/companies/{company_id}/privacy/requests")
async def listar(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    await _exigir_admin(conn, claims, company_id)
    rows = await admin_conn.fetch(
        f"""
        SELECT {_COLUNAS} FROM public.lgpd_requests r LEFT JOIN public.users u ON u.id = r.responsavel_id
        WHERE r.company_id = $1
        ORDER BY (r.status IN ('concluido', 'negado')), r.prazo, r.created_at DESC
        LIMIT 500
        """,
        company_id,
    )
    return [dict(r) for r in rows]


@router.post("/companies/{company_id}/privacy/requests", status_code=status.HTTP_201_CREATED)
async def registrar(
    company_id: UUID,
    body: PedidoNovo,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    async with admin_conn.transaction():
        row = await _criar(admin_conn, company_id=str(company_id), tipo=body.tipo, canal=body.canal, nome=body.titular_nome,
                           cpf=body.titular_cpf, contato=body.contato, descricao=body.descricao, user_id=claims["sub"], codigo=None)
        await _trilha(admin_conn, user_id=claims["sub"], company_id=str(company_id), action="lgpd_request_created", pedido=row,
                      meta=f"{TIPO_LABEL[body.tipo]} por {body.canal}")
    return dict(row)


async def _pedido(admin_conn: asyncpg.Connection, request_id: UUID) -> asyncpg.Record:
    row = await admin_conn.fetchrow(
        f"SELECT {_COLUNAS}, r.company_id::text FROM public.lgpd_requests r LEFT JOIN public.users u ON u.id = r.responsavel_id WHERE r.id = $1",
        request_id,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Pedido não encontrado.")
    return row


@router.get("/privacy/requests/{request_id}")
async def detalhe(
    request_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    p = await _pedido(admin_conn, request_id)
    await _exigir_admin(conn, claims, p["company_id"])
    eventos = await admin_conn.fetch(
        """
        SELECT e.tipo, e.detalhe, e.created_at, u.full_name AS autor
        FROM public.lgpd_request_events e LEFT JOIN public.users u ON u.id = e.user_id
        WHERE e.request_id = $1 ORDER BY e.created_at, e.id
        """,
        request_id,
    )
    return {**dict(p), "eventos": [dict(e) for e in eventos]}


@router.patch("/privacy/requests/{request_id}")
async def atualizar(
    request_id: UUID,
    body: PedidoMudanca,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    p = await _pedido(admin_conn, request_id)
    cid, uid = p["company_id"], claims["sub"]
    await _exigir_admin(conn, claims, cid)
    if p["status"] in ("concluido", "negado") and (body.status is None or body.status in ("concluido", "negado")) and body.nota is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Pedido já encerrado. Para mexer, reabra mudando a situação.")

    verificada = p["identidade_verificada"] if body.identidade_verificada is None else body.identidade_verificada
    resposta = (body.resposta.strip() if body.resposta is not None else p["resposta"]) or None
    if body.status == "concluido" and not verificada:
        raise HTTPException(status_code=422, detail="Confirme a identidade do titular antes de concluir (art. 18, § 6º não dispensa a verificação).")
    if body.status in ("concluido", "negado") and not resposta:
        raise HTTPException(status_code=422, detail="Escreva a resposta ao titular (no caso de negativa, o motivo) antes de encerrar.")
    if body.identidade_verificada and not (body.identidade_metodo or p["identidade_metodo"]):
        raise HTTPException(status_code=422, detail="Diga como a identidade foi conferida (ex.: documento com foto no balcão).")
    if body.responsavel_id is not None:
        membro = await admin_conn.fetchval(
            """
            SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2::uuid)
                OR EXISTS (SELECT 1 FROM public.group_member gm JOIN public.group_access ga ON ga.group_id = gm.group_id
                           WHERE gm.user_id = $1 AND ga.company_id = $2::uuid)
            """,
            body.responsavel_id, cid,
        )
        if not membro:
            raise HTTPException(status_code=422, detail="O responsável precisa ser alguém da empresa.")

    mudancas: list[str] = []
    async with admin_conn.transaction():
        if body.status is not None and body.status != p["status"]:
            await admin_conn.execute(
                "UPDATE public.lgpd_requests SET status = $2, concluido_at = CASE WHEN $2 IN ('concluido', 'negado') THEN now() ELSE NULL END WHERE id = $1",
                request_id, body.status,
            )
            await _evento(admin_conn, str(request_id), uid, "status", f"{p['status']} → {body.status}")
            mudancas.append(f"situação {body.status}")
        if body.responsavel_id is not None and str(body.responsavel_id) != p["responsavel_id"]:
            await admin_conn.execute("UPDATE public.lgpd_requests SET responsavel_id = $2 WHERE id = $1", request_id, body.responsavel_id)
            nome = await admin_conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", body.responsavel_id)
            await _evento(admin_conn, str(request_id), uid, "responsavel", nome)
            await _avisar(admin_conn, company_id=cid, request_id=str(request_id), ator=uid, so=str(body.responsavel_id),
                          msg=f"Você é responsável pelo pedido do titular {p['protocolo']} ({TIPO_LABEL[p['tipo']]}), prazo {p['prazo'].strftime('%d/%m/%Y')}.")
            mudancas.append("responsável")
        if body.identidade_verificada is not None and (body.identidade_verificada != p["identidade_verificada"] or body.identidade_metodo):
            metodo = (body.identidade_metodo or p["identidade_metodo"] or "").strip() or None
            await admin_conn.execute(
                "UPDATE public.lgpd_requests SET identidade_verificada = $2, identidade_metodo = $3 WHERE id = $1",
                request_id, body.identidade_verificada, metodo,
            )
            await _evento(admin_conn, str(request_id), uid, "identidade",
                          f"Identidade conferida: {metodo}" if body.identidade_verificada else "Verificação de identidade desfeita")
            mudancas.append("identidade")
        if body.prazo is not None and body.prazo != p["prazo"]:
            if body.prazo < date.today():
                raise HTTPException(status_code=422, detail="O prazo novo não pode estar no passado.")
            await admin_conn.execute("UPDATE public.lgpd_requests SET prazo = $2 WHERE id = $1", request_id, body.prazo)
            await _evento(admin_conn, str(request_id), uid, "prazo", f"{p['prazo'].strftime('%d/%m/%Y')} → {body.prazo.strftime('%d/%m/%Y')}")
            mudancas.append("prazo")
        if body.resposta is not None and resposta != p["resposta"]:
            await admin_conn.execute("UPDATE public.lgpd_requests SET resposta = $2 WHERE id = $1", request_id, resposta)
            await _evento(admin_conn, str(request_id), uid, "resposta", resposta)
            mudancas.append("resposta")
        if body.nota and body.nota.strip():
            await _evento(admin_conn, str(request_id), uid, "nota", body.nota.strip())
            mudancas.append("nota")
        if mudancas:
            await admin_conn.execute("UPDATE public.lgpd_requests SET updated_at = now() WHERE id = $1", request_id)
            await _trilha(admin_conn, user_id=uid, company_id=cid, action="lgpd_request_updated", pedido=p, meta=", ".join(mudancas))
    return await detalhe(request_id, conn=conn, admin_conn=admin_conn, claims=claims)


class CanalBody(BaseModel):
    enabled: bool


@router.get("/companies/{company_id}/privacy/channel")
async def canal(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    return {"enabled": bool(await admin_conn.fetchval("SELECT lgpd_channel_enabled FROM public.companies WHERE id = $1", company_id)),
            "path": f"/titular/{company_id}"}


@router.put("/companies/{company_id}/privacy/channel")
async def ligar_canal(
    company_id: UUID,
    body: CanalBody,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    await admin_conn.execute("UPDATE public.companies SET lgpd_channel_enabled = $2 WHERE id = $1", company_id, body.enabled)
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata)
        VALUES ($1::uuid, $2, 'lgpd_channel', 'config', $2, 'Canal do titular', 'config', jsonb_build_object('ligado', $3::boolean))
        """,
        claims["sub"], company_id, body.enabled,
    )
    return {"enabled": body.enabled, "path": f"/titular/{company_id}"}


# ---------------------------------------------------------------------------
# Canal público (sem login)
# ---------------------------------------------------------------------------

class PedidoPublico(BaseModel):
    tipo: Tipo
    titular_nome: str = Field(..., min_length=2, max_length=200)
    titular_cpf: str = Field(..., min_length=11, max_length=20)
    contato: str = Field(..., min_length=5, max_length=200)
    descricao: str | None = Field(None, max_length=2000)


class Acompanhar(BaseModel):
    protocolo: str = Field(..., min_length=6, max_length=40)
    codigo: str = Field(..., min_length=4, max_length=40)


async def _empresa_com_canal(admin_conn: asyncpg.Connection, company_id: UUID) -> str:
    nome = await admin_conn.fetchval(
        "SELECT name FROM public.companies WHERE id = $1 AND lgpd_channel_enabled AND is_active IS NOT FALSE", company_id,
    )
    if nome is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Canal não encontrado. Confira o endereço com a empresa.")
    return nome


@router.get("/public/titular/{company_id}")
async def canal_publico(company_id: UUID, admin_conn: asyncpg.Connection = Depends(get_db_admin)) -> dict[str, Any]:
    return {"company_name": await _empresa_com_canal(admin_conn, company_id), "prazo_dias": PRAZO_DIAS, "tipos": TIPO_LABEL}


@router.post("/public/titular/{company_id}", status_code=status.HTTP_201_CREATED)
async def pedido_publico(
    company_id: UUID,
    body: PedidoPublico,
    request: Request,
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
) -> dict[str, Any]:
    ip = rate_limit.client_ip_hash(request)
    if not rate_limit.check_and_record(f"lgpd-pedido:{ip}", 5, 3600):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Muitos pedidos deste endereço. Tente de novo em uma hora.")
    nome_empresa = await _empresa_com_canal(admin_conn, company_id)
    codigo = _aleatorio(8)
    async with admin_conn.transaction():
        row = await _criar(admin_conn, company_id=str(company_id), tipo=body.tipo, canal="formulario", nome=body.titular_nome,
                           cpf=body.titular_cpf, contato=body.contato, descricao=body.descricao, user_id=None, codigo=codigo)
        await _avisar(admin_conn, company_id=str(company_id), request_id=row["id"], ator=None,
                      msg=f"Pedido do titular {row['protocolo']} ({TIPO_LABEL[body.tipo]}) chegou pelo formulário. Prazo: {row['prazo'].strftime('%d/%m/%Y')}.")
    return {"protocolo": row["protocolo"], "codigo": codigo, "prazo": row["prazo"], "empresa": nome_empresa}


@router.post("/public/titular-status")
async def acompanhar(body: Acompanhar, request: Request, admin_conn: asyncpg.Connection = Depends(get_db_admin)) -> dict[str, Any]:
    ip = rate_limit.client_ip_hash(request)
    chave = f"lgpd-status:{ip}"
    if rate_limit.is_locked_out(chave):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Muitas tentativas. Espere alguns minutos.")
    row = await admin_conn.fetchrow(
        """
        SELECT r.protocolo, r.tipo, r.status, r.prazo, r.updated_at, r.codigo_hash, c.name AS empresa,
               CASE WHEN r.status IN ('concluido', 'negado') THEN r.resposta END AS resposta
        FROM public.lgpd_requests r JOIN public.companies c ON c.id = r.company_id
        WHERE r.protocolo = $1
        """,
        body.protocolo.strip().upper(),
    )
    if row is None or not row["codigo_hash"] or not secrets.compare_digest(row["codigo_hash"], _sha(body.codigo.strip().upper())):
        rate_limit.record_failed_attempt(chave, 10, 900, 900)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Protocolo ou código não conferem.")
    return {k: row[k] for k in ("protocolo", "tipo", "status", "prazo", "updated_at", "empresa", "resposta")}
