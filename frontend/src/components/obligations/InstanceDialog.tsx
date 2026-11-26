import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FileText, Link2, Search, Trash2, Upload, AlertTriangle, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { relativeDate, fullDate } from "@/lib/date";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { type Instance, type Member, StatusChip, CRIT_LABEL, dueText, fmtDate, friendly } from "./shared";

interface LinkedDoc {
  id: string;
  document_id: string;
  document_name: string;
  folder_id: string | null;
  folder_name: string | null;
  linked_at: string;
  linked_by_name: string | null;
  valid_until: string | null;
}

interface HistoryItem { id: string; action: string; metadata: Record<string, any> | null; created_at: string; user_name: string | null }

type Detail = Instance & { documents: LinkedDoc[]; history: HistoryItem[] };

const HIST_LABEL: Record<string, string> = {
  obligation_create: "cadastrou a obrigação",
  obligation_update: "alterou",
  obligation_archive: "arquivou a obrigação",
  obligation_restore: "reativou a obrigação",
  obligation_generate: "abriu a competência",
  obligation_link: "enviou o documento",
  obligation_unlink: "tirou o documento",
  obligation_approve: "aprovou",
  obligation_return: "devolveu",
  obligation_dispense: "dispensou",
  obligation_cancel: "cancelou",
  obligation_reopen: "reabriu",
  obligation_assign: "trocou o responsável",
  obligation_dependency_add: "ligou a dependência",
  obligation_dependency_remove: "desligou a dependência",
};

function histDetail(h: HistoryItem): string {
  const m = h.metadata ?? {};
  if (m.documento) return `: ${m.documento}${m.valido_ate ? ` (válido até ${fmtDate(m.valido_ate)})` : ""}`;
  if (m.motivo) return `: ${m.motivo}`;
  if (h.action === "obligation_assign") return `: ${m.de ?? "ninguém"} → ${m.para ?? "ninguém"}`;
  if (m.depende_de) return `: depende de ${m.depende_de}`;
  if (m.de !== undefined && m.para !== undefined) return `: ${m.de} → ${m.para}`;
  return "";
}

interface SearchHit { id: string; name: string; folder_name?: string | null; created_at?: string }

/**
 * Detalhe de uma competência (A7-10, A7-20, A7-54): quem cuida, até quando,
 * que documento comprova (abrir e tirar), conferência, dispensa com motivo e
 * o histórico. Substitui os window.prompt e o modal que só vinculava.
 */
export default function InstanceDialog({
  instanceId, members: membersProp, canOperate, canAdmin, showCompany, onClose, onChanged,
}: {
  instanceId: string;
  /** Sem a lista (visão do grupo), busca os membros da empresa da obrigação. */
  members?: Member[];
  canOperate: boolean;
  canAdmin: boolean;
  showCompany?: boolean;
  onClose: () => void;
  onChanged: (inst: Instance) => void;
}) {
  const { success, error: showError } = useToast();
  const [data, setData] = useState<Detail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState("");
  const [returnNote, setReturnNote] = useState<string | null>(null);
  const [dispensing, setDispensing] = useState(false);
  const [unlinking, setUnlinking] = useState<LinkedDoc | null>(null);
  const uid = useId();
  const [fetched, setFetched] = useState<Member[]>([]);
  const members = membersProp ?? fetched;
  useEffect(() => {
    if (membersProp || !data?.company_id) return;
    api.get<Member[]>(`/companies/${data.company_id}/members`).then((r) => setFetched(r.data ?? [])).catch(() => setFetched([]));
  }, [membersProp, data?.company_id]);

  function load() {
    setFailed(false);
    api.get<Detail>(`/obligations/instances/${instanceId}`)
      .then((r) => { setData(r.data); setNotes(r.data.notes ?? ""); })
      .catch(() => setFailed(true));
  }
  useEffect(load, [instanceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run<T>(fn: () => Promise<T>, ok: string, fallback: string) {
    setBusy(true);
    try {
      await fn();
      success(ok);
      const r = await api.get<Detail>(`/obligations/instances/${instanceId}`);
      setData(r.data);
      setNotes(r.data.notes ?? "");
      onChanged(r.data);
      return true;
    } catch (e) {
      showError(friendly(e, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const title = data ? `${data.template_name} · ${data.period_label}` : "Obrigação";
  const closed = data && ["dispensado", "cancelado"].includes(data.status);

  return (
    <>
      <Dialog
        onClose={onClose}
        title={title}
        description={data ? (showCompany && data.company_name ? `${data.company_name} · ${dueText(data)}` : dueText(data)) : undefined}
        size="lg"
        busy={busy}
      >
        {failed ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <AlertTriangle className="w-4 h-4 text-(--text-warning)" aria-hidden="true" />
            <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível abrir esta obrigação.</p>
            <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
          </div>
        ) : !data ? (
          <div className="space-y-3" aria-label="Carregando">{[0, 1, 2].map((i) => <div key={i} className="h-10 rounded bg-(--bg-hover) animate-pulse" />)}</div>
        ) : (
          <div className="space-y-6">
            {/* Situação */}
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip status={data.effective_status} />
              <span className="text-mac-caption text-(--text-secondary)">Criticidade {CRIT_LABEL[data.criticality] ?? data.criticality}</span>
              {data.department && <span className="text-mac-caption text-(--text-secondary)">· {data.department}</span>}
              {data.legal_basis && <span className="text-mac-caption text-(--text-secondary)">· {data.legal_basis}</span>}
            </div>
            {data.template_description && <p className="text-mac-body text-(--text-secondary) -mt-3">{data.template_description}</p>}
            {data.effective_status === "blocked" && data.blocking_templates && (
              <p className="text-mac-body text-(--text-primary)">Só pode ser feita depois de: <strong>{data.blocking_templates.join(", ")}</strong> (mesma competência).</p>
            )}
            {data.status === "dispensado" && data.dispensa_motivo && (
              <p className="text-mac-body text-(--text-primary)">Dispensada: {data.dispensa_motivo}</p>
            )}
            {data.status === "pending" && data.review_note && (
              <p className="rounded-(--radius-control) bg-amber-500/10 px-3 py-2 text-mac-body text-(--text-primary)">
                Devolvida{data.reviewer_name ? ` por ${data.reviewer_name}` : ""}: {data.review_note}
              </p>
            )}
            {data.effective_status === "approved" && data.reviewer_name && (
              <p className="text-mac-caption text-(--text-secondary)">Conferida por {data.reviewer_name}{data.reviewed_at ? ` ${relativeDate(data.reviewed_at)}` : ""}.</p>
            )}

            {/* Conferência (A7-53) */}
            {data.status === "reviewing" && (
              <section aria-labelledby={`${uid}-conf`} className="rounded-(--radius-panel) border border-teal-500/40 bg-teal-500/5 p-4 space-y-3">
                <h3 id={`${uid}-conf`} className="text-mac-body font-semibold text-(--text-primary)">Esperando conferência</h3>
                <p className="text-mac-body text-(--text-secondary)">
                  Abra o documento abaixo e confira se ele comprova esta obrigação.{!canAdmin && " Quem administra a empresa faz a conferência."}
                </p>
                {canAdmin && (returnNote === null ? (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => run(() => api.post(`/obligations/instances/${data.id}/review`, { decision: "approve" }), "Obrigação aprovada.", "Não foi possível aprovar.")}>
                      Aprovar
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => setReturnNote("")}>Devolver para correção</Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label htmlFor={`${uid}-dev`} className="block text-mac-caption font-medium text-(--text-secondary)">O que precisa ser corrigido?</label>
                    <textarea
                      id={`${uid}-dev`} value={returnNote} onChange={(e) => setReturnNote(e.target.value)} rows={2} maxLength={1000} autoFocus
                      className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" variant="secondary" onClick={() => setReturnNote(null)}>Cancelar</Button>
                      <Button
                        size="sm" disabled={busy || !returnNote.trim()}
                        onClick={async () => { if (await run(() => api.post(`/obligations/instances/${data.id}/review`, { decision: "return", note: returnNote }), "Devolvida com o motivo.", "Não foi possível devolver.")) setReturnNote(null); }}
                      >
                        Devolver
                      </Button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* Responsável, vencimento e observação (A7-08, A7-51) */}
            <section aria-labelledby={`${uid}-quem`} className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <h3 id={`${uid}-quem`} className="sr-only">Responsável e prazo</h3>
              <div>
                <label id={`${uid}-resp`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Responsável</label>
                <Dropdown
                  ariaLabelledby={`${uid}-resp`}
                  value={data.owner_id ?? ""}
                  disabled={!canOperate || busy}
                  placeholder="Sem responsável"
                  onChange={(v) => run(() => api.patch(`/obligations/instances/${data.id}`, { owner_id: v || null }), v ? "Responsável definido." : "Responsável removido.", "Não foi possível trocar o responsável.")}
                  options={[
                    { value: "", label: "Sem responsável" },
                    ...[...new Map(members.filter((m) => !m.folder_id && m.role !== "visualizador").map((m) => [m.user_id, m])).values()]
                      .map((m) => ({ value: m.user_id, label: m.full_name })),
                  ]}
                />
              </div>
              <div>
                <label htmlFor={`${uid}-venc`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Vencimento</label>
                <input
                  id={`${uid}-venc`} type="date" defaultValue={data.due_date.slice(0, 10)} disabled={!canOperate || busy}
                  onBlur={(e) => {
                    const v = e.target.value;
                    if (v && v !== data.due_date.slice(0, 10)) run(() => api.patch(`/obligations/instances/${data.id}`, { due_date: v }), "Vencimento alterado.", "Não foi possível alterar o vencimento.");
                  }}
                  className="h-9 pointer-coarse:h-11 w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) disabled:opacity-60"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor={`${uid}-obs`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Observação</label>
                <textarea
                  id={`${uid}-obs`} value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000} disabled={!canOperate}
                  placeholder="Ex.: pedir a guia ao contador até o dia 10."
                  onBlur={() => { if ((data.notes ?? "") !== notes) run(() => api.patch(`/obligations/instances/${data.id}`, { notes: notes.trim() || null }), "Observação salva.", "Não foi possível salvar a observação."); }}
                  className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) disabled:opacity-60"
                />
              </div>
            </section>

            {/* Documentos que comprovam */}
            <section aria-labelledby={`${uid}-docs`} className="space-y-2">
              <h3 id={`${uid}-docs`} className="text-mac-body font-semibold text-(--text-primary)">Documentos que comprovam</h3>
              {data.documents.length === 0 ? (
                <p className="text-mac-body text-(--text-secondary)">Nenhum documento ainda.</p>
              ) : (
                <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
                  {data.documents.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 px-3 py-2 min-h-12">
                      <FileText className="w-4 h-4 shrink-0 text-(--text-secondary)" aria-hidden="true" />
                      <div className="flex-1 min-w-0">
                        <Link to={`/documents?folder_id=${d.folder_id ?? ""}&doc=${d.document_id}`} className="block truncate text-mac-body text-(--text-accent) hover:underline">{d.document_name}</Link>
                        <p className="text-mac-caption text-(--text-secondary) truncate">
                          {d.folder_name ?? "Sem pasta"} · enviado {relativeDate(d.linked_at)}{d.linked_by_name ? ` por ${d.linked_by_name}` : ""}
                          {d.valid_until ? ` · válido até ${fmtDate(d.valid_until)}` : ""}
                        </p>
                      </div>
                      {canOperate && !closed && (
                        <Button variant="icon" size="sm" aria-label={`Tirar ${d.document_name} desta obrigação`} onClick={() => setUnlinking(d)}>
                          <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canOperate && !closed && data.effective_status !== "not_applicable" && (
                <LinkDocument companyId={data.company_id} instanceId={data.id} requiresReview={data.requires_review !== false}
                  onLinked={() => run(async () => undefined, "Documento enviado para a obrigação.", "")} />
              )}
            </section>

            {/* Ações */}
            {canOperate && (
              <section aria-label="Outras ações" className="flex flex-wrap gap-2 border-t border-(--border-default) pt-4">
                {!closed ? (
                  <>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setDispensing(true)}>Dispensar…</Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => api.patch(`/obligations/instances/${data.id}/status`, { status: "cancelado" }), "Competência cancelada.", "Não foi possível cancelar.")}>
                      Cancelar esta competência
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(() => api.patch(`/obligations/instances/${data.id}/status`, { status: data.document_count > 0 ? "reviewing" : "pending" }), "Obrigação reaberta.", "Não foi possível reabrir.")}>
                    Reabrir
                  </Button>
                )}
              </section>
            )}

            {/* Histórico (A7-03) */}
            <section aria-labelledby={`${uid}-hist`} className="space-y-2">
              <h3 id={`${uid}-hist`} className="text-mac-body font-semibold text-(--text-primary)">Histórico</h3>
              {data.history.length === 0 ? (
                <p className="text-mac-body text-(--text-secondary)">Nada registrado ainda.</p>
              ) : (
                <ol className="space-y-1.5">
                  {data.history.map((h) => (
                    <li key={h.id} className="text-mac-caption text-(--text-secondary)">
                      <time dateTime={h.created_at} title={fullDate(h.created_at)} className="tabular-nums">{relativeDate(h.created_at)}</time>{" · "}
                      <span className="text-(--text-primary)">{h.user_name ?? "Sistema"}</span> {HIST_LABEL[h.action] ?? h.action}{histDetail(h)}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </Dialog>

      {dispensing && data && (
        <DispenseDialog
          name={title}
          onClose={() => setDispensing(false)}
          onConfirm={async (motivo) => {
            if (await run(() => api.patch(`/obligations/instances/${data.id}/status`, { status: "dispensado", dispensa_motivo: motivo }), "Obrigação dispensada, com o motivo registrado.", "Não foi possível dispensar.")) setDispensing(false);
          }}
        />
      )}
      {unlinking && data && (
        <ConfirmModal
          title="Tirar este documento da obrigação?"
          description={<>O documento <strong>{unlinking.document_name}</strong> continua em Documentos; só deixa de comprovar “{title}”.{data.documents.length === 1 ? " Sem outro documento, a obrigação volta para “A fazer”." : ""}</>}
          confirmLabel="Tirar"
          danger
          loading={busy}
          onClose={() => setUnlinking(null)}
          onConfirm={async () => {
            if (await run(() => api.delete(`/obligations/instances/${data.id}/documents/${unlinking.document_id}`), "Documento tirado da obrigação.", "Não foi possível tirar o documento.")) setUnlinking(null);
          }}
        />
      )}
    </>
  );
}

function DispenseDialog({ name, onClose, onConfirm }: { name: string; onClose: () => void; onConfirm: (motivo: string) => void }) {
  const [motivo, setMotivo] = useState("");
  const id = useId();
  return (
    <Dialog
      onClose={onClose}
      title="Dispensar esta obrigação?"
      description={`“${name}” deixa de contar como pendência. O motivo fica no histórico.`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Voltar</Button>
          <Button disabled={!motivo.trim()} onClick={() => onConfirm(motivo.trim())}>Dispensar</Button>
        </>
      }
    >
      <label htmlFor={id} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Motivo</label>
      <textarea
        id={id} value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={3} maxLength={1000} autoFocus
        placeholder="Ex.: unidade sem empregados neste mês."
        className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
      />
    </Dialog>
  );
}

/**
 * Busca acessível (combobox com setas, A7-59): mostra pasta e data para
 * conferir se é a prova certa (A7-56), distingue "sem resultado" de erro
 * (A7-61) e pede a validade impressa no documento (A7-37).
 */
function LinkDocument({ companyId, instanceId, requiresReview, onLinked }: {
  companyId: string; instanceId: string; requiresReview: boolean; onLinked: () => void;
}) {
  const { error: showError } = useToast();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = useState(-1);
  const [chosen, setChosen] = useState<SearchHit | null>(null);
  const [validUntil, setValidUntil] = useState("");
  const [saving, setSaving] = useState(false);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (chosen || query.trim().length < 2) { setHits(null); setState("idle"); return; }
    setState("loading");
    const t = setTimeout(() => {
      api.get("/search", { params: { q: query.trim(), company_id: companyId, page_size: 8 } })
        .then((r) => { setHits(Array.isArray(r.data?.results) ? r.data.results : []); setState("idle"); setActive(-1); })
        .catch(() => { setHits(null); setState("error"); });
    }, 250);
    return () => clearTimeout(t);
  }, [query, companyId, chosen]);

  async function save() {
    if (!chosen) return;
    setSaving(true);
    try {
      await api.post(`/obligations/instances/${instanceId}/documents`, { document_id: chosen.id, valid_until: validUntil || null });
      setChosen(null); setQuery(""); setValidUntil("");
      onLinked();
    } catch (e) {
      showError(friendly(e, "Não foi possível enviar o documento para a obrigação."));
    } finally {
      setSaving(false);
    }
  }

  const open = !chosen && hits !== null;
  return (
    <div className="rounded-(--radius-control) border border-dashed border-(--border-control) p-3 space-y-3">
      {!chosen ? (
        <div className="relative">
          <label htmlFor={`${listId}-q`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Comprovar com um documento do Docke</label>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-secondary)" aria-hidden="true" />
            <input
              ref={inputRef} id={`${listId}-q`} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nome do documento ou trecho do texto"
              onKeyDown={(e) => {
                if (!hits?.length) return;
                if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
                if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
                if (e.key === "Enter" && active >= 0) { e.preventDefault(); setChosen(hits[active]); }
                if (e.key === "Escape") { setHits(null); }
              }}
              className="h-9 pointer-coarse:h-11 w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) pl-8 pr-3 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
            />
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {state === "loading" ? "Buscando" : state === "error" ? "Erro na busca" : hits ? `${hits.length} documentos encontrados` : ""}
          </p>
          {state === "error" && <p className="mt-2 text-mac-caption text-(--text-danger)">A busca falhou. Confira a conexão e digite de novo.</p>}
          {open && (
            <ul id={listId} role="listbox" aria-label="Documentos encontrados" className="mt-2 max-h-60 overflow-y-auto rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)">
              {hits.length === 0 ? (
                <li className="px-3 py-2 text-mac-body text-(--text-secondary)" role="option" aria-selected={false} aria-disabled="true">Nenhum documento com esse nome ou texto.</li>
              ) : hits.map((h, i) => (
                <li
                  key={h.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                  onMouseDown={(e) => { e.preventDefault(); setChosen(h); }}
                  className={`flex items-center gap-2 px-3 py-2 min-h-11 cursor-pointer ${i === active ? "bg-(--bg-hover)" : "hover:bg-(--bg-hover)"}`}
                >
                  <FileText className="w-3.5 h-3.5 shrink-0 text-(--text-secondary)" aria-hidden="true" />
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-mac-body text-(--text-primary)">{h.name}</span>
                    <span className="block truncate text-mac-caption text-(--text-secondary)">{h.folder_name ?? "Sem pasta"}{h.created_at ? ` · ${fmtDate(h.created_at)}` : ""}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-mac-body text-(--text-primary)">
            <Link2 className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> <strong className="truncate">{chosen.name}</strong>
            <button onClick={() => { setChosen(null); setTimeout(() => inputRef.current?.focus(), 0); }} className="ml-auto text-mac-caption font-medium text-(--text-accent) hover:underline">Trocar</button>
          </p>
          <div>
            <label htmlFor={`${listId}-val`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">Válido até (a data impressa no documento, se houver)</label>
            <input id={`${listId}-val`} type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)}
              className="h-9 pointer-coarse:h-11 w-full sm:w-56 rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={saving} onClick={save}>{requiresReview ? "Enviar para conferência" : "Comprovar"}</Button>
            {requiresReview && <span className="text-mac-caption text-(--text-secondary)">Quem administra a empresa confere antes de dar como cumprida.</span>}
          </div>
        </div>
      )}
      <Link to="/documents?acao=enviar" className="inline-flex items-center gap-1.5 text-mac-caption font-medium text-(--text-accent) hover:underline">
        <Upload className="w-3.5 h-3.5" aria-hidden="true" /> O documento ainda não está no Docke? Envie primeiro em Documentos
      </Link>
    </div>
  );
}
