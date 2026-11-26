import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Inbox, Plus, Link2, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import Input from "@/components/ui/Input";
import Switch from "@/components/ui/Switch";
import Checkbox from "@/components/ui/Checkbox";

/*
 * Pedidos do titular (LGPD art. 18 e 19; benchmark B3.7.2): fila com prazo,
 * responsável, verificação de identidade, resposta e histórico; e o canal
 * público da empresa (formulário com protocolo e código para acompanhar).
 */

export const TIPOS: Record<string, string> = {
  confirmacao: "Confirmação de tratamento", acesso: "Acesso aos dados", correcao: "Correção", eliminacao: "Eliminação",
  portabilidade: "Portabilidade", anonimizacao: "Anonimização ou bloqueio", informacao: "Informação sobre compartilhamento",
  revogacao: "Revogação do consentimento", oposicao: "Oposição ao tratamento",
};
const CANAIS: Record<string, string> = { formulario: "Formulário", email: "E-mail", telefone: "Telefone", presencial: "Presencial", outro: "Outro" };
const STATUS: Record<string, string> = { recebido: "Recebido", verificando: "Conferindo identidade", em_andamento: "Em atendimento", concluido: "Concluído", negado: "Não atendido" };

interface Pedido {
  id: string; protocolo: string; tipo: string; canal: string; titular_nome: string; titular_cpf_final: string | null; contato: string | null;
  descricao: string | null; status: string; identidade_verificada: boolean; identidade_metodo: string | null; responsavel_id: string | null;
  responsavel_nome: string | null; prazo: string; resposta: string | null; created_at: string; atrasado: boolean;
  eventos?: { tipo: string; detalhe: string | null; created_at: string; autor: string | null }[];
}

const erro = (e: any, padrao: string) => (typeof e?.response?.data?.detail === "string" ? e.response.data.detail : padrao);
const dia = (d: string) => new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("pt-BR");
const diasAte = (d: string) => Math.round((new Date(d + "T12:00:00").getTime() - Date.now()) / 86400000);

function Prazo({ p }: { p: Pedido }) {
  if (p.status === "concluido" || p.status === "negado") return <span className="inline-flex items-center gap-1 text-(--text-success)"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden />{STATUS[p.status]}</span>;
  const n = diasAte(p.prazo);
  if (p.atrasado) return <span className="inline-flex items-center gap-1 text-(--text-danger)"><AlertTriangle className="w-3.5 h-3.5" aria-hidden />Atrasado desde {dia(p.prazo)}</span>;
  return <span className={`inline-flex items-center gap-1 ${n <= 3 ? "text-(--text-warning)" : "text-(--text-secondary)"}`}><Clock className="w-3.5 h-3.5" aria-hidden />{n === 0 ? "Vence hoje" : `Vence em ${n} ${n === 1 ? "dia" : "dias"}`} ({dia(p.prazo)})</span>;
}

function NovoPedido({ companyId, onClose, onDone }: { companyId: string; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [f, setF] = useState({ tipo: "acesso", canal: "email", titular_nome: "", titular_cpf: "", contato: "", descricao: "" });
  const [busy, setBusy] = useState(false);
  async function salvar() {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${companyId}/privacy/requests`, { ...f, titular_cpf: f.titular_cpf || null, contato: f.contato || null, descricao: f.descricao || null });
      success(`Pedido ${r.data.protocolo} registrado; prazo ${dia(r.data.prazo)}.`);
      onDone(); onClose();
    } catch (e) { showError(erro(e, "Não foi possível registrar o pedido.")); } finally { setBusy(false); }
  }
  return (
    <Dialog onClose={onClose} size="md" busy={busy} title="Registrar pedido do titular"
      description="Para pedidos que chegaram por e-mail, telefone ou no balcão. O prazo de resposta é de 15 dias."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={f.titular_nome.trim().length < 2} onClick={salvar}>Registrar</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div><span id="np-tipo" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Pedido</span>
          <Dropdown ariaLabelledby="np-tipo" value={f.tipo} onChange={(v) => setF({ ...f, tipo: v })} options={Object.entries(TIPOS).map(([value, label]) => ({ value, label }))} /></div>
        <div><span id="np-canal" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Chegou por</span>
          <Dropdown ariaLabelledby="np-canal" value={f.canal} onChange={(v) => setF({ ...f, canal: v })} options={Object.entries(CANAIS).filter(([v]) => v !== "formulario").map(([value, label]) => ({ value, label }))} /></div>
        <Input label="Nome do titular" value={f.titular_nome} maxLength={200} onChange={(e) => setF({ ...f, titular_nome: e.target.value })} />
        <Input label="CPF (opcional)" value={f.titular_cpf} maxLength={14} inputMode="numeric" onChange={(e) => setF({ ...f, titular_cpf: e.target.value })} placeholder="000.000.000-00" />
        <div className="sm:col-span-2"><Input label="Contato para a resposta (opcional)" value={f.contato} maxLength={200} onChange={(e) => setF({ ...f, contato: e.target.value })} /></div>
        <div className="sm:col-span-2 flex flex-col gap-1">
          <label htmlFor="np-desc" className="text-mac-body font-medium text-(--text-secondary)">O que a pessoa pediu (opcional)</label>
          <textarea id="np-desc" rows={2} maxLength={2000} value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })}
            className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
        </div>
      </div>
    </Dialog>
  );
}

function Atendimento({ id, companyId, onClose, onChanged }: { id: string; companyId: string; onClose: () => void; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [p, setP] = useState<Pedido | null>(null);
  const [pessoas, setPessoas] = useState<{ user_id: string; full_name: string; is_active: boolean }[]>([]);
  const [metodo, setMetodo] = useState("");
  const [resposta, setResposta] = useState("");
  const [nota, setNota] = useState("");
  const [busy, setBusy] = useState(false);
  function carregar() {
    api.get<Pedido>(`/privacy/requests/${id}`).then((r) => { setP(r.data); setResposta(r.data.resposta ?? ""); setMetodo(r.data.identidade_metodo ?? ""); })
      .catch((e) => { showError(erro(e, "Pedido não encontrado.")); onClose(); });
  }
  useEffect(carregar, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get(`/companies/${companyId}/people`).then((r) => setPessoas(r.data.filter((x: any) => x.is_active))).catch(() => {}); }, [companyId]);

  async function mudar(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      const r = await api.patch<Pedido>(`/privacy/requests/${id}`, body);
      setP(r.data); setNota(""); success(ok); onChanged();
    } catch (e) { showError(erro(e, "Não foi possível salvar.")); } finally { setBusy(false); }
  }
  if (!p) return null;
  const aberto = p.status !== "concluido" && p.status !== "negado";
  return (
    <Dialog onClose={onClose} size="lg" busy={busy} title={`${TIPOS[p.tipo]} · ${p.protocolo}`}
      description={<>{p.titular_nome}{p.titular_cpf_final ? ` · CPF terminado em ${p.titular_cpf_final}` : ""}{p.contato ? ` · ${p.contato}` : ""} · {CANAIS[p.canal]} em {dia(p.created_at)}</>}
      footer={<Button variant="secondary" onClick={onClose}>Fechar</Button>}>
      <div className="space-y-4">
        <p className="text-mac-caption"><Prazo p={p} /></p>
        {p.descricao && <p className="whitespace-pre-wrap rounded-(--radius-control) bg-(--bg-hover) px-3 py-2 text-mac-body text-(--text-primary)">{p.descricao}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><span id="at-status" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Situação</span>
            <Dropdown ariaLabelledby="at-status" value={p.status} disabled={busy}
              onChange={(v) => mudar({ status: v, resposta: resposta || undefined }, `Situação: ${STATUS[v].toLowerCase()}.`)}
              options={Object.entries(STATUS).map(([value, label]) => ({ value, label }))} /></div>
          <div><span id="at-resp" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Responsável</span>
            <Dropdown ariaLabelledby="at-resp" value={p.responsavel_id ?? ""} disabled={busy || !aberto} placeholder="Ninguém ainda"
              onChange={(v) => v && mudar({ responsavel_id: v }, "Responsável definido e avisado.")}
              options={[{ value: "", label: "Ninguém ainda" }, ...pessoas.map((x) => ({ value: x.user_id, label: x.full_name }))]} /></div>
        </div>
        <fieldset className="rounded-(--radius-control) border border-(--border-default) p-3 space-y-2">
          <legend className="px-1 text-mac-body font-medium text-(--text-secondary)">Identidade do titular</legend>
          {p.identidade_verificada ? (
            <p className="text-mac-body text-(--text-primary)"><CheckCircle2 className="inline w-4 h-4 mr-1 text-(--text-success)" aria-hidden />Conferida: {p.identidade_metodo}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[14rem]"><Input label="Como foi conferida" value={metodo} maxLength={200} onChange={(e) => setMetodo(e.target.value)} placeholder="Ex.: RG com foto no balcão" /></div>
              <Button variant="secondary" disabled={busy || !metodo.trim() || !aberto} onClick={() => mudar({ identidade_verificada: true, identidade_metodo: metodo.trim() }, "Identidade registrada.")}>Marcar como conferida</Button>
            </div>
          )}
        </fieldset>
        <div className="flex flex-col gap-1">
          <label htmlFor="at-resposta" className="text-mac-body font-medium text-(--text-secondary)">Resposta ao titular</label>
          <textarea id="at-resposta" rows={3} maxLength={4000} value={resposta} disabled={!aberto} onChange={(e) => setResposta(e.target.value)}
            placeholder="O que foi feito ou, se não for possível atender, o motivo (ex.: prazo legal de guarda)."
            className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) disabled:opacity-70" />
          {aberto && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={busy || resposta === (p.resposta ?? "")} onClick={() => mudar({ resposta }, "Resposta salva.")}>Salvar rascunho</Button>
              <Button size="sm" disabled={busy || !resposta.trim() || !p.identidade_verificada} onClick={() => mudar({ status: "concluido", resposta }, "Pedido concluído.")}>Concluir</Button>
              <Button variant="danger" size="sm" disabled={busy || !resposta.trim()} onClick={() => mudar({ status: "negado", resposta }, "Pedido encerrado sem atendimento.")}>Negar com o motivo</Button>
            </div>
          )}
          {p.canal === "formulario" && <p className="text-mac-caption text-(--text-secondary)">Quem pediu pelo formulário vê a resposta ao consultar com o protocolo e o código.</p>}
        </div>
        <div>
          <p className="mb-1 text-mac-body font-medium text-(--text-secondary)">Histórico</p>
          <ol className="space-y-1 text-mac-caption">
            {(p.eventos ?? []).map((e, i) => (
              <li key={i} className="flex gap-2"><span className="shrink-0 text-(--text-tertiary)">{new Date(e.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="text-(--text-primary)">{e.autor ? `${e.autor}: ` : ""}{e.detalhe}</span></li>
            ))}
          </ol>
          <div className="mt-2 flex items-end gap-2">
            <div className="flex-1"><Input label="Anotação" value={nota} maxLength={2000} onChange={(e) => setNota(e.target.value)} placeholder="Ex.: pedi cópia do RG por e-mail" /></div>
            <Button variant="secondary" disabled={busy || !nota.trim()} onClick={() => mudar({ nota }, "Anotação registrada.")}>Anotar</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export default function LgpdRequests({ companyId }: { companyId: string }) {
  const { success, error: showError } = useToast();
  const [params, setParams] = useSearchParams();
  const [lista, setLista] = useState<Pedido[] | null>(null);
  const [canal, setCanal] = useState<{ enabled: boolean; path: string } | null>(null);
  const [novo, setNovo] = useState(false);
  const [mostrarEncerrados, setMostrarEncerrados] = useState(false);
  const aberto = params.get("pedido");

  function carregar() { api.get<Pedido[]>(`/companies/${companyId}/privacy/requests`).then((r) => setLista(r.data)).catch(() => setLista([])); }
  useEffect(() => {
    carregar();
    api.get(`/companies/${companyId}/privacy/channel`).then((r) => setCanal(r.data)).catch(() => setCanal(null));
  }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ligar(v: boolean) {
    try { const r = await api.put(`/companies/${companyId}/privacy/channel`, { enabled: v }); setCanal(r.data); success(v ? "Canal do titular ligado." : "Canal do titular desligado."); }
    catch (e) { showError(erro(e, "Não foi possível mudar o canal.")); }
  }
  const url = canal ? `${window.location.origin}${canal.path}` : "";
  const abrir = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set("pedido", id); else n.delete("pedido"); setParams(n, { replace: true }); };
  const visiveis = (lista ?? []).filter((p) => mostrarEncerrados || (p.status !== "concluido" && p.status !== "negado"));
  const encerrados = (lista ?? []).length - (lista ?? []).filter((p) => p.status !== "concluido" && p.status !== "negado").length;

  return (
    <section className="glass-panel rounded-(--radius-panel) p-5 space-y-3" aria-labelledby="lgpd-pedidos">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="lgpd-pedidos" className="flex-1 flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><Inbox className="w-4 h-4 text-(--text-accent)" aria-hidden /> Pedidos do titular</h3>
        <Button size="sm" variant="secondary" onClick={() => setNovo(true)}><Plus className="w-3.5 h-3.5" aria-hidden />Registrar pedido</Button>
      </div>
      <p className="text-mac-caption text-(--text-secondary)">Cada pedido tem protocolo, prazo de 15 dias (art. 19), responsável, conferência de identidade e histórico. Tudo fica na trilha de auditoria.</p>
      {canal && (
        <div className="flex flex-wrap items-center gap-3 rounded-(--radius-control) border border-(--border-default) px-3 py-2">
          <Switch checked={canal.enabled} onChange={ligar} label="Canal público do titular" />
          <span className="flex-1 min-w-[12rem] text-mac-body text-(--text-primary)">Formulário público para o titular {canal.enabled ? "ligado" : "desligado"}</span>
          {canal.enabled && <Button size="sm" variant="secondary" onClick={() => { navigator.clipboard?.writeText(url); success("Endereço do canal copiado. Publique no site ou na política de privacidade."); }}><Link2 className="w-3.5 h-3.5" aria-hidden />Copiar endereço</Button>}
        </div>
      )}
      {lista === null ? <div className="h-16 animate-pulse rounded-(--radius-control) bg-(--bg-card)" /> : visiveis.length === 0 ? (
        <p className="text-mac-body text-(--text-tertiary)">Nenhum pedido em aberto.</p>
      ) : (
        <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
          {visiveis.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => abrir(p.id)} className="w-full text-left px-3 py-2 hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) rounded-sm">
                <span className="block text-mac-body text-(--text-primary) truncate">{TIPOS[p.tipo]} · {p.titular_nome} <span className="text-(--text-tertiary) font-mono text-mac-caption">{p.protocolo}</span></span>
                <span className="flex flex-wrap gap-x-3 text-mac-caption text-(--text-secondary)"><Prazo p={p} /><span>{STATUS[p.status]}</span><span>{p.responsavel_nome ?? "sem responsável"}</span>{!p.identidade_verificada && <span>identidade não conferida</span>}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {encerrados > 0 && (
        <label className="flex items-center gap-2 text-mac-caption text-(--text-secondary) cursor-pointer">
          <Checkbox checked={mostrarEncerrados} onChange={(e) => setMostrarEncerrados(e.target.checked)} />Mostrar os {encerrados} encerrados
        </label>
      )}
      {novo && <NovoPedido companyId={companyId} onClose={() => setNovo(false)} onDone={carregar} />}
      {aberto && <Atendimento id={aberto} companyId={companyId} onClose={() => abrir(null)} onChanged={carregar} />}
    </section>
  );
}
