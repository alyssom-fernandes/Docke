import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertTriangle, RefreshCw, Plus, Sparkles, Lock, Pencil, Archive, Trash2, Download, FileText, Folder, Search, ShieldAlert } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import { relativeDate, fullDate } from "@/lib/date";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Dropdown from "@/components/ui/Dropdown";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Checkbox from "@/components/ui/Checkbox";
import Input from "@/components/ui/Input";
import VersionsPolicyCard from "@/components/shared/VersionsPolicyCard";
import { friendly, fmtDate } from "@/components/obligations/shared";

// Retenção e descarte: quanto tempo cada documento precisa ser guardado,
// bloqueio judicial e a fila de descarte, que SEMPRE passa por decisão humana
// em dois passos (aprovar e, depois, excluir definitivamente).

interface FolderOption { id: string; name: string; path: string }
interface Policy {
  id: string; name: string; legal_basis: string | null; notes: string | null; trigger_type: string;
  trigger_custom_field_id: string | null; trigger_field_label?: string | null; duration_months: number | null;
  start_rule: "data" | "ano_seguinte"; locked: boolean; assignment_count?: number; catalog_key: string | null;
}
interface Assignment { id: string; folder_path: string | null; folder_id: string | null; folder_label: string | null; policy_id: string; policy_name: string; document_count: number; match_tipo_fiscal?: string | null; match_field_id?: string | null; match_field_value?: string | null; match_field_label?: string | null }
interface Hold {
  id: string; resource_type: "document" | "folder"; resource_id: string; resource_name: string | null; resource_path: string | null;
  folder_id: string | null; reason: string; process_number: string | null; review_date: string | null; created_at: string;
  created_by_name: string | null; released_at: string | null; released_by_name: string | null; release_reason: string | null;
}
interface QueueItem {
  id: string; document_id: string; document_name: string; folder_id: string | null; folder_name: string | null;
  policy_name_snapshot: string; computed_expires_at: string; status: string; review_notes: string | null;
  deferred_until: string | null; reviewed_by_name: string | null;
}
interface Certificate {
  id: string; document_name_snapshot: string; document_sha256: string | null; folder_path_snapshot: string | null;
  policy_name_snapshot: string; legal_basis_snapshot: string | null; executed_by_name_snapshot: string; executed_at: string;
}
interface Summary { politicas: number; bloqueios: number; fila: number; aprovados: number; documentos: number; cobertos: number }
interface Field { id: string; label: string; type: string }

type Tab = "fila" | "politicas" | "onde" | "bloqueio" | "lixeira" | "certificados";

function durationText(m: number | null) {
  if (m === null) return "guarda permanente";
  if (m % 12 === 0) return `${m / 12} ${m / 12 === 1 ? "ano" : "anos"}`;
  return `${m} ${m === 1 ? "mês" : "meses"}`;
}

function policyText(p: Policy) {
  const inicio = p.trigger_type === "custom_field" ? `a partir de “${p.trigger_field_label ?? "campo de data"}”` : "a partir do envio";
  return p.duration_months === null ? "guarda permanente" : `${durationText(p.duration_months)} ${inicio}${p.start_rule === "ano_seguinte" ? ", contados de 1º de janeiro do ano seguinte" : ""}`;
}

function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) flex flex-wrap items-center gap-3 px-5 py-4">
      <AlertTriangle className="w-4 h-4 text-(--text-warning)" aria-hidden="true" />
      <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar {what}. Nada foi perdido.</p>
      <Button variant="secondary" size="sm" onClick={onRetry}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
    </div>
  );
}

export default function Retention() {
  usePageTitle("Retenção e descarte");
  const { current } = useCompany();
  const { user } = useAuthContext();
  const [params, setParams] = useSearchParams();
  const initialFolderId = params.get("folder") ?? undefined;
  const cid = current?.id;
  const isAdmin = ["admin", "supremo"].includes(current?.permission_level ?? "");

  const [summary, setSummary] = useState<Summary | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [approved, setApproved] = useState<QueueItem[]>([]);
  const [certs, setCerts] = useState<Certificate[]>([]);
  const [fields, setFields] = useState<Field[]>([]);

  const load = useCallback(() => {
    if (!cid) return;
    api.get<Summary>(`/companies/${cid}/retention/summary`).then((r) => setSummary(r.data)).catch(() => setSummary(null));
    Promise.all([
      api.get<FolderOption[]>("/folders", { params: { company_id: cid, flat: true } }),
      api.get<Policy[]>(`/companies/${cid}/retention/policies`),
      api.get<Assignment[]>(`/companies/${cid}/retention/assignments`),
      api.get<Hold[]>(`/companies/${cid}/retention/holds`, { params: { active_only: false } }),
      api.get<QueueItem[]>(`/companies/${cid}/retention/queue`, { params: { status: "pending" } }),
      api.get<QueueItem[]>(`/companies/${cid}/retention/queue`, { params: { status: "approved" } }),
    ])
      .then(([f, p, a, h, q, aq]) => {
        setFolders(f.data ?? []); setPolicies(p.data ?? []); setAssignments(a.data ?? []); setHolds(h.data ?? []);
        setQueue(q.data ?? []); setApproved(aq.data ?? []); setState("ok");
      })
      .catch(() => setState("error"));
    if (isAdmin) api.get<Certificate[]>(`/companies/${cid}/retention/certificates`).then((r) => setCerts(r.data ?? [])).catch(() => setCerts([]));
    api.get<Field[]>("/custom-fields", { params: { company_id: cid } }).then((r) => setFields((r.data ?? []).filter((x) => x.type === "data" || x.type === "competencia"))).catch(() => setFields([]));
  }, [cid, isAdmin]);
  useEffect(load, [load]);

  const defaultTab: Tab = initialFolderId ? "onde" : summary && (summary.fila > 0 || summary.aprovados > 0) ? "fila" : "politicas";
  const tab = (params.get("aba") as Tab) ?? defaultTab;
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); n.set("aba", t); return n; }, { replace: true });

  if (!current) return null;
  const activeHolds = holds.filter((h) => !h.released_at);
  const cobertura = summary && summary.documentos ? Math.round((summary.cobertos / summary.documentos) * 100) : null;

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "fila", label: "Fila de descarte", badge: (summary?.fila ?? 0) + (summary?.aprovados ?? 0) },
    { id: "politicas", label: "Prazos de guarda" },
    { id: "onde", label: "Onde vale" },
    { id: "bloqueio", label: "Bloqueio judicial", badge: activeHolds.length },
    { id: "lixeira", label: "Lixeira" },
    ...(isAdmin ? [{ id: "certificados" as Tab, label: "Certificados" }] : []),
  ];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-mac-caption text-(--text-secondary)">
          Quanto tempo cada documento precisa ser guardado, o que está bloqueado pela Justiça e o que já pode ser descartado. Nada é apagado sem duas confirmações.
        </p>
      </div>

      {/* Resumo (A7-71) */}
      <section aria-label="Resumo" className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { t: "politicas" as Tab, v: cobertura === null ? "—" : `${cobertura}%`, l: "dos documentos com prazo de guarda", h: summary ? `${summary.cobertos} de ${summary.documentos}` : "" },
          { t: "fila" as Tab, v: summary?.fila ?? "—", l: "esperando sua decisão", h: summary?.aprovados ? `${summary.aprovados} aprovados para excluir` : "" },
          { t: "bloqueio" as Tab, v: summary?.bloqueios ?? "—", l: "bloqueios judiciais ativos", h: "" },
          { t: "politicas" as Tab, v: summary?.politicas ?? "—", l: "prazos de guarda em uso", h: "" },
        ].map((c, i) => (
          <button key={i} onClick={() => setTab(c.t)}
            className="glass-panel glass-blur-card rounded-(--radius-panel) p-3 sm:p-4 text-left min-h-[84px] hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
            <span className="block text-mac-title2 font-semibold tabular-nums text-(--text-primary)">{c.v}</span>
            <span className="block text-mac-caption text-(--text-secondary)">{c.l}</span>
            {c.h && <span className="block text-mac-caption2 text-(--text-secondary)">{c.h}</span>}
          </button>
        ))}
      </section>

      <div role="tablist" aria-label="Seções de retenção" className="mac-segmented">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className="mac-segment">
            {t.label}
            {!!t.badge && <span className="rounded-full bg-(--accent) px-1.5 text-[11px] leading-4 font-semibold text-white">{t.badge}</span>}
          </button>
        ))}
      </div>

      {state === "error" ? <LoadError what="a retenção" onRetry={load} /> : state === "loading" ? (
        <div className="space-y-2" aria-label="Carregando">{[0, 1, 2].map((i) => <div key={i} className="h-14 rounded bg-(--bg-hover) animate-pulse" />)}</div>
      ) : (
        <div role="tabpanel">
          {tab === "fila" && <QueueTab companyId={current.id} isAdmin={isAdmin} queue={queue} approved={approved} onChanged={load} />}
          {tab === "politicas" && <PoliciesTab companyId={current.id} isAdmin={isAdmin} policies={policies} fields={fields} onChanged={load} />}
          {tab === "onde" && <WhereTab companyId={current.id} isAdmin={isAdmin} policies={policies} folders={folders} assignments={assignments} initialFolderId={initialFolderId} onChanged={load} />}
          {tab === "bloqueio" && <HoldTab companyId={current.id} isAdmin={isAdmin} holds={holds} folders={folders} onChanged={load} />}
          {tab === "lixeira" && <TrashTab companyId={current.id} isSupremo={user?.role === "supremo"} />}
          {tab === "certificados" && isAdmin && <CertificatesTab companyId={current.id} certs={certs} />}
        </div>
      )}
    </div>
  );
}

// ─── Fila (A7-70, A7-73, A7-76) ─────────────────────────────────────────────

function QueueTab({ companyId, isAdmin, queue, approved, onChanged }: { companyId: string; isAdmin: boolean; queue: QueueItem[]; approved: QueueItem[]; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [decision, setDecision] = useState<"approved" | "rejected" | "deferred" | null>(null);
  const [purging, setPurging] = useState<QueueItem | null>(null);
  const [busy, setBusy] = useState(false);
  const allOn = queue.length > 0 && sel.size === queue.length;

  async function decide(status: string, notes: string, until: string) {
    setBusy(true);
    try {
      const r = await api.post(`/companies/${companyId}/retention/queue/decision-batch`, { ids: [...sel], status, notes: notes.trim() || null, deferred_until: until || null });
      success(`${r.data.updated} ${r.data.updated === 1 ? "decisão registrada" : "decisões registradas"}.`);
      setSel(new Set()); setDecision(null); onChanged();
    } catch (e) { showError(friendly(e, "Nada foi alterado.")); } finally { setBusy(false); }
  }

  async function purge(typed: string) {
    if (!purging) return;
    setBusy(true);
    try {
      await api.post(`/retention/queue/${purging.id}/execute`, { confirm_name: typed }, { params: { company_id: companyId } });
      success(`“${purging.document_name}” excluído. O certificado de descarte foi emitido.`);
      setPurging(null); onChanged();
    } catch (e) { showError(friendly(e, "Não foi possível excluir.")); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="fila-dec" className="space-y-2">
        <h2 id="fila-dec" className="text-mac-body font-semibold text-(--text-primary)">Prazo de guarda vencido: decidir ({queue.length})</h2>
        <p className="text-mac-caption text-(--text-secondary)">
          Aprovar não apaga nada: só libera o documento para a exclusão definitiva, que é um segundo passo logo abaixo. Manter tira da fila; adiar devolve à fila na data escolhida.
        </p>
        {queue.length === 0 ? (
          <p className="glass-panel glass-blur-card rounded-(--radius-panel) px-5 py-4 text-mac-body text-(--text-secondary)">Nenhum documento com prazo vencido esperando decisão.</p>
        ) : (
          <>
            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 text-mac-body text-(--text-primary) mr-2">
                  <Checkbox checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(queue.map((q) => q.id)))} /> Todos
                </label>
                <Button size="sm" disabled={!sel.size || busy} onClick={() => setDecision("approved")}>Aprovar descarte ({sel.size})</Button>
                <Button size="sm" variant="secondary" disabled={!sel.size || busy} onClick={() => setDecision("rejected")}>Manter</Button>
                <Button size="sm" variant="secondary" disabled={!sel.size || busy} onClick={() => setDecision("deferred")}>Adiar…</Button>
              </div>
            )}
            <ul className="glass-panel glass-blur-card rounded-(--radius-panel) divide-y divide-(--border-default)">
              {queue.map((q) => (
                <li key={q.id} className="flex items-center gap-3 px-4 py-2.5 min-h-12">
                  {isAdmin && <Checkbox aria-label={`Selecionar ${q.document_name}`} checked={sel.has(q.id)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(q.id)) n.delete(q.id); else n.add(q.id); return n; })} />}
                  <div className="flex-1 min-w-0">
                    <Link to={`/documents?folder_id=${q.folder_id ?? ""}&doc=${q.document_id}`} className="block truncate text-mac-body text-(--text-accent) hover:underline">{q.document_name}</Link>
                    <p className="text-mac-caption text-(--text-secondary) truncate">{q.folder_name ?? "Sem pasta"} · {q.policy_name_snapshot} · venceu em {fmtDate(q.computed_expires_at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="fila-exec" className="space-y-2">
        <h2 id="fila-exec" className="text-mac-body font-semibold text-(--text-primary)">Aprovados: excluir definitivamente ({approved.length})</h2>
        <p className="text-mac-caption text-(--text-secondary)">A exclusão apaga o arquivo e emite um certificado de descarte com o hash, a política e quem aprovou. Não dá para desfazer.</p>
        {approved.length === 0 ? (
          <p className="text-mac-body text-(--text-secondary)">Nenhum aprovado esperando a exclusão.</p>
        ) : (
          <ul className="glass-panel glass-blur-card rounded-(--radius-panel) divide-y divide-(--border-default)">
            {approved.map((q) => (
              <li key={q.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 min-h-12">
                <div className="flex-1 min-w-48">
                  <p className="truncate text-mac-body text-(--text-primary)">{q.document_name}</p>
                  <p className="text-mac-caption text-(--text-secondary)">Aprovado{q.reviewed_by_name ? ` por ${q.reviewed_by_name}` : ""}{q.review_notes ? ` · ${q.review_notes}` : ""}</p>
                </div>
                {isAdmin && <Button size="sm" variant="danger" onClick={() => setPurging(q)}><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Excluir definitivamente</Button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {decision && <DecisionDialog decision={decision} count={sel.size} busy={busy} onClose={() => setDecision(null)} onConfirm={decide} />}
      {purging && (
        <ConfirmModal
          title="Excluir definitivamente?"
          description={<>“{purging.document_name}” e o arquivo dele serão apagados para sempre. Digite o nome do documento para confirmar.</>}
          confirmLabel="Excluir para sempre" danger loading={busy}
          requireTypedConfirmation typedConfirmationValue={purging.document_name}
          onClose={() => setPurging(null)} onConfirm={purge}
        />
      )}
    </div>
  );
}

function DecisionDialog({ decision, count, busy, onClose, onConfirm }: {
  decision: "approved" | "rejected" | "deferred"; count: number; busy: boolean; onClose: () => void; onConfirm: (status: string, notes: string, until: string) => void;
}) {
  const [notes, setNotes] = useState("");
  const [until, setUntil] = useState("");
  const id = useId();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const title = decision === "approved" ? `Aprovar o descarte de ${count}?` : decision === "rejected" ? `Manter ${count}?` : `Adiar ${count}?`;
  const desc = decision === "approved"
    ? "Eles vão para “Aprovados: excluir definitivamente”. Nada é apagado agora."
    : decision === "rejected" ? "Saem da fila e continuam guardados." : "Voltam para a fila na data escolhida.";
  return (
    <Dialog onClose={onClose} title={title} description={desc} size="sm" busy={busy}
      footer={<><Button variant="secondary" onClick={onClose}>Voltar</Button><Button loading={busy} disabled={decision === "deferred" && !until} onClick={() => onConfirm(decision, notes, until)}>Confirmar</Button></>}>
      <div className="space-y-3">
        {decision === "deferred" && <Input label="Revisar de novo em" type="date" min={tomorrow} value={until} onChange={(e) => setUntil(e.target.value)} />}
        <div>
          <label htmlFor={id} className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Observação {decision === "approved" ? "(vai para o certificado)" : "(opcional)"}</label>
          <textarea id={id} rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
        </div>
      </div>
    </Dialog>
  );
}

// ─── Prazos de guarda (A7-79..A7-87) ────────────────────────────────────────

function PoliciesTab({ companyId, isAdmin, policies, fields, onChanged }: { companyId: string; isAdmin: boolean; policies: Policy[]; fields: Field[]; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [editing, setEditing] = useState<Policy | "nova" | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [archiving, setArchiving] = useState<{ p: Policy; docs: number | null } | null>(null);
  const [busy, setBusy] = useState(false);

  async function openArchive(p: Policy) {
    setArchiving({ p, docs: null });
    api.get(`/retention/policies/${p.id}/impact`).then((r) => setArchiving({ p, docs: r.data.documents })).catch(() => setArchiving({ p, docs: -1 }));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-mac-caption text-(--text-secondary) max-w-2xl">Quando mais de um prazo vale para o mesmo documento, prevalece o mais longo. Um prazo travado não pode ser encurtado e impede excluir o documento antes do fim dele.</p>
        {isAdmin && (
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setCatalog(true)}><Sparkles className="w-4 h-4" aria-hidden="true" /> Tabela pronta</Button>
            <Button onClick={() => setEditing("nova")}><Plus className="w-4 h-4" aria-hidden="true" /> Novo prazo</Button>
          </div>
        )}
      </div>
      {policies.length === 0 ? (
        <div className="glass-panel glass-blur-card rounded-(--radius-panel) px-5 py-6 space-y-2">
          <p className="text-mac-body text-(--text-primary)">Nenhum prazo de guarda cadastrado.</p>
          <p className="text-mac-caption text-(--text-secondary)">Comece pela tabela pronta (fiscal, folha, registro de empregados, saúde ocupacional e contratos) e ajuste com a contabilidade.</p>
        </div>
      ) : (
        <ul className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) divide-y divide-(--border-default)">
          {policies.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 sm:px-5 py-3">
              <div className="flex-1 min-w-56">
                <p className="text-mac-body text-(--text-primary)">
                  {p.name}
                  {p.locked && <span className="ml-2 inline-flex items-center gap-1 text-mac-caption font-medium text-(--text-accent)"><Lock className="w-3 h-3" aria-hidden="true" /> travado</span>}
                </p>
                <p className="text-mac-caption text-(--text-secondary)">
                  {policyText(p)}{p.legal_basis ? ` · ${p.legal_basis}` : ""} · {p.assignment_count ? `vale em ${p.assignment_count} ${p.assignment_count === 1 ? "lugar" : "lugares"}` : "ainda não vale em lugar nenhum"}
                </p>
                {p.notes && <p className="text-mac-caption text-(--text-secondary)">{p.notes}</p>}
              </div>
              {isAdmin && (
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(p)} aria-label={`Editar ${p.name}`}><Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Editar</Button>
                  <Button variant="ghost" size="sm" onClick={() => openArchive(p)} aria-label={`Arquivar ${p.name}`}><Archive className="w-3.5 h-3.5" aria-hidden="true" /> Arquivar</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <PolicyDialog companyId={companyId} policy={editing === "nova" ? undefined : editing} fields={fields} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />}
      {catalog && <RetentionCatalogDialog companyId={companyId} onClose={() => setCatalog(false)} onApplied={() => { setCatalog(false); onChanged(); }} />}
      {archiving && (
        <ConfirmModal
          title={`Arquivar “${archiving.p.name}”?`}
          description={archiving.docs === null ? "Calculando quantos documentos dependem deste prazo…"
            : archiving.docs > 0 ? <>{archiving.docs} {archiving.docs === 1 ? "documento tem" : "documentos têm"} hoje o prazo definido por ele e {archiving.docs === 1 ? "passa" : "passam"} a seguir outro prazo, ou nenhum. A decisão fica na trilha.</>
            : "Nenhum documento depende hoje deste prazo."}
          confirmLabel="Arquivar" danger={!!archiving.docs && archiving.docs > 0} loading={busy}
          onClose={() => setArchiving(null)}
          onConfirm={async () => {
            setBusy(true);
            try { await api.post(`/retention/policies/${archiving.p.id}/archive`); success("Prazo arquivado."); setArchiving(null); onChanged(); }
            catch (e) { showError(friendly(e, "Não foi possível arquivar.")); } finally { setBusy(false); }
          }}
        />
      )}
    </div>
  );
}

function PolicyDialog({ companyId, policy, fields, onClose, onSaved }: { companyId: string; policy?: Policy; fields: Field[]; onClose: () => void; onSaved: () => void }) {
  const { success, error: showError } = useToast();
  const uid = useId();
  const [name, setName] = useState(policy?.name ?? "");
  const [legal, setLegal] = useState(policy?.legal_basis ?? "");
  const [notes, setNotes] = useState(policy?.notes ?? "");
  const [permanent, setPermanent] = useState(policy ? policy.duration_months === null : false);
  const initYears = policy?.duration_months && policy.duration_months % 12 === 0;
  const [unit, setUnit] = useState<"anos" | "meses">(policy && !initYears && policy.duration_months ? "meses" : "anos");
  const [amount, setAmount] = useState(policy?.duration_months ? String(initYears ? policy.duration_months / 12 : policy.duration_months) : "5");
  const [startRule, setStartRule] = useState<"data" | "ano_seguinte">(policy?.start_rule ?? "data");
  const [trigger, setTrigger] = useState(policy?.trigger_type === "custom_field" && policy.trigger_custom_field_id ? policy.trigger_custom_field_id : "");
  const [locked, setLocked] = useState(policy?.locked ?? false);
  const [saving, setSaving] = useState(false);
  const months = permanent ? null : Number(amount) * (unit === "anos" ? 12 : 1);
  const invalid = !name.trim() || (!permanent && (!Number.isInteger(Number(amount)) || Number(amount) < 1 || (months ?? 0) > 1200));
  const lockedMin = policy?.locked ? policy.duration_months : undefined;

  async function save() {
    setSaving(true);
    const body = {
      name: name.trim(), legal_basis: legal.trim() || null, notes: notes.trim() || null, start_rule: startRule,
      trigger_type: trigger ? "custom_field" : "upload_date", trigger_custom_field_id: trigger || null, locked,
    };
    try {
      if (policy) await api.patch(`/retention/policies/${policy.id}`, { ...body, ...(permanent ? { indeterminate: true } : { duration_months: months }) });
      else await api.post(`/companies/${companyId}/retention/policies`, { ...body, company_id: companyId, duration_months: months });
      success(policy ? "Prazo atualizado." : "Prazo cadastrado. Agora diga onde ele vale.");
      onSaved();
    } catch (e) { showError(friendly(e, "Não foi possível salvar.")); } finally { setSaving(false); }
  }

  return (
    <Dialog onClose={onClose} title={policy ? `Editar “${policy.name}”` : "Novo prazo de guarda"} size="md" busy={saving}
      description={policy?.locked ? "Este prazo é travado: só pode ser aumentado, e o início da contagem não muda." : "Por quanto tempo guardar, a partir de quando, e se pode ser encurtado depois."}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} disabled={invalid} onClick={save}>{policy ? "Salvar" : "Cadastrar"}</Button></>}>
      <div className="space-y-4">
        <Input label="Nome" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Ex.: Fiscal — 5 anos" autoFocus />
        <fieldset className="space-y-2">
          <legend className="text-mac-body font-medium text-(--text-secondary) mb-1">Guardar por</legend>
          <label className="flex items-center gap-2 text-mac-body text-(--text-primary)">
            <Checkbox checked={permanent} disabled={policy?.locked && policy.duration_months !== null} onChange={(e) => setPermanent(e.target.checked)} /> Para sempre (guarda permanente)
          </label>
          {!permanent && (
            <div className="flex gap-2">
              <div className="w-28"><Input aria-label="Quantidade" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, "").slice(0, 4))} /></div>
              <div className="w-36"><Dropdown ariaLabel="Unidade" value={unit} onChange={(v) => setUnit(v as "anos" | "meses")} options={[{ value: "anos", label: "anos" }, { value: "meses", label: "meses" }]} /></div>
            </div>
          )}
          {lockedMin && months !== null && months < lockedMin && <p className="text-mac-caption text-(--text-danger)">Travado: o mínimo é {durationText(lockedMin)}.</p>}
        </fieldset>
        <div>
          <label id={`${uid}-trg`} className="block text-mac-body font-medium text-(--text-secondary) mb-1">Contar a partir de</label>
          <Dropdown ariaLabelledby={`${uid}-trg`} value={trigger} onChange={setTrigger} disabled={policy?.locked}
            options={[{ value: "", label: "Data de envio do documento" }, ...fields.map((f) => ({ value: f.id, label: `Campo “${f.label}”` }))]} />
          <p className="mt-1 text-mac-caption text-(--text-secondary)">Para RH e contratos, use um campo de data (desligamento, fim do contrato). Documentos importados do Arquivar mantêm a data original de envio.</p>
        </div>
        <label className="flex items-start gap-3 text-mac-body text-(--text-primary)">
          <Checkbox checked={startRule === "ano_seguinte"} disabled={policy?.locked} onChange={(e) => setStartRule(e.target.checked ? "ano_seguinte" : "data")} className="mt-0.5" />
          <span>Começar a contar em 1º de janeiro do ano seguinte<span className="block text-mac-caption text-(--text-secondary)">Regra comum na guarda fiscal: uma nota de março de 2026 conta a partir de 1º/1/2027.</span></span>
        </label>
        <label className="flex items-start gap-3 text-mac-body text-(--text-primary)">
          <Checkbox checked={locked} disabled={policy?.locked} onChange={(e) => setLocked(e.target.checked)} className="mt-0.5" />
          <span>Travar este prazo<span className="block text-mac-caption text-(--text-secondary)">Ninguém consegue excluir o documento antes do fim, nem encurtar o prazo depois. Use para exigências legais.</span></span>
        </label>
        <Input label="Base legal (opcional)" value={legal} onChange={(e) => setLegal(e.target.value)} maxLength={200} placeholder="Ex.: CTN art. 173" />
        <Input label="Observação (opcional)" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </div>
    </Dialog>
  );
}

function RetentionCatalogDialog({ companyId, onClose, onApplied }: { companyId: string; onClose: () => void; onApplied: () => void }) {
  const { success, error: showError } = useToast();
  const [items, setItems] = useState<(Policy & { key: string; prazo: string; ja_existe: boolean })[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.get(`/companies/${companyId}/retention/catalog`).then((r) => setItems(r.data)).catch(() => setItems([])); }, [companyId]);
  async function apply() {
    setSaving(true);
    try { const r = await api.post(`/companies/${companyId}/retention/catalog`, { keys: [...sel] }); success(`${r.data.created} prazos cadastrados. Agora diga onde cada um vale.`); onApplied(); }
    catch (e) { showError(friendly(e, "Não foi possível cadastrar.")); } finally { setSaving(false); }
  }
  return (
    <Dialog onClose={onClose} title="Tabela de temporalidade pronta" size="lg" busy={saving}
      description="Prazos comuns para começar. Confira com a contabilidade e o jurídico: convenções e atividades específicas podem exigir mais."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} disabled={!sel.size} onClick={apply}>Cadastrar {sel.size || ""}</Button></>}>
      {!items ? <div className="h-32 rounded bg-(--bg-hover) animate-pulse" /> : (
        <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
          {items.map((p) => (
            <li key={p.key}>
              <label className={`flex items-start gap-3 px-3 py-2.5 ${p.ja_existe ? "opacity-60" : "cursor-pointer hover:bg-(--bg-hover)"}`}>
                <Checkbox className="mt-1" checked={p.ja_existe || sel.has(p.key)} disabled={p.ja_existe}
                  onChange={() => setSel((s) => { const n = new Set(s); if (n.has(p.key)) n.delete(p.key); else n.add(p.key); return n; })} />
                <span>
                  <span className="block text-mac-body font-medium text-(--text-primary)">{p.name}{p.ja_existe && <span className="font-normal text-(--text-secondary)"> · já cadastrado</span>}</span>
                  <span className="block text-mac-caption text-(--text-secondary)">{p.notes}</span>
                  <span className="block text-mac-caption text-(--text-secondary)">{p.prazo}{p.locked ? " · travado" : ""}{p.legal_basis ? ` · ${p.legal_basis}` : ""}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

// ─── Onde vale (A7-88..A7-97) ───────────────────────────────────────────────

interface Simulation {
  total_documents_in_scope: number; changed_count: number; newly_covered_count: number; already_expired_count: number; missing_trigger_count: number;
  sample: { document_id: string; document_name: string; before_policy: string | null; before_expires_at: string | null; before_indeterminate: boolean | null; after_policy: string | null; after_expires_at: string | null; after_indeterminate: boolean | null }[];
}

function WhereTab({ companyId, isAdmin, policies, folders, assignments, initialFolderId, onChanged }: {
  companyId: string; isAdmin: boolean; policies: Policy[]; folders: FolderOption[]; assignments: Assignment[]; initialFolderId?: string; onChanged: () => void;
}) {
  const { success, error: showError } = useToast();
  const [folderId, setFolderId] = useState(initialFolderId ?? "");
  const [policyId, setPolicyId] = useState("");
  const [sim, setSim] = useState<Simulation | null>(null);
  const [simState, setSimState] = useState<"idle" | "loading" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<{ a: Assignment; docs: number | null } | null>(null);
  // Filtros além da pasta (A7-89): tipo do documento e valor de metadado.
  const [tipo, setTipo] = useState("");
  const [campoId, setCampoId] = useState("");
  const [campoValor, setCampoValor] = useState("");
  const [campos, setCampos] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    api.get(`/custom-fields`, { params: { company_id: companyId } })
      .then((r) => setCampos((Array.isArray(r.data) ? r.data : []).map((c: any) => ({ id: c.id, label: c.label }))))
      .catch(() => setCampos([]));
  }, [companyId]);
  const filtroCampoIncompleto = !!campoId !== !!campoValor.trim();
  const filtros = {
    match_tipo_fiscal: tipo.trim() || undefined,
    match_field_id: campoId && campoValor.trim() ? campoId : undefined,
    match_field_value: campoId && campoValor.trim() ? campoValor.trim() : undefined,
  };

  useEffect(() => {
    setSim(null);
    if (!policyId || filtroCampoIncompleto) { setSimState("idle"); return; }
    setSimState("loading");
    const t = window.setTimeout(() => {
      api.get<Simulation>(`/companies/${companyId}/retention/assignments/simulate`, { params: { policy_id: policyId, folder_id: folderId || undefined, ...filtros } })
        .then((r) => { setSim(r.data); setSimState("idle"); }).catch(() => setSimState("error"));
    }, 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, folderId, policyId, tipo, campoId, campoValor]);

  const folderOpts = useMemo(() => [{ value: "", label: "Empresa toda" }, ...[...folders].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ value: f.id, label: f.name, depth: f.path.split(".").length - 1 }))], [folders]);
  const fmt = (exp: string | null, ind: boolean | null, pol: string | null) => (!pol ? "sem prazo" : ind ? `${pol} · permanente` : `${pol} · até ${exp ? fmtDate(exp) : "—"}`);

  async function assign() {
    setBusy(true);
    try {
      await api.post(`/companies/${companyId}/retention/assignments`, { company_id: companyId, folder_id: folderId || null, policy_id: policyId, ...filtros });
      success("Prazo atribuído."); setPolicyId(""); setTipo(""); setCampoId(""); setCampoValor(""); onChanged();
    }
    catch (e) { showError(friendly(e, "Não foi possível atribuir.")); } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="onde-lista" className="space-y-2">
        <h2 id="onde-lista" className="text-mac-body font-semibold text-(--text-primary)">Prazos em uso</h2>
        {assignments.length === 0 ? <p className="text-mac-body text-(--text-secondary)">Nenhum prazo atribuído ainda.</p> : (
          <ul className="glass-panel glass-blur-card rounded-(--radius-panel) divide-y divide-(--border-default)">
            {assignments.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-2.5 min-h-12">
                {a.folder_path ? <Folder className="w-4 h-4 text-(--text-secondary) shrink-0" aria-hidden="true" /> : <ShieldAlert className="w-4 h-4 text-(--text-secondary) shrink-0" aria-hidden="true" />}
                <div className="flex-1 min-w-0">
                  <p className="text-mac-body text-(--text-primary) truncate">
                    {a.folder_id ? <Link to={`/documents?folder_id=${a.folder_id}`} className="hover:underline">{a.folder_label ?? "Pasta"}</Link> : "Empresa toda"}
                  </p>
                  <p className="text-mac-caption text-(--text-secondary)">
                    {a.policy_name}
                    {a.match_tipo_fiscal ? ` · só tipo ${a.match_tipo_fiscal}` : ""}
                    {a.match_field_id ? ` · só ${a.match_field_label ?? "campo"} = “${a.match_field_value}”` : ""}
                    {` · ${a.document_count} ${a.document_count === 1 ? "documento" : "documentos"}`}
                  </p>
                </div>
                {isAdmin && (
                  <Button variant="icon" size="sm" aria-label={`Remover ${a.policy_name} de ${a.folder_label ?? "empresa toda"}`}
                    onClick={() => { setRemoving({ a, docs: null }); api.get(`/retention/assignments/${a.id}/impact`, { params: { company_id: companyId } }).then((r) => setRemoving({ a, docs: r.data.documents })).catch(() => setRemoving({ a, docs: -1 })); }}>
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {isAdmin && (
        <section aria-labelledby="onde-novo" className="glass-panel glass-blur-card rounded-(--radius-panel) p-4 sm:p-5 space-y-4">
          <h2 id="onde-novo" className="text-mac-body font-semibold text-(--text-primary)">Atribuir um prazo</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div><label id="onde-f" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Onde (vale também nas subpastas)</label><Dropdown ariaLabelledby="onde-f" value={folderId} onChange={setFolderId} options={folderOpts} /></div>
            <div><label id="onde-p" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Prazo</label><Dropdown ariaLabelledby="onde-p" value={policyId} onChange={setPolicyId} placeholder="Escolha o prazo" options={policies.map((p) => ({ value: p.id, label: p.name }))} /></div>
          </div>
          <details className="group rounded-(--radius-control) border border-(--border-default) px-3 py-2" open={!!(tipo || campoId)}>
            <summary className="cursor-pointer text-mac-caption font-medium text-(--text-secondary) select-none">Só alguns documentos (por tipo ou metadado)</summary>
            <p className="mt-1.5 text-mac-caption text-(--text-tertiary)">Pastas mudam; o tipo e os metadados acompanham o documento. Deixe em branco para valer para todos do lugar escolhido.</p>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="onde-tipo" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Tipo do documento</label>
                <input id="onde-tipo" list="onde-tipos" value={tipo} onChange={(e) => setTipo(e.target.value)} placeholder="Ex.: NF-e" maxLength={60}
                  className="w-full h-8 pointer-coarse:h-11 px-2.5 rounded-[6px] border border-(--border-control) bg-(--bg-card) text-mac-body text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-2 focus:ring-(--focus-ring)" />
                <datalist id="onde-tipos"><option value="NF-e" /><option value="NFC-e" /><option value="NFS-e" /><option value="CT-e" /></datalist>
              </div>
              <div>
                <label id="onde-campo" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Campo</label>
                <Dropdown ariaLabelledby="onde-campo" value={campoId} onChange={setCampoId} placeholder={campos.length ? "Nenhum" : "Sem campos cadastrados"}
                  options={[{ value: "", label: "Nenhum" }, ...campos.map((c) => ({ value: c.id, label: c.label }))]} />
              </div>
              <div>
                <label htmlFor="onde-valor" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Valor do campo</label>
                <input id="onde-valor" value={campoValor} onChange={(e) => setCampoValor(e.target.value)} disabled={!campoId} placeholder={campoId ? "Ex.: Holerite" : "Escolha o campo"} maxLength={200}
                  aria-invalid={filtroCampoIncompleto || undefined}
                  className="w-full h-8 pointer-coarse:h-11 px-2.5 rounded-[6px] border border-(--border-control) bg-(--bg-card) text-mac-body text-(--text-primary) placeholder:text-(--text-placeholder) disabled:opacity-(--opacity-disabled) focus:outline-hidden focus:ring-2 focus:ring-(--focus-ring)" />
              </div>
            </div>
            {filtroCampoIncompleto && <p className="mt-1.5 text-mac-caption text-(--text-warning)">Informe o valor do campo (sem diferença de maiúsculas).</p>}
          </details>
          <div aria-live="polite">
            {simState === "loading" && <p className="text-mac-caption text-(--text-secondary)">Calculando o efeito…</p>}
            {simState === "error" && <p className="text-mac-caption text-(--text-danger)">Não foi possível calcular o efeito. Tente escolher de novo.</p>}
            {sim && (
              <div className="reveal space-y-2">
                <p className="text-mac-body text-(--text-primary)">
                  {sim.total_documents_in_scope} {sim.total_documents_in_scope === 1 ? "documento" : "documentos"} no lugar escolhido; <strong>{sim.changed_count}</strong> {sim.changed_count === 1 ? "passa" : "passam"} a seguir este prazo
                  {sim.newly_covered_count ? ` (${sim.newly_covered_count} sem prazo nenhum até agora)` : ""}.
                </p>
                {sim.already_expired_count > 0 && <p className="text-mac-caption text-(--text-warning)">{sim.already_expired_count} já {sim.already_expired_count === 1 ? "entra vencido" : "entram vencidos"} e {sim.already_expired_count === 1 ? "vai" : "vão"} para a fila de descarte (nada é apagado sem decisão).</p>}
                {sim.missing_trigger_count > 0 && <p className="text-mac-caption text-(--text-warning)">{sim.missing_trigger_count} sem o campo de data preenchido: não ganham prazo até o campo ser preenchido.</p>}
                {sim.sample.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-mac-caption">
                      <caption className="sr-only">Exemplos de documentos que mudam</caption>
                      <thead><tr className="text-left text-(--text-secondary)"><th scope="col" className="py-1 pr-3 font-medium">Documento</th><th scope="col" className="py-1 pr-3 font-medium">Hoje</th><th scope="col" className="py-1 font-medium">Depois</th></tr></thead>
                      <tbody>
                        {sim.sample.map((s) => (
                          <tr key={s.document_id} className="border-t border-(--border-default)">
                            <td className="py-1 pr-3 text-(--text-primary) max-w-56 truncate">{s.document_name}</td>
                            <td className="py-1 pr-3 text-(--text-secondary) whitespace-nowrap">{fmt(s.before_expires_at, s.before_indeterminate, s.before_policy)}</td>
                            <td className="py-1 text-(--text-primary) whitespace-nowrap">{fmt(s.after_expires_at, s.after_indeterminate, s.after_policy)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
          <Button disabled={!policyId || busy || simState !== "idle" || filtroCampoIncompleto} loading={busy} onClick={assign}>Atribuir</Button>
        </section>
      )}

      {isAdmin && <HealthCheck companyId={companyId} assinatura={assignments.map((a) => a.id).join(",")} />}
      {isAdmin && <VersionsPolicyCard companyId={companyId} />}

      {removing && (
        <ConfirmModal
          title="Remover este prazo daqui?"
          description={removing.docs === null ? "Calculando quantos documentos perdem este prazo…" : removing.docs > 0
            ? <>{removing.docs} {removing.docs === 1 ? "documento tem" : "documentos têm"} hoje o prazo definido por “{removing.a.policy_name}” em {removing.a.folder_label ?? "toda a empresa"} e {removing.docs === 1 ? "passa" : "passam"} a seguir outro prazo, ou nenhum.</>
            : "Nenhum documento depende hoje desta atribuição."}
          confirmLabel="Remover" danger={!!removing.docs && removing.docs > 0} loading={busy}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            setBusy(true);
            try { await api.delete(`/retention/assignments/${removing.a.id}`, { params: { company_id: companyId } }); success("Prazo removido daqui."); setRemoving(null); onChanged(); }
            catch (e) { showError(friendly(e, "Não foi possível remover.")); } finally { setBusy(false); }
          }}
        />
      )}
    </div>
  );
}

type Saude = { policies_without_assignments: { id: string; name: string }[]; documents_without_policy_sample: { id: string; name: string; folder_name: string; folder_id: string }[]; documents_without_policy_has_more: boolean };
// Conferência guardada por 5 min (A7-105): reabrir a tela não recalcula tudo;
// muda a assinatura quando um prazo é atribuído ou removido.
const cacheSaude = new Map<string, { at: number; data: Saude }>();

function HealthCheck({ companyId, assinatura }: { companyId: string; assinatura: string }) {
  const chave = `${companyId}:${assinatura}`;
  const [data, setData] = useState<Saude | null>(() => { const c = cacheSaude.get(chave); return c && Date.now() - c.at < 300_000 ? c.data : null; });
  const [at, setAt] = useState<number | null>(() => cacheSaude.get(chave)?.at ?? null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => {
    setFailed(false); setBusy(true);
    api.get<Saude>(`/companies/${companyId}/retention/health-check`)
      .then((r) => { const agora = Date.now(); cacheSaude.set(chave, { at: agora, data: r.data }); setData(r.data); setAt(agora); })
      .catch(() => setFailed(true)).finally(() => setBusy(false));
  };
  useEffect(() => { if (!data) load(); }, [chave]); // eslint-disable-line react-hooks/exhaustive-deps
  if (failed) return <LoadError what="a conferência de cobertura" onRetry={load} />;
  if (!data) return null;
  const semPolitica = data.documents_without_policy_sample;
  return (
    <section aria-labelledby="saude" className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="saude" className="text-mac-body font-semibold text-(--text-primary)">O que está sem prazo</h2>
        <p className="text-mac-caption text-(--text-secondary)">
          {at ? `Conferido ${relativeDate(new Date(at).toISOString())}` : ""} · <button onClick={load} disabled={busy} className="font-medium text-(--text-accent) hover:underline disabled:opacity-(--opacity-disabled)">{busy ? "Conferindo…" : "Conferir de novo"}</button>
        </p>
      </div>
      {data.policies_without_assignments.length === 0 && semPolitica.length === 0 ? (
        <p className="text-mac-body text-(--text-secondary)">Todos os documentos têm prazo de guarda e todos os prazos estão em uso.</p>
      ) : (
        <div className="space-y-3">
          {data.policies_without_assignments.length > 0 && (
            <p className="text-mac-body text-(--text-primary)">
              Prazos cadastrados que não valem em lugar nenhum: {data.policies_without_assignments.map((p) => p.name).join(", ")}. Atribua acima.
            </p>
          )}
          {semPolitica.length > 0 && (
            <div>
              <p className="text-mac-body text-(--text-primary)">{data.documents_without_policy_has_more ? "Mais de 50" : semPolitica.length} {semPolitica.length === 1 ? "documento sem" : "documentos sem"} prazo de guarda:</p>
              <ul className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-x-4">
                {semPolitica.slice(0, 12).map((d) => (
                  <li key={d.id} className="truncate text-mac-caption"><Link to={`/documents?folder_id=${d.folder_id}&doc=${d.id}`} className="text-(--text-accent) hover:underline">{d.name}</Link> <span className="text-(--text-secondary)">· {d.folder_name}</span></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ─── Bloqueio judicial (A7-106..A7-113) ─────────────────────────────────────

function HoldTab({ companyId, isAdmin, holds, folders, onChanged }: { companyId: string; isAdmin: boolean; holds: Hold[]; folders: FolderOption[]; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [releasing, setReleasing] = useState<Hold | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const active = holds.filter((h) => !h.released_at);
  const released = holds.filter((h) => h.released_at);
  const target = (h: Hold) => (h.resource_type === "folder" ? `/documents?folder_id=${h.resource_id}` : `/documents?folder_id=${h.folder_id ?? ""}&doc=${h.resource_id}`);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-mac-caption text-(--text-secondary) max-w-2xl">Documentos e pastas sob bloqueio judicial (ordem, fiscalização ou processo) não podem ser excluídos por ninguém, nem pelo descarte, até a liberação com motivo.</p>
        {isAdmin && <Button onClick={() => setCreating(true)}><Plus className="w-4 h-4" aria-hidden="true" /> Novo bloqueio</Button>}
      </div>
      {active.length === 0 ? <p className="glass-panel glass-blur-card rounded-(--radius-panel) px-5 py-4 text-mac-body text-(--text-secondary)">Nenhum bloqueio ativo.</p> : (
        <ul className="glass-panel glass-blur-card rounded-(--radius-panel) divide-y divide-(--border-default)">
          {active.map((h) => (
            <li key={h.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              {h.resource_type === "folder" ? <Folder className="w-4 h-4 mt-0.5 text-(--text-secondary)" aria-hidden="true" /> : <FileText className="w-4 h-4 mt-0.5 text-(--text-secondary)" aria-hidden="true" />}
              <div className="flex-1 min-w-56">
                <Link to={target(h)} className="text-mac-body text-(--text-accent) hover:underline">{h.resource_name ?? "Item excluído"}</Link>
                <p className="text-mac-caption text-(--text-secondary)">{h.resource_type === "folder" ? "Pasta" : "Documento"}{h.resource_path ? ` em ${h.resource_path}` : ""}</p>
                <p className="text-mac-caption text-(--text-primary)">{h.reason}{h.process_number ? ` · processo ${h.process_number}` : ""}</p>
                <p className="text-mac-caption text-(--text-secondary)">
                  Desde {fmtDate(h.created_at)}{h.created_by_name ? `, por ${h.created_by_name}` : ""}{h.review_date ? ` · revisar em ${fmtDate(h.review_date)}` : ""}
                </p>
              </div>
              {isAdmin && <Button variant="secondary" size="sm" onClick={() => setReleasing(h)}>Liberar…</Button>}
            </li>
          ))}
        </ul>
      )}
      {released.length > 0 && (
        <div>
          <button aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)} className="text-mac-caption font-medium text-(--text-accent) hover:underline">{showHistory ? "Esconder" : "Ver"} {released.length} liberado{released.length > 1 ? "s" : ""}</button>
          {showHistory && (
            <ul className="mt-2 space-y-1">
              {released.map((h) => (
                <li key={h.id} className="text-mac-caption text-(--text-secondary)">
                  <span className="text-(--text-primary)">{h.resource_name ?? "Item excluído"}</span> · {h.reason} · liberado {h.released_at ? relativeDate(h.released_at) : ""}{h.released_by_name ? ` por ${h.released_by_name}` : ""}{h.release_reason ? `: ${h.release_reason}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {creating && <HoldDialog companyId={companyId} folders={folders} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); onChanged(); }} />}
      {releasing && <ReleaseDialog companyId={companyId} hold={releasing} onClose={() => setReleasing(null)} onDone={() => { setReleasing(null); onChanged(); }} />}
    </div>
  );
}

function HoldDialog({ companyId, folders, onClose, onCreated }: { companyId: string; folders: FolderOption[]; onClose: () => void; onCreated: () => void }) {
  const { success, error: showError } = useToast();
  const uid = useId();
  const [type, setType] = useState<"folder" | "document">("folder");
  const [folderId, setFolderId] = useState("");
  const [doc, setDoc] = useState<{ id: string; name: string } | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; folder_name?: string }[] | null>(null);
  const [reason, setReason] = useState("");
  const [proc, setProc] = useState("");
  const [review, setReview] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (type !== "document" || doc || q.trim().length < 2) { setHits(null); return; }
    const t = setTimeout(() => api.get("/search", { params: { q: q.trim(), company_id: companyId, page_size: 8 } }).then((r) => setHits(r.data?.results ?? [])).catch(() => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q, type, doc, companyId]);

  const resourceId = type === "folder" ? folderId : doc?.id ?? "";
  async function save() {
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/retention/holds`, { company_id: companyId, resource_type: type, resource_id: resourceId, reason: reason.trim(), process_number: proc.trim() || null, review_date: review || null });
      success("Bloqueio criado. Ninguém consegue excluir até a liberação."); onCreated();
    } catch (e) { showError(friendly(e, "Não foi possível criar o bloqueio.")); } finally { setSaving(false); }
  }

  return (
    <Dialog onClose={onClose} title="Novo bloqueio judicial" size="md" busy={saving}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} disabled={!resourceId || !reason.trim()} onClick={save}>Bloquear</Button></>}>
      <div className="space-y-4">
        <div role="group" aria-label="O que bloquear" className="flex gap-1.5">
          {([["folder", "Uma pasta inteira"], ["document", "Um documento"]] as const).map(([v, l]) => (
            <button key={v} type="button" aria-pressed={type === v} onClick={() => { setType(v); setDoc(null); }}
              className={`px-3 h-9 pointer-coarse:h-11 rounded-full text-mac-body font-medium border transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${type === v ? "bg-(--accent) text-white border-(--accent)" : "border-(--border-control) text-(--text-primary) hover:bg-(--bg-hover)"}`}>{l}</button>
          ))}
        </div>
        {type === "folder" ? (
          <div><label id={`${uid}-f`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Pasta (inclui subpastas)</label>
            <Dropdown ariaLabelledby={`${uid}-f`} value={folderId} onChange={setFolderId} placeholder="Escolha a pasta"
              options={[...folders].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ value: f.id, label: f.name, depth: f.path.split(".").length - 1 }))} />
          </div>
        ) : doc ? (
          <p className="flex items-center gap-2 text-mac-body text-(--text-primary)"><FileText className="w-4 h-4" aria-hidden="true" /> <strong className="truncate">{doc.name}</strong>
            <button onClick={() => setDoc(null)} className="ml-auto text-mac-caption font-medium text-(--text-accent) hover:underline">Trocar</button></p>
        ) : (
          <div>
            <label htmlFor={`${uid}-q`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Documento</label>
            <div className="relative"><Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-secondary)" aria-hidden="true" />
              <input id={`${uid}-q`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome ou trecho do texto"
                className="h-9 pointer-coarse:h-11 w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) pl-8 pr-3 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" /></div>
            {hits && (
              <ul aria-label="Documentos encontrados" className="mt-2 max-h-52 overflow-y-auto rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)">
                {hits.length === 0 ? <li className="px-3 py-2 text-mac-body text-(--text-secondary)">Nada encontrado.</li> : hits.map((h) => (
                  <li key={h.id}><button onClick={() => setDoc(h)} className="w-full text-left px-3 py-2 min-h-11 hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)">
                    <span className="block truncate text-mac-body text-(--text-primary)">{h.name}</span><span className="block text-mac-caption text-(--text-secondary)">{h.folder_name ?? ""}</span></button></li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Input label="Motivo" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Ex.: Reclamação trabalhista de ex-funcionário" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input label="Nº do processo (opcional)" value={proc} onChange={(e) => setProc(e.target.value)} maxLength={80} />
          <Input label="Revisar em (opcional)" type="date" value={review} onChange={(e) => setReview(e.target.value)} />
        </div>
      </div>
    </Dialog>
  );
}

function ReleaseDialog({ companyId, hold, onClose, onDone }: { companyId: string; hold: Hold; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const id = useId();
  async function save() {
    setSaving(true);
    try { await api.post(`/retention/holds/${hold.id}/release`, { reason: reason.trim() }, { params: { company_id: companyId } }); success("Bloqueio liberado, com o motivo na trilha."); onDone(); }
    catch (e) { showError(friendly(e, "Não foi possível liberar.")); } finally { setSaving(false); }
  }
  return (
    <Dialog onClose={onClose} title={`Liberar “${hold.resource_name ?? "item"}”?`} size="sm" busy={saving}
      description="Depois de liberado, o item volta a seguir o prazo de guarda e pode ser excluído."
      footer={<><Button variant="secondary" onClick={onClose}>Voltar</Button><Button loading={saving} disabled={!reason.trim()} onClick={save}>Liberar</Button></>}>
      <label htmlFor={id} className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Por que liberar?</label>
      <textarea id={id} rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="Ex.: processo arquivado em 10/11/2026"
        className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
    </Dialog>
  );
}

// ─── Lixeira (A7-69, A7-75, A7-76) ──────────────────────────────────────────

function TrashTab({ companyId, isSupremo }: { companyId: string; isSupremo: boolean }) {
  const { success, error: showError } = useToast();
  const [days, setDays] = useState<number | null>(null);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.get(`/companies/${companyId}/retention`).then((r) => { setDays(r.data.retention_days ?? 30); setValue(String(r.data.retention_days ?? 30)); }).catch(() => setDays(-1)); }, [companyId]);
  async function save() {
    setSaving(true);
    try { const r = await api.patch(`/companies/${companyId}/retention`, { retention_days: Number(value) }); setDays(r.data.retention_days); success("Prazo da lixeira atualizado."); }
    catch (e) { showError(friendly(e, "Não foi possível salvar.")); } finally { setSaving(false); }
  }
  if (days === null) return <div className="h-24 rounded bg-(--bg-hover) animate-pulse" />;
  if (days === -1) return <p className="text-mac-body text-(--text-danger)">Não foi possível carregar o prazo da lixeira.</p>;
  const n = Number(value);
  return (
    <section className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 space-y-3 max-w-xl">
      <h2 className="text-mac-body font-semibold text-(--text-primary)">Quanto tempo o que é excluído fica na lixeira</h2>
      <p className="text-mac-caption text-(--text-secondary)">Isso é diferente do prazo de guarda: aqui é o tempo para recuperar algo excluído por engano. Documentos com bloqueio ou prazo travado não são apagados da lixeira antes da hora.</p>
      {isSupremo ? (
        <>
          <div className="flex items-end gap-2">
            <div className="w-28"><Input label="Dias" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 4))} /></div>
            <Button loading={saving} disabled={!n || n < 1 || n === days} onClick={save}>Salvar</Button>
          </div>
          <p className="text-mac-caption text-(--text-secondary)">Itens excluídos há mais de {Math.min(n || days, 7)} dias continuam com o prazo antigo; os mais recentes passam a seguir o novo.</p>
        </>
      ) : (
        <p className="text-mac-body text-(--text-primary)"><strong>{days} dias.</strong> <span className="text-(--text-secondary)">Só o administrador geral do Docke altera este prazo.</span></p>
      )}
    </section>
  );
}

// ─── Certificados (A7-70) ───────────────────────────────────────────────────

function CertificatesTab({ companyId, certs }: { companyId: string; certs: Certificate[] }) {
  const { error: showError } = useToast();
  async function exportCsv() {
    try {
      const r = await api.get(`/companies/${companyId}/retention/certificates.csv`, { responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a"); a.href = url; a.download = "certificados-de-descarte.csv"; a.click(); URL.revokeObjectURL(url);
    } catch (e) { showError(friendly(e, "Não foi possível exportar.")); }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-mac-caption text-(--text-secondary)">Prova de cada descarte: o documento, o hash do arquivo, o prazo, quem aprovou e quem executou. Guarde uma cópia fora do sistema.</p>
        {certs.length > 0 && <Button variant="secondary" size="sm" onClick={exportCsv}><Download className="w-3.5 h-3.5" aria-hidden="true" /> Exportar CSV</Button>}
      </div>
      {certs.length === 0 ? <p className="text-mac-body text-(--text-secondary)">Nenhum descarte executado.</p> : (
        <ul className="glass-panel glass-blur-card rounded-(--radius-panel) divide-y divide-(--border-default)">
          {certs.map((c) => (
            <li key={c.id} className="px-4 py-2.5">
              <p className="text-mac-body text-(--text-primary)">{c.document_name_snapshot}</p>
              <p className="text-mac-caption text-(--text-secondary)">
                {c.folder_path_snapshot ?? ""} · {c.policy_name_snapshot}{c.legal_basis_snapshot ? ` (${c.legal_basis_snapshot})` : ""} · excluído <time dateTime={c.executed_at} title={fullDate(c.executed_at)}>{relativeDate(c.executed_at)}</time> por {c.executed_by_name_snapshot}
              </p>
              {c.document_sha256 && <p className="text-mac-caption2 font-mono text-(--text-secondary) break-all">SHA-256 {c.document_sha256}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
