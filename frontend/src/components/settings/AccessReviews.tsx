import { useEffect, useId, useState } from "react";
import { ClipboardCheck, Download, Check, X as XIcon, ChevronRight, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { relativeDate } from "@/lib/date";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import Dropdown from "@/components/ui/Dropdown";

/**
 * Revisão periódica de acessos (A9-21, FA-A9-05, B3.1.7, B3.7.8): campanha
 * com responsável e prazo, foto de quem acessa o quê no começo, decisão por
 * pessoa e CSV como evidência. "Retirar" registra a decisão; o acesso sai em
 * Pessoas (abre a pessoa direto daqui), pelo caminho que já fica na trilha.
 */
interface Resumo {
  id: string; title: string; due_date: string; repeat_months: number | null; created_at: string; closed_at: string | null;
  reviewer_name: string; total: number; decididos: number; retirar: number;
}
interface Item {
  id: string; user_id: string; person_name: string; email: string | null; decision: "manter" | "retirar" | null; note: string | null;
  decided_at: string | null; decided_by_name: string | null;
  snapshot: { papel: string; onde: string; origem: string; ate?: string | null }[];
}
interface Detalhe extends Omit<Resumo, "total" | "decididos" | "retirar"> { items: Item[] }

const PAPEL: Record<string, string> = { admin: "Administrador", operador: "Operador", visualizador: "Visualizador" };
const fmt = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00` : iso).toLocaleDateString("pt-BR");

export default function AccessReviews({ companyId, admins, onOpenPerson }: {
  companyId: string; admins: { user_id: string; full_name: string }[]; onOpenPerson: (userId: string) => void;
}) {
  const [lista, setLista] = useState<Resumo[] | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [criando, setCriando] = useState(false);
  const [aberta, setAberta] = useState<string | null>(null);

  function carregar() {
    setFalhou(false);
    api.get<Resumo[]>(`/companies/${companyId}/access-reviews`).then((r) => setLista(r.data)).catch(() => setFalhou(true));
  }
  useEffect(carregar, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-mac-caption text-(--text-secondary) max-w-xl">
          De tempos em tempos, quem responde pela empresa confere se cada pessoa ainda precisa do acesso que tem. A revisão guarda o que havia, a decisão e quem decidiu.
        </p>
        <Button size="sm" onClick={() => setCriando(true)}><ClipboardCheck className="w-3.5 h-3.5" aria-hidden="true" /> Nova revisão</Button>
      </div>
      {falhou ? (
        <div role="alert" className="flex items-center gap-3 rounded-(--radius-control) border border-(--border-default) px-4 py-3">
          <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar as revisões.</p>
          <Button variant="secondary" size="sm" onClick={carregar}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
        </div>
      ) : lista === null ? (
        <div className="h-24 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" aria-label="Carregando" />
      ) : lista.length === 0 ? (
        <p className="text-mac-body text-(--text-secondary)">Nenhuma revisão ainda. Comece uma: leva alguns minutos e vira evidência para auditoria e LGPD.</p>
      ) : (
        <ul className="glass-panel glass-blur-card rounded-(--radius-panel) overflow-hidden divide-y divide-(--border-default)">
          {lista.map((r) => {
            const atrasada = !r.closed_at && new Date(`${r.due_date}T23:59`) < new Date();
            return (
              <li key={r.id}>
                <button type="button" onClick={() => setAberta(r.id)} className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-14 hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)">
                  <ClipboardCheck className={`w-4 h-4 shrink-0 ${r.closed_at ? "text-(--text-success)" : atrasada ? "text-(--text-danger)" : "text-(--text-accent)"}`} aria-hidden="true" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-mac-body text-(--text-primary) truncate">{r.title}</span>
                    <span className={`block text-mac-caption ${atrasada ? "text-(--text-danger)" : "text-(--text-secondary)"}`}>
                      {r.closed_at ? `Concluída ${relativeDate(r.closed_at)}` : `${r.decididos} de ${r.total} decididas · prazo ${fmt(r.due_date)}${atrasada ? " (vencido)" : ""}`}
                      {" · "}{r.reviewer_name}{r.repeat_months ? ` · repete a cada ${r.repeat_months} meses` : ""}{r.retirar ? ` · ${r.retirar} a retirar` : ""}
                    </span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-(--text-secondary) shrink-0" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {criando && <NovaRevisao companyId={companyId} admins={admins} onClose={() => setCriando(false)} onCriada={(id) => { setCriando(false); carregar(); setAberta(id); }} />}
      {aberta && <Revisao id={aberta} onClose={() => { setAberta(null); carregar(); }} onOpenPerson={(uid) => { setAberta(null); onOpenPerson(uid); }} />}
    </div>
  );
}

function NovaRevisao({ companyId, admins, onClose, onCriada }: {
  companyId: string; admins: { user_id: string; full_name: string }[]; onClose: () => void; onCriada: (id: string) => void;
}) {
  const uid = useId();
  const { error: showError } = useToast();
  const hoje = new Date();
  const [titulo, setTitulo] = useState(`Revisão de acessos · ${hoje.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}`);
  const [resp, setResp] = useState(admins[0]?.user_id ?? "");
  const [prazo, setPrazo] = useState(new Date(hoje.getTime() + 14 * 86_400_000).toISOString().slice(0, 10));
  const [repete, setRepete] = useState("3");
  const [busy, setBusy] = useState(false);
  async function criar() {
    setBusy(true);
    try {
      const r = await api.post<{ id: string }>(`/companies/${companyId}/access-reviews`, {
        title: titulo.trim(), reviewer_id: resp, due_date: prazo, repeat_months: repete ? Number(repete) : null,
      });
      onCriada(r.data.id);
    } catch (e) {
      showError(friendlyError(e, "Não foi possível abrir a revisão."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog onClose={onClose} title="Nova revisão de acessos" size="md" busy={busy}
      description="Tira a foto de quem acessa o quê hoje. O responsável decide pessoa a pessoa e recebe lembrete perto do prazo."
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button><Button loading={busy} onClick={criar} disabled={!titulo.trim() || !resp || !prazo}>Abrir revisão</Button></>}>
      <div className="space-y-4">
        <Input label="Nome" value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={120} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label id={`${uid}-resp`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">Responsável</label>
            <Dropdown ariaLabelledby={`${uid}-resp`} value={resp} onChange={setResp} options={admins.map((a) => ({ value: a.user_id, label: a.full_name }))} />
          </div>
          <div>
            <label htmlFor={`${uid}-prazo`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">Prazo</label>
            <input id={`${uid}-prazo`} type="date" value={prazo} min={hoje.toISOString().slice(0, 10)} onChange={(e) => setPrazo(e.target.value)}
              className="mac-field w-full h-9 pointer-coarse:h-11 px-2 text-mac-body text-(--text-primary)" />
          </div>
        </div>
        <div>
          <label id={`${uid}-rep`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">Repetir</label>
          <Dropdown ariaLabelledby={`${uid}-rep`} value={repete} onChange={setRepete}
            options={[{ value: "", label: "Só esta vez" }, { value: "3", label: "A cada 3 meses" }, { value: "6", label: "A cada 6 meses" }, { value: "12", label: "Uma vez por ano" }]} />
          <p className="mt-1 text-mac-caption text-(--text-secondary)">Ao concluir, a próxima já abre com o novo prazo.</p>
        </div>
        {admins.length === 0 && <p className="text-mac-caption text-(--text-danger)">A empresa precisa de alguém que administre a empresa toda para ser o responsável.</p>}
      </div>
    </Dialog>
  );
}

function Revisao({ id, onClose, onOpenPerson }: { id: string; onClose: () => void; onOpenPerson: (userId: string) => void }) {
  const { success, error: showError } = useToast();
  const [d, setD] = useState<Detalhe | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [motivo, setMotivo] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  function carregar() { api.get<Detalhe>(`/access-reviews/${id}`).then((r) => setD(r.data)).catch(() => setFalhou(true)); }
  useEffect(carregar, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function decidir(it: Item, decision: "manter" | "retirar") {
    setBusy(it.id);
    try {
      const r = await api.post<{ faltam: number; concluida: boolean; proxima: string | null }>(`/access-reviews/${id}/items/${it.id}`, { decision, note: motivo[it.id]?.trim() || null });
      if (r.data.concluida) success(r.data.proxima ? "Revisão concluída. A próxima já está aberta com o novo prazo." : "Revisão concluída.");
      carregar();
    } catch (e) {
      showError(friendlyError(e, "Não foi possível registrar a decisão."));
    } finally {
      setBusy(null);
    }
  }

  async function evidencia() {
    try {
      const r = await api.get(`/access-reviews/${id}/evidence.csv`, { responseType: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(r.data);
      a.download = `revisao-de-acessos_${d?.due_date ?? ""}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      showError(friendlyError(e, "Não foi possível baixar a evidência."));
    }
  }

  const decididas = d?.items.filter((i) => i.decision).length ?? 0;
  return (
    <Dialog onClose={onClose} size="lg" title={d?.title ?? "Revisão de acessos"}
      description={d ? `${d.reviewer_name} · prazo ${fmt(d.due_date)} · ${d.closed_at ? `concluída ${relativeDate(d.closed_at)}` : `${decididas} de ${d.items.length} decididas`}` : undefined}
      footer={<><Button variant="secondary" onClick={evidencia} disabled={!d}><Download className="w-3.5 h-3.5" aria-hidden="true" /> Evidência (CSV)</Button><Button onClick={onClose}>Fechar</Button></>}>
      {falhou ? <p role="alert" className="text-mac-body text-(--text-danger)">Não foi possível abrir a revisão.</p>
        : !d ? <div className="h-40 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" aria-label="Carregando" />
        : (
          <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default) max-h-[60vh] overflow-y-auto">
            {d.items.map((it) => (
              <li key={it.id} className="px-3 py-3 space-y-2">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="flex-1 min-w-48">
                    <p className="text-mac-body font-medium text-(--text-primary)">{it.person_name} <span className="font-normal text-(--text-secondary)">{it.email}</span></p>
                    <ul className="text-mac-caption text-(--text-secondary)">
                      {it.snapshot.map((a, k) => <li key={k}>{PAPEL[a.papel] ?? a.papel} em {a.onde} ({a.origem}){a.ate ? `, até ${fmt(a.ate)}` : ""}</li>)}
                    </ul>
                  </div>
                  {it.decision ? (
                    <span className={`text-mac-caption font-medium ${it.decision === "retirar" ? "text-(--text-danger)" : "text-(--text-success)"}`}>
                      {it.decision === "retirar" ? "Retirar" : "Manter"} · {it.decided_by_name}{it.decided_at ? `, ${relativeDate(it.decided_at)}` : ""}
                    </span>
                  ) : !d.closed_at && (
                    <span className="flex gap-1.5">
                      <Button size="sm" variant="secondary" loading={busy === it.id} onClick={() => decidir(it, "manter")}><Check className="w-3.5 h-3.5" aria-hidden="true" /> Manter</Button>
                      <Button size="sm" variant="secondary" disabled={busy === it.id || !motivo[it.id]?.trim()} onClick={() => decidir(it, "retirar")}><XIcon className="w-3.5 h-3.5" aria-hidden="true" /> Retirar</Button>
                    </span>
                  )}
                </div>
                {!it.decision && !d.closed_at && (
                  <input value={motivo[it.id] ?? ""} onChange={(e) => setMotivo((m) => ({ ...m, [it.id]: e.target.value }))} maxLength={500}
                    aria-label={`Motivo para ${it.person_name}`} placeholder="Motivo (obrigatório para retirar)"
                    className="mac-field w-full h-8 pointer-coarse:h-11 px-2.5 text-mac-caption text-(--text-primary)" />
                )}
                {it.note && <p className="text-mac-caption text-(--text-primary)">“{it.note}”</p>}
                {it.decision === "retirar" && (
                  <button type="button" onClick={() => onOpenPerson(it.user_id)} className="text-mac-caption font-medium text-(--text-accent) hover:underline">Abrir a pessoa para tirar o acesso →</button>
                )}
              </li>
            ))}
          </ul>
        )}
    </Dialog>
  );
}
