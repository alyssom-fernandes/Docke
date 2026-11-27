"""
Registro de incidentes de segurança com dados pessoais (LGPD art. 48;
Resolução CD/ANPD 15/2024; parte que faltava do achado X2-17).

Quando a empresa sabe de um incidente (vazamento, acesso indevido, perda de
arquivo, link público aberto por engano), o admin registra o que houve, os
dados e o número de titulares afetados. O Docke conta o prazo de 3 dias
úteis para comunicar a ANPD e os titulares, a partir de quando a empresa
soube, e pede a avaliação de risco: se o incidente pode causar risco ou dano
relevante, encerrar exige as duas comunicações; se não pode, exige o motivo
escrito. Tudo fica no histórico do incidente e na trilha de auditoria.

O prazo conta só sábados e domingos como dias não úteis: feriados variam por
município e a tela avisa para conferir.
"""
import secrets
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.dependencies import get_app_role, get_current_user, get_db, get_db_admin
from app.services.companies_service import CompaniesService

router = APIRouter(tags=["security-incidents"])

Categoria = Literal["identificacao", "contato", "documentos", "financeiro", "saude", "trabalhista", "credenciais", "criancas", "outros"]
Status = Literal["aberto", "contido", "encerrado"]
PRAZO_DIAS_UTEIS = 3
CATEGORIA_LABEL = {
    "identificacao": "identificação (nome, CPF, RG)", "contato": "contato (e-mail, telefone, endereço)",
    "documentos": "documentos digitalizados", "financeiro": "dados financeiros e bancários",
    "saude": "saúde (ASO, atestados)", "trabalhista": "dados trabalhistas (holerite, contrato)",
    "credenciais": "senhas e credenciais", "criancas": "dados de crianças ou adolescentes", "outros": "outros",
}
SENSIVEIS = {"saude", "criancas", "credenciais", "financeiro"}
_ALFABETO = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def somar_dias_uteis(inicio: date, dias: int) -> date:
    """Conta `dias` dias úteis depois de `inicio` (sábado e domingo não contam)."""
    d = inicio
    while dias > 0:
        d += timedelta(days=1)
        if d.weekday() < 5:
            dias -= 1
    return d


def prazo_comunicacao(descoberto_em: datetime) -> date:
    return somar_dias_uteis(descoberto_em.astimezone(timezone(timedelta(hours=-3))).date(), PRAZO_DIAS_UTEIS)


def pendencias_para_encerrar(inc: dict[str, Any]) -> list[str]:
    """O que falta para encerrar o incidente (lista vazia: pode encerrar)."""
    faltam: list[str] = []
    if not (inc.get("medidas") or "").strip():
        faltam.append("as medidas tomadas para conter e reduzir os efeitos")
    if inc.get("risco_relevante") is None:
        faltam.append("a avaliação de risco (se o incidente pode causar risco ou dano relevante aos titulares)")
    elif inc["risco_relevante"]:
        if not inc.get("comunicado_anpd_em"):
            faltam.append("a data da comunicação à ANPD")
        if not inc.get("comunicado_titulares_em"):
            faltam.append("a data da comunicação aos titulares")
    elif not (inc.get("avaliacao_risco") or "").strip():
        faltam.append("o motivo de o risco não ser relevante")
    return faltam


async def _exigir_admin(conn: asyncpg.Connection, claims: dict[str, Any], company_id: UUID | str) -> None:
    if await get_app_role(conn, claims) == "supremo":
        return
    if not await CompaniesService.user_manages_company(conn, claims["sub"], UUID(str(company_id))):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Só administradores da empresa registram incidentes de segurança.")


_COLUNAS = """
  i.id::text, i.protocolo, i.titulo, i.descricao, i.descoberto_em, i.ocorrido_em, i.categorias, i.titulares_afetados,
  i.risco_relevante, i.avaliacao_risco, i.medidas, i.comunicado_anpd_em, i.protocolo_anpd, i.comunicado_titulares_em,
  i.status, i.responsavel_id::text, u.full_name AS responsavel_nome, i.created_at, i.updated_at, i.encerrado_at
"""


def _com_prazo(row: asyncpg.Record) -> dict[str, Any]:
    d = dict(row)
    prazo = prazo_comunicacao(d["descoberto_em"])
    d["prazo_comunicacao"] = prazo
    hoje = datetime.now(timezone(timedelta(hours=-3))).date()
    falta_comunicar = d["risco_relevante"] is not False and not (d["comunicado_anpd_em"] and d["comunicado_titulares_em"])
    d["comunicacao_atrasada"] = d["status"] != "encerrado" and falta_comunicar and hoje > prazo
    d["dados_sensiveis"] = bool(SENSIVEIS & set(d["categorias"] or []))
    d["pendencias_para_encerrar"] = pendencias_para_encerrar(d)
    return d


async def _evento(admin_conn: asyncpg.Connection, incident_id: str, user_id: str | None, tipo: str, detalhe: str | None) -> None:
    await admin_conn.execute(
        "INSERT INTO public.security_incident_events (incident_id, user_id, tipo, detalhe) VALUES ($1::uuid, $2::uuid, $3, $4)",
        incident_id, user_id, tipo, (detalhe or None) and detalhe[:4000],
    )


async def _trilha(admin_conn: asyncpg.Connection, *, user_id: str, company_id: str, action: str, inc: Any, meta: str) -> None:
    await admin_conn.execute(
        """
        INSERT INTO public.activity_log (user_id, company_id, action, item_type, item_id, item_name_snapshot, event_category, metadata, severity)
        VALUES ($1::uuid, $2::uuid, $3, 'config', $4::uuid, $5, 'config', jsonb_build_object('protocolo', $6::text, 'detalhe', $7::text), 'critical')
        """,
        user_id, company_id, action, str(inc["id"]), f"Incidente de segurança {inc['protocolo']}", inc["protocolo"], meta,
    )


async def _avisar_admins(admin_conn: asyncpg.Connection, *, company_id: str, incident_id: str, ator: str, msg: str) -> None:
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
            VALUES ($1::uuid, $2::uuid, 'security_incident', 'security_incident', $3::uuid, $4::uuid, $5)
            """,
            alvo, company_id, incident_id, ator, msg,
        )


class IncidenteNovo(BaseModel):
    titulo: str = Field(min_length=3, max_length=200)
    descricao: str | None = Field(default=None, max_length=4000)
    descoberto_em: datetime | None = None
    ocorrido_em: datetime | None = None
    categorias: list[Categoria] = Field(default_factory=list)
    titulares_afetados: int | None = Field(default=None, ge=0)
    medidas: str | None = Field(default=None, max_length=4000)


class IncidenteMudanca(BaseModel):
    status: Status | None = None
    responsavel_id: UUID | None = None
    categorias: list[Categoria] | None = None
    titulares_afetados: int | None = Field(default=None, ge=0)
    risco_relevante: bool | None = None
    avaliacao_risco: str | None = Field(default=None, max_length=4000)
    medidas: str | None = Field(default=None, max_length=4000)
    comunicado_anpd_em: datetime | None = None
    protocolo_anpd: str | None = Field(default=None, max_length=100)
    comunicado_titulares_em: datetime | None = None
    nota: str | None = Field(default=None, max_length=4000)


@router.get("/companies/{company_id}/privacy/incidents")
async def listar(
    company_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> list[dict[str, Any]]:
    await _exigir_admin(conn, claims, company_id)
    rows = await admin_conn.fetch(
        f"""
        SELECT {_COLUNAS} FROM public.security_incidents i LEFT JOIN public.users u ON u.id = i.responsavel_id
        WHERE i.company_id = $1
        ORDER BY (i.status = 'encerrado'), i.descoberto_em DESC
        LIMIT 500
        """,
        company_id,
    )
    return [_com_prazo(r) for r in rows]


@router.post("/companies/{company_id}/privacy/incidents", status_code=status.HTTP_201_CREATED)
async def registrar(
    company_id: UUID,
    body: IncidenteNovo,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    await _exigir_admin(conn, claims, company_id)
    agora = datetime.now(timezone.utc)
    descoberto = body.descoberto_em or agora
    if descoberto.tzinfo is None:
        descoberto = descoberto.replace(tzinfo=timezone.utc)
    if descoberto > agora + timedelta(minutes=5):
        raise HTTPException(status_code=422, detail="A data em que a empresa soube do incidente não pode estar no futuro.")
    if body.ocorrido_em and body.ocorrido_em.replace(tzinfo=body.ocorrido_em.tzinfo or timezone.utc) > descoberto:
        raise HTTPException(status_code=422, detail="O incidente não pode ter ocorrido depois de a empresa saber dele.")
    uid = claims["sub"]
    async with admin_conn.transaction():
        row = None
        for _ in range(5):
            protocolo = f"INC-{date.today().year}-{''.join(secrets.choice(_ALFABETO) for _ in range(6))}"
            try:
                async with admin_conn.transaction():
                    row = await admin_conn.fetchrow(
                        """
                        INSERT INTO public.security_incidents (company_id, protocolo, titulo, descricao, descoberto_em, ocorrido_em,
                                                               categorias, titulares_afetados, medidas, created_by, responsavel_id)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $10::uuid)
                        RETURNING id::text, protocolo
                        """,
                        company_id, protocolo, body.titulo.strip(), (body.descricao or "").strip() or None, descoberto,
                        body.ocorrido_em, list(dict.fromkeys(body.categorias)), body.titulares_afetados,
                        (body.medidas or "").strip() or None, uid,
                    )
                break
            except asyncpg.UniqueViolationError:
                continue
        if row is None:
            raise HTTPException(status_code=500, detail="Não foi possível gerar o protocolo. Tente de novo.")
        await _evento(admin_conn, row["id"], uid, "criado", body.titulo.strip())
        await _trilha(admin_conn, user_id=uid, company_id=str(company_id), action="security_incident_created", inc=row,
                      meta=", ".join(CATEGORIA_LABEL[c] for c in body.categorias) or "categorias a definir")
        prazo = prazo_comunicacao(descoberto)
        await _avisar_admins(admin_conn, company_id=str(company_id), incident_id=row["id"], ator=uid,
                             msg=f"Incidente de segurança {row['protocolo']} registrado: avalie o risco até {prazo.strftime('%d/%m/%Y')}.")
    return await detalhe(UUID(row["id"]), conn=conn, admin_conn=admin_conn, claims=claims)


async def _incidente(admin_conn: asyncpg.Connection, incident_id: UUID) -> asyncpg.Record:
    row = await admin_conn.fetchrow(
        f"SELECT {_COLUNAS}, i.company_id::text FROM public.security_incidents i LEFT JOIN public.users u ON u.id = i.responsavel_id WHERE i.id = $1",
        incident_id,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Incidente não encontrado.")
    return row


@router.get("/privacy/incidents/{incident_id}")
async def detalhe(
    incident_id: UUID,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    inc = await _incidente(admin_conn, incident_id)
    await _exigir_admin(conn, claims, inc["company_id"])
    eventos = await admin_conn.fetch(
        """
        SELECT e.tipo, e.detalhe, e.created_at, u.full_name AS autor
        FROM public.security_incident_events e LEFT JOIN public.users u ON u.id = e.user_id
        WHERE e.incident_id = $1 ORDER BY e.created_at, e.id
        """,
        incident_id,
    )
    return {**_com_prazo(inc), "eventos": [dict(e) for e in eventos]}


def _fmt(dt: datetime | None) -> str:
    return dt.astimezone(timezone(timedelta(hours=-3))).strftime("%d/%m/%Y %H:%M") if dt else "—"


@router.patch("/privacy/incidents/{incident_id}")
async def atualizar(
    incident_id: UUID,
    body: IncidenteMudanca,
    conn: asyncpg.Connection = Depends(get_db),
    admin_conn: asyncpg.Connection = Depends(get_db_admin),
    claims: dict[str, Any] = Depends(get_current_user),
) -> dict[str, Any]:
    inc = await _incidente(admin_conn, incident_id)
    cid, uid = inc["company_id"], claims["sub"]
    await _exigir_admin(conn, claims, cid)
    enviados = body.model_fields_set
    if inc["status"] == "encerrado" and not (body.status in ("aberto", "contido") or enviados <= {"nota"}):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Incidente encerrado. Para mexer, reabra mudando a situação.")

    # Como fica depois desta mudança: é o que decide se pode encerrar.
    novo = dict(inc)
    for campo in ("categorias", "titulares_afetados", "risco_relevante", "avaliacao_risco", "medidas",
                  "comunicado_anpd_em", "protocolo_anpd", "comunicado_titulares_em"):
        if campo in enviados:
            valor = getattr(body, campo)
            novo[campo] = (valor.strip() or None) if isinstance(valor, str) else valor
    agora = datetime.now(timezone.utc)
    for campo, nome in (("comunicado_anpd_em", "à ANPD"), ("comunicado_titulares_em", "aos titulares")):
        valor = novo[campo]
        if campo in enviados and valor is not None:
            if valor.tzinfo is None:
                valor = novo[campo] = valor.replace(tzinfo=timezone.utc)
            if valor > agora + timedelta(minutes=5):
                raise HTTPException(status_code=422, detail=f"A comunicação {nome} não pode ter data no futuro.")
            if valor < inc["descoberto_em"] - timedelta(days=1):
                raise HTTPException(status_code=422, detail=f"A comunicação {nome} não pode ser anterior a quando a empresa soube do incidente.")
    if body.status == "encerrado":
        faltam = pendencias_para_encerrar(novo)
        if faltam:
            raise HTTPException(status_code=422, detail="Para encerrar, registre " + "; ".join(faltam) + ".")
    if "responsavel_id" in enviados and body.responsavel_id is not None:
        membro = await admin_conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM public.user_company_access WHERE user_id = $1 AND company_id = $2::uuid)",
            body.responsavel_id, cid,
        )
        if not membro:
            raise HTTPException(status_code=422, detail="O responsável precisa ser alguém da empresa.")

    mudancas: list[str] = []
    async with admin_conn.transaction():
        if "categorias" in enviados and set(novo["categorias"] or []) != set(inc["categorias"] or []):
            cats = list(dict.fromkeys(novo["categorias"] or []))
            await admin_conn.execute("UPDATE public.security_incidents SET categorias = $2 WHERE id = $1", incident_id, cats)
            await _evento(admin_conn, str(incident_id), uid, "dados", ", ".join(CATEGORIA_LABEL[c] for c in cats) or "nenhuma")
            mudancas.append("dados afetados")
        if "titulares_afetados" in enviados and novo["titulares_afetados"] != inc["titulares_afetados"]:
            await admin_conn.execute("UPDATE public.security_incidents SET titulares_afetados = $2 WHERE id = $1", incident_id, novo["titulares_afetados"])
            await _evento(admin_conn, str(incident_id), uid, "dados", f"Titulares afetados: {novo['titulares_afetados']}")
            mudancas.append("titulares")
        if ({"risco_relevante", "avaliacao_risco"} & enviados) and (
                novo["risco_relevante"] != inc["risco_relevante"] or novo["avaliacao_risco"] != inc["avaliacao_risco"]):
            await admin_conn.execute(
                "UPDATE public.security_incidents SET risco_relevante = $2, avaliacao_risco = $3 WHERE id = $1",
                incident_id, novo["risco_relevante"], novo["avaliacao_risco"],
            )
            rotulo = {True: "Pode causar risco ou dano relevante: comunicar ANPD e titulares",
                      False: "Sem risco ou dano relevante", None: "Avaliação de risco desfeita"}[novo["risco_relevante"]]
            await _evento(admin_conn, str(incident_id), uid, "risco", rotulo + (f". {novo['avaliacao_risco']}" if novo["avaliacao_risco"] else ""))
            mudancas.append("avaliação de risco")
        if "medidas" in enviados and novo["medidas"] != inc["medidas"]:
            await admin_conn.execute("UPDATE public.security_incidents SET medidas = $2 WHERE id = $1", incident_id, novo["medidas"])
            await _evento(admin_conn, str(incident_id), uid, "medidas", novo["medidas"])
            mudancas.append("medidas")
        if ({"comunicado_anpd_em", "protocolo_anpd"} & enviados) and (
                novo["comunicado_anpd_em"] != inc["comunicado_anpd_em"] or novo["protocolo_anpd"] != inc["protocolo_anpd"]):
            await admin_conn.execute(
                "UPDATE public.security_incidents SET comunicado_anpd_em = $2, protocolo_anpd = $3 WHERE id = $1",
                incident_id, novo["comunicado_anpd_em"], novo["protocolo_anpd"],
            )
            await _evento(admin_conn, str(incident_id), uid, "anpd",
                          f"Comunicado à ANPD em {_fmt(novo['comunicado_anpd_em'])}" + (f", protocolo {novo['protocolo_anpd']}" if novo["protocolo_anpd"] else ""))
            mudancas.append("comunicação à ANPD")
        if "comunicado_titulares_em" in enviados and novo["comunicado_titulares_em"] != inc["comunicado_titulares_em"]:
            await admin_conn.execute("UPDATE public.security_incidents SET comunicado_titulares_em = $2 WHERE id = $1",
                                     incident_id, novo["comunicado_titulares_em"])
            await _evento(admin_conn, str(incident_id), uid, "titulares", f"Titulares comunicados em {_fmt(novo['comunicado_titulares_em'])}")
            mudancas.append("comunicação aos titulares")
        if "responsavel_id" in enviados and (str(body.responsavel_id) if body.responsavel_id else None) != inc["responsavel_id"]:
            await admin_conn.execute("UPDATE public.security_incidents SET responsavel_id = $2 WHERE id = $1", incident_id, body.responsavel_id)
            nome = await admin_conn.fetchval("SELECT full_name FROM public.users WHERE id = $1", body.responsavel_id) if body.responsavel_id else "ninguém"
            await _evento(admin_conn, str(incident_id), uid, "responsavel", nome)
            mudancas.append("responsável")
        if body.status is not None and body.status != inc["status"]:
            await admin_conn.execute(
                "UPDATE public.security_incidents SET status = $2, encerrado_at = CASE WHEN $2 = 'encerrado' THEN now() ELSE NULL END WHERE id = $1",
                incident_id, body.status,
            )
            await _evento(admin_conn, str(incident_id), uid, "status", f"{inc['status']} → {body.status}")
            mudancas.append(f"situação {body.status}")
        if body.nota and body.nota.strip():
            await _evento(admin_conn, str(incident_id), uid, "nota", body.nota.strip())
            mudancas.append("nota")
        if mudancas:
            await admin_conn.execute("UPDATE public.security_incidents SET updated_at = now() WHERE id = $1", incident_id)
            await _trilha(admin_conn, user_id=uid, company_id=cid, action="security_incident_updated", inc=inc, meta=", ".join(mudancas))
    return await detalhe(incident_id, conn=conn, admin_conn=admin_conn, claims=claims)
