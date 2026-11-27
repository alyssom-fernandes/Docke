import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ShieldAlert, Plus, Clock, CheckCircle2, AlertTriangle } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import Input from "@/components/ui/Input";
import Checkbox from "@/components/ui/Checkbox";

/*
 * Incidentes de segurança com dados pessoais (LGPD art. 48; Resolução
 * CD/ANPD 15/2024): registro com o que houve, os dados e os titulares
 * afetados, a avaliação de risco, as medidas e as comunicações à ANPD e aos
 * titulares, com o prazo de 3 dias úteis contado de quando a empresa soube.
 */

const CATEGORIAS: Record<string, string> = {
  identificacao: "Identificação (nome, CPF, RG)", contato: "Contato (e-mail, telefone, endereço)",
  documentos: "Documentos digitalizados", financeiro: "Financeiros e bancários", saude: "Saúde (ASO, atestados)",
  trabalhista: "Trabalhistas (holerite, contrato)", credenciais: "Senhas e credenciais",
  criancas: "De crianças ou adolescentes", outros: "Outros",
};
const STATUS: Record<string, string> = { aberto: "Aberto", contido: "Contido", encerrado: "Encerrado" };

interface Incidente {
  id: string; protocolo: string; titulo: string; descricao: string | null; descoberto_em: string; ocorrido_em: string | null;
  categorias: string[]; titulares_afetados: number | null; risco_relevante: boolean | null; avaliacao_risco: string | null;
  medidas: string | null; comunicado_anpd_em: string | null; protocolo_anpd: string | null; comunicado_titulares_em: string | null;
  status: string; responsavel_id: string | null; responsavel_nome: string | null; prazo_comunicacao: string;
  comunicacao_atrasada: boolean; dados_sensiveis: boolean; pendencias_para_encerrar: string[];
  eventos?: { tipo: string; detalhe: string | null; created_at: string; autor: string | null }[];
}

const erro = (e: any, padrao: string) => (typeof e?.response?.data?.detail === "string" ? e.response.data.detail : padrao);
const dia = (d: string) => new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("pt-BR");
const quando = (d: string) => new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
/** Valor para <input type="datetime-local"> no fuso de quem usa. */
const paraCampo = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const doCampo = (v: string) => (v ? new Date(v).toISOString() : null);
const campoCls = "w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) disabled:opacity-70";

function PrazoComunicacao({ i }: { i: Incidente }) {
  if (i.status === "encerrado") return <span className="inline-flex items-center gap-1 text-(--text-success)"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden />Encerrado</span>;
  if (i.risco_relevante === false) return <span className="text-(--text-secondary)">Sem risco relevante: comunicação não exigida</span>;
  if (i.comunicado_anpd_em && i.comunicado_titulares_em) return <span className="inline-flex items-center gap-1 text-(--text-success)"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden />ANPD e titulares comunicados</span>;
  if (i.comunicacao_atrasada) return <span className="inline-flex items-center gap-1 text-(--text-danger)"><AlertTriangle className="w-3.5 h-3.5" aria-hidden />Prazo de comunicação venceu em {dia(i.prazo_comunicacao)}</span>;
  return <span className="inline-flex items-center gap-1 text-(--text-warning)"><Clock className="w-3.5 h-3.5" aria-hidden />Avaliar e comunicar até {dia(i.prazo_comunicacao)}</span>;
}

function Categorias({ valor, onChange, disabled }: { valor: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  return (
    <fieldset className="rounded-(--radius-control) border border-(--border-default) p-3">
      <legend className="px-1 text-mac-body font-medium text-(--text-secondary)">Dados afetados</legend>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {Object.entries(CATEGORIAS).map(([k, label]) => (
          <label key={k} className="flex items-center gap-2 text-mac-body text-(--text-primary) cursor-pointer">
            <Checkbox checked={valor.includes(k)} disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? [...valor, k] : valor.filter((x) => x !== k))} />{label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NovoIncidente({ companyId, onClose, onDone }: { companyId: string; onClose: () => void; onDone: (id: string) => void }) {
  const { success, error: showError } = useToast();
  const [f, setF] = useState({ titulo: "", descricao: "", descoberto_em: paraCampo(new Date()), ocorrido_em: "", titulares: "", medidas: "" });
  const [cats, setCats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  async function salvar() {
    setBusy(true);
    try {
      const r = await api.post<Incidente>(`/companies/${companyId}/privacy/incidents`, {
        titulo: f.titulo.trim(), descricao: f.descricao.trim() || null, descoberto_em: doCampo(f.descoberto_em),
        ocorrido_em: doCampo(f.ocorrido_em), categorias: cats, titulares_afetados: f.titulares ? Number(f.titulares) : null,
        medidas: f.medidas.trim() || null,
      });
      success(`Incidente ${r.data.protocolo} registrado. Avalie o risco e, se for relevante, comunique até ${dia(r.data.prazo_comunicacao)}.`);
      onDone(r.data.id); onClose();
    } catch (e) { showError(erro(e, "Não foi possível registrar o incidente.")); } finally { setBusy(false); }
  }
  return (
    <Dialog onClose={onClose} size="lg" busy={busy} title="Registrar incidente de segurança"
      description="Vazamento, acesso indevido, perda ou envio errado de arquivo com dados pessoais. Registre assim que souber: o prazo de comunicação conta daí."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={f.titulo.trim().length < 3} onClick={salvar}>Registrar</Button></>}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2"><Input label="O que aconteceu" value={f.titulo} maxLength={200} onChange={(e) => setF({ ...f, titulo: e.target.value })} placeholder="Ex.: link público de holerites enviado ao grupo errado" /></div>
        <Input label="Quando a empresa soube" type="datetime-local" value={f.descoberto_em} max={paraCampo(new Date())} onChange={(e) => setF({ ...f, descoberto_em: e.target.value })} />
        <Input label="Quando ocorreu (se souber)" type="datetime-local" value={f.ocorrido_em} max={f.descoberto_em} onChange={(e) => setF({ ...f, ocorrido_em: e.target.value })} />
        <div className="sm:col-span-2"><Categorias valor={cats} onChange={setCats} /></div>
        <Input label="Titulares afetados (número aproximado)" type="number" min={0} inputMode="numeric" value={f.titulares} onChange={(e) => setF({ ...f, titulares: e.target.value })} />
        <div className="sm:col-span-2 flex flex-col gap-1">
          <label htmlFor="ni-desc" className="text-mac-body font-medium text-(--text-secondary)">Como foi (opcional)</label>
          <textarea id="ni-desc" rows={2} maxLength={4000} value={f.descricao} onChange={(e) => setF({ ...f, descricao: e.target.value })} className={campoCls} />
        </div>
        <div className="sm:col-span-2 flex flex-col gap-1">
          <label htmlFor="ni-med" className="text-mac-body font-medium text-(--text-secondary)">O que já foi feito (opcional)</label>
          <textarea id="ni-med" rows={2} maxLength={4000} value={f.medidas} onChange={(e) => setF({ ...f, medidas: e.target.value })} className={campoCls} placeholder="Ex.: link revogado, senha trocada, acessos conferidos na trilha" />
        </div>
      </div>
    </Dialog>
  );
}

function Tratamento({ id, companyId, onClose, onChanged }: { id: string; companyId: string; onClose: () => void; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [i, setI] = useState<Incidente | null>(null);
  const [pessoas, setPessoas] = useState<{ user_id: string; full_name: string; is_active: boolean }[]>([]);
  const [f, setF] = useState({ avaliacao: "", medidas: "", anpd_em: "", anpd_protocolo: "", titulares_em: "", nota: "" });
  const [busy, setBusy] = useState(false);
  function preencher(x: Incidente) {
    setI(x);
    setF({
      avaliacao: x.avaliacao_risco ?? "", medidas: x.medidas ?? "", nota: "",
      anpd_em: x.comunicado_anpd_em ? paraCampo(new Date(x.comunicado_anpd_em)) : "", anpd_protocolo: x.protocolo_anpd ?? "",
      titulares_em: x.comunicado_titulares_em ? paraCampo(new Date(x.comunicado_titulares_em)) : "",
    });
  }
  useEffect(() => {
    api.get<Incidente>(`/privacy/incidents/${id}`).then((r) => preencher(r.data)).catch((e) => { showError(erro(e, "Incidente não encontrado.")); onClose(); });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api.get(`/companies/${companyId}/people`).then((r) => setPessoas(r.data.filter((x: any) => x.is_active))).catch(() => {}); }, [companyId]);

  async function mudar(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      const r = await api.patch<Incidente>(`/privacy/incidents/${id}`, body);
      preencher(r.data); success(ok); onChanged();
    } catch (e) { showError(erro(e, "Não foi possível salvar.")); } finally { setBusy(false); }
  }
  if (!i) return null;
  const aberto = i.status !== "encerrado";
  return (
    <Dialog onClose={onClose} size="lg" busy={busy} title={`${i.titulo} · ${i.protocolo}`}
      description={<>A empresa soube em {quando(i.descoberto_em)}{i.titulares_afetados != null ? ` · ${i.titulares_afetados} titular(es)` : ""}{i.dados_sensiveis ? " · inclui dado sensível ou de risco" : ""}</>}
      footer={<Button variant="secondary" onClick={onClose}>Fechar</Button>}>
      <div className="space-y-4">
        <p className="text-mac-caption"><PrazoComunicacao i={i} /></p>
        <p className="text-mac-caption text-(--text-secondary)">O prazo conta 3 dias úteis sem feriados: confira os feriados do seu município.</p>
        {i.descricao && <p className="whitespace-pre-wrap rounded-(--radius-control) bg-(--bg-hover) px-3 py-2 text-mac-body text-(--text-primary)">{i.descricao}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><span id="ti-status" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Situação</span>
            <Dropdown ariaLabelledby="ti-status" value={i.status} disabled={busy}
              onChange={(v) => mudar({ status: v }, `Situação: ${STATUS[v].toLowerCase()}.`)}
              options={Object.entries(STATUS).map(([value, label]) => ({ value, label }))} /></div>
          <div><span id="ti-resp" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Responsável</span>
            <Dropdown ariaLabelledby="ti-resp" value={i.responsavel_id ?? ""} disabled={busy || !aberto} placeholder="Ninguém ainda"
              onChange={(v) => mudar({ responsavel_id: v || null }, "Responsável definido.")}
              options={[{ value: "", label: "Ninguém ainda" }, ...pessoas.map((x) => ({ value: x.user_id, label: x.full_name }))]} /></div>
        </div>
        <Categorias valor={i.categorias} disabled={busy || !aberto} onChange={(v) => mudar({ categorias: v }, "Dados afetados atualizados.")} />

        <fieldset className="rounded-(--radius-control) border border-(--border-default) p-3 space-y-2">
          <legend className="px-1 text-mac-body font-medium text-(--text-secondary)">Avaliação de risco</legend>
          <p className="text-mac-caption text-(--text-secondary)">O incidente pode causar risco ou dano relevante aos titulares? Pesa mais com dado sensível, de crianças, financeiro, senhas ou muitos titulares.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={i.risco_relevante === true ? "primary" : "secondary"} disabled={busy || !aberto}
              onClick={() => mudar({ risco_relevante: true, avaliacao_risco: f.avaliacao }, "Risco relevante: comunique a ANPD e os titulares no prazo.")}>Sim, pode causar</Button>
            <Button size="sm" variant={i.risco_relevante === false ? "primary" : "secondary"} disabled={busy || !aberto || !f.avaliacao.trim()}
              onClick={() => mudar({ risco_relevante: false, avaliacao_risco: f.avaliacao }, "Avaliação registrada: sem risco relevante.")}>Não, com o motivo abaixo</Button>
          </div>
          <textarea aria-label="Motivo da avaliação" rows={2} maxLength={4000} value={f.avaliacao} disabled={!aberto}
            onChange={(e) => setF({ ...f, avaliacao: e.target.value })} className={campoCls}
            placeholder="Ex.: o arquivo estava cifrado e a senha não foi exposta" />
        </fieldset>

        <div className="flex flex-col gap-1">
          <label htmlFor="ti-med" className="text-mac-body font-medium text-(--text-secondary)">Medidas para conter e reduzir os efeitos</label>
          <textarea id="ti-med" rows={2} maxLength={4000} value={f.medidas} disabled={!aberto} onChange={(e) => setF({ ...f, medidas: e.target.value })} className={campoCls} />
          {aberto && <div><Button variant="secondary" size="sm" disabled={busy || f.medidas === (i.medidas ?? "")} onClick={() => mudar({ medidas: f.medidas }, "Medidas salvas.")}>Salvar medidas</Button></div>}
        </div>

        {i.risco_relevante !== false && (
          <fieldset className="rounded-(--radius-control) border border-(--border-default) p-3 space-y-2">
            <legend className="px-1 text-mac-body font-medium text-(--text-secondary)">Comunicações</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input label="Comunicado à ANPD em" type="datetime-local" value={f.anpd_em} disabled={!aberto} max={paraCampo(new Date())} onChange={(e) => setF({ ...f, anpd_em: e.target.value })} />
              <Input label="Protocolo na ANPD" value={f.anpd_protocolo} disabled={!aberto} maxLength={100} onChange={(e) => setF({ ...f, anpd_protocolo: e.target.value })} />
              <Input label="Titulares comunicados em" type="datetime-local" value={f.titulares_em} disabled={!aberto} max={paraCampo(new Date())} onChange={(e) => setF({ ...f, titulares_em: e.target.value })} />
            </div>
            {aberto && (
              <Button variant="secondary" size="sm" disabled={busy}
                onClick={() => mudar({ comunicado_anpd_em: doCampo(f.anpd_em), protocolo_anpd: f.anpd_protocolo.trim() || null, comunicado_titulares_em: doCampo(f.titulares_em) }, "Comunicações registradas.")}>
                Salvar comunicações
              </Button>
            )}
          </fieldset>
        )}

        {aberto && (
          <div className="rounded-(--radius-control) bg-(--bg-hover) px-3 py-2">
            {i.pendencias_para_encerrar.length > 0 ? (
              <p className="text-mac-caption text-(--text-secondary)">Para encerrar, falta registrar: {i.pendencias_para_encerrar.join("; ")}.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <p className="flex-1 text-mac-caption text-(--text-primary)">Tudo registrado. O incidente fica guardado depois de encerrado.</p>
                <Button size="sm" disabled={busy} onClick={() => mudar({ status: "encerrado" }, "Incidente encerrado.")}>Encerrar</Button>
              </div>
            )}
          </div>
        )}

        <div>
          <p className="mb-1 text-mac-body font-medium text-(--text-secondary)">Histórico</p>
          <ol className="space-y-1 text-mac-caption">
            {(i.eventos ?? []).map((e, n) => (
              <li key={n} className="flex gap-2"><span className="shrink-0 text-(--text-tertiary)">{new Date(e.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                <span className="text-(--text-primary)">{e.autor ? `${e.autor}: ` : ""}{e.detalhe}</span></li>
            ))}
          </ol>
          <div className="mt-2 flex items-end gap-2">
            <div className="flex-1"><Input label="Anotação" value={f.nota} maxLength={4000} onChange={(e) => setF({ ...f, nota: e.target.value })} placeholder="Ex.: contador avisado por telefone" /></div>
            <Button variant="secondary" disabled={busy || !f.nota.trim()} onClick={() => mudar({ nota: f.nota }, "Anotação registrada.")}>Anotar</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export default function SecurityIncidents({ companyId }: { companyId: string }) {
  const [params, setParams] = useSearchParams();
  const [lista, setLista] = useState<Incidente[] | null>(null);
  const [novo, setNovo] = useState(false);
  const [mostrarEncerrados, setMostrarEncerrados] = useState(false);
  const aberto = params.get("incidente");

  function carregar() { api.get<Incidente[]>(`/companies/${companyId}/privacy/incidents`).then((r) => setLista(r.data)).catch(() => setLista([])); }
  useEffect(carregar, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const abrir = (id: string | null) => { const n = new URLSearchParams(params); if (id) n.set("incidente", id); else n.delete("incidente"); setParams(n, { replace: true }); };
  const visiveis = (lista ?? []).filter((i) => mostrarEncerrados || i.status !== "encerrado");
  const encerrados = (lista ?? []).filter((i) => i.status === "encerrado").length;

  return (
    <section className="glass-panel rounded-(--radius-panel) p-5 space-y-3" aria-labelledby="lgpd-incidentes">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="lgpd-incidentes" className="flex-1 flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><ShieldAlert className="w-4 h-4 text-(--text-accent)" aria-hidden /> Incidentes de segurança</h3>
        <Button size="sm" variant="secondary" onClick={() => setNovo(true)}><Plus className="w-3.5 h-3.5" aria-hidden />Registrar incidente</Button>
      </div>
      <p className="text-mac-caption text-(--text-secondary)">
        Quando dados pessoais vazam, são acessados por quem não devia ou se perdem. Se o incidente pode causar risco ou dano relevante, a empresa comunica a ANPD e os titulares em até 3 dias úteis de quando soube (LGPD art. 48 e Resolução CD/ANPD 15/2024). O registro fica guardado mesmo depois de encerrado.
      </p>
      {lista === null ? <div className="h-16 animate-pulse rounded-(--radius-control) bg-(--bg-card)" /> : visiveis.length === 0 ? (
        <p className="text-mac-body text-(--text-tertiary)">Nenhum incidente em aberto.</p>
      ) : (
        <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
          {visiveis.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => abrir(i.id)} className="w-full text-left px-3 py-2 hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) rounded-sm">
                <span className="block text-mac-body text-(--text-primary) truncate">{i.titulo} <span className="text-(--text-tertiary) font-mono text-mac-caption">{i.protocolo}</span></span>
                <span className="flex flex-wrap gap-x-3 text-mac-caption text-(--text-secondary)"><PrazoComunicacao i={i} /><span>{STATUS[i.status]}</span><span>{i.responsavel_nome ?? "sem responsável"}</span>{i.dados_sensiveis && <span>dado sensível</span>}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {encerrados > 0 && (
        <label className="flex items-center gap-2 text-mac-caption text-(--text-secondary) cursor-pointer">
          <Checkbox checked={mostrarEncerrados} onChange={(e) => setMostrarEncerrados(e.target.checked)} />{encerrados === 1 ? "Mostrar o encerrado" : `Mostrar os ${encerrados} encerrados`}
        </label>
      )}
      {novo && <NovoIncidente companyId={companyId} onClose={() => setNovo(false)} onDone={(id) => { carregar(); abrir(id); }} />}
      {aberto && <Tratamento id={aberto} companyId={companyId} onClose={() => abrir(null)} onChanged={carregar} />}
    </section>
  );
}
