import { useEffect, useState } from "react";
import { AlertTriangle, ScrollText, Lock, Unlock, Inbox, Trash2, Plus } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import Dropdown from "@/components/ui/Dropdown";

// Fase 5.1-5.3 — Retenção legal: política / atribuição / hold / fila de
// revisão. Nada aqui apaga um documento: política só calcula uma data, hold
// só bloqueia exclusão, a fila só registra candidatos e espera decisão
// humana. "Aprovar" na fila marca o status, não executa exclusão nenhuma —
// a execução real é uma fatia futura, combinada separadamente.

interface FolderOption { id: string; name: string; path: string }

function folderDepth(path: string) {
  return path ? path.split(".").length : 0;
}

const TRIGGER_LABEL: Record<string, string> = { upload_date: "Data de upload", custom_field: "Campo de metadado" };

interface Policy {
  id: string;
  name: string;
  legal_basis: string | null;
  trigger_type: string;
  duration_months: number | null;
  locked: boolean;
}

interface Assignment {
  id: string;
  folder_path: string | null;
  policy_id: string;
  policy_name: string;
}

interface Hold {
  id: string;
  resource_type: string;
  resource_id: string;
  reason: string;
  created_at: string;
}

interface QueueItem {
  id: string;
  document_id: string;
  document_name: string;
  policy_name_snapshot: string;
  computed_expires_at: string;
  status: string;
  review_notes: string | null;
  deferred_until: string | null;
}

const inputClass = "w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70";
const labelClass = "block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5";

export default function Retention() {
  usePageTitle("Retenção");
  const { current } = useCompany();
  const { success, error: showError } = useToast();

  // --- lixeira (já existia) ---
  const [days, setDays] = useState(30);
  const [loadingDays, setLoadingDays] = useState(true);
  const [savingDays, setSavingDays] = useState(false);

  // --- políticas / atribuições / holds / fila ---
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  function load() {
    if (!current) return;
    setLoadingDays(true);
    api.get(`/companies/${current.id}/retention`).then((r) => setDays(r.data.retention_days ?? 30)).catch(() => {}).finally(() => setLoadingDays(false));

    setLoading(true);
    Promise.all([
      api.get<FolderOption[]>("/folders", { params: { company_id: current.id, flat: true } }),
      api.get<Policy[]>(`/companies/${current.id}/retention/policies`),
      api.get<Assignment[]>(`/companies/${current.id}/retention/assignments`),
      api.get<Hold[]>(`/companies/${current.id}/retention/holds`),
      api.get<QueueItem[]>(`/companies/${current.id}/retention/queue`, { params: { status: "pending" } }),
    ])
      .then(([f, p, a, h, q]) => {
        setFolders(Array.isArray(f.data) ? f.data : []);
        setPolicies(Array.isArray(p.data) ? p.data : []);
        setAssignments(Array.isArray(a.data) ? a.data : []);
        setHolds(Array.isArray(h.data) ? h.data : []);
        setQueue(Array.isArray(q.data) ? q.data : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, [current?.id]);

  async function saveDays() {
    if (!current) return;
    setSavingDays(true);
    try {
      const { data } = await api.patch(`/companies/${current.id}/retention`, { retention_days: days });
      success(`Retenção da lixeira atualizada para ${data.retention_days} dias.`);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Erro ao atualizar retenção.");
    } finally {
      setSavingDays(false);
    }
  }

  async function archivePolicy(policy: Policy) {
    try {
      await api.post(`/retention/policies/${policy.id}/archive`);
      success(`Política "${policy.name}" arquivada.`);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível arquivar a política.");
    }
  }

  async function removeAssignment(a: Assignment) {
    try {
      await api.delete(`/retention/assignments/${a.id}`, { params: { company_id: current!.id } });
      success("Atribuição removida.");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível remover.");
    }
  }

  async function releaseHold(h: Hold) {
    try {
      await api.post(`/retention/holds/${h.id}/release`, null, { params: { company_id: current!.id } });
      success("Hold liberado.");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível liberar o hold.");
    }
  }

  async function decideQueue(item: QueueItem, decision: "approved" | "rejected" | "deferred") {
    let notes: string | null = null;
    let deferredUntil: string | null = null;
    if (decision === "rejected") {
      notes = window.prompt("Motivo de manter o documento (opcional):");
    } else if (decision === "deferred") {
      deferredUntil = window.prompt("Adiar até quando? (yyyy-mm-dd)");
      if (!deferredUntil) return;
    } else if (decision === "approved") {
      if (!window.confirm(`Aprovar "${item.document_name}" para descarte? Isso NÃO exclui o documento agora — só marca como aprovado, aguardando a etapa de execução (ainda não implementada).`)) return;
    }
    try {
      await api.post(`/retention/queue/${item.id}/decision`, { status: decision, notes, deferred_until: deferredUntil }, { params: { company_id: current!.id } });
      success("Decisão registrada.");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível registrar a decisão.");
    }
  }

  const folderOptions = [{ value: "", label: "Empresa toda (raiz)" }, ...folders.map((f) => ({ value: f.id, label: f.name, depth: Math.max(0, folderDepth(f.path) - 1) }))];

  return (
    <div className="space-y-6">
      {/* Lixeira */}
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6 space-y-5">
        <p className="text-mac-body font-medium text-[var(--text-primary)]">Dias na lixeira antes da exclusão permanente</p>
        {loadingDays ? (
          <div className="h-9 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse max-w-[200px]" />
        ) : (
          <div className="flex items-center gap-2 max-w-[200px]">
            <input type="number" min={1} value={days} onChange={(e) => setDays(Math.max(1, Number(e.target.value)))} className={inputClass} />
            <span className="text-mac-body text-[var(--text-secondary)]">dias</span>
          </div>
        )}
        <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-[var(--radius-control)]">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-mac-caption text-amber-800 dark:text-amber-300">
            Itens excluídos há mais de {Math.min(days, 7)} dia(s) manterão a retenção anterior. Itens mais recentes seguirão a nova regra imediatamente.
          </p>
        </div>
        <div className="flex justify-end">
          <Button size="sm" loading={savingDays} onClick={saveDays}>Salvar</Button>
        </div>
      </div>

      {/* Políticas de retenção legal */}
      <PolicySection companyId={current?.id} policies={policies} loading={loading} onArchive={archivePolicy} onCreated={load} />

      {/* Atribuições */}
      <AssignmentSection companyId={current?.id} policies={policies} folderOptions={folderOptions} assignments={assignments} loading={loading} onRemove={removeAssignment} onCreated={load} />

      {/* Legal Holds */}
      <HoldSection companyId={current?.id} folderOptions={folderOptions} holds={holds} loading={loading} onRelease={releaseHold} onCreated={load} />

      {/* Fila de revisão */}
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Inbox className="w-4 h-4 text-teal-500" />
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Fila de descarte — aguardando revisão</h2>
        </div>
        <p className="text-mac-caption text-[var(--text-secondary)]">
          Documentos cujo prazo de retenção já passou entram aqui automaticamente (varredura diária) — nenhum é apagado sem essa revisão. "Aprovar" só marca a decisão; a exclusão em si ainda não está implementada nesta fase.
        </p>
        {loading ? (
          <div className="h-14 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />
        ) : queue.length === 0 ? (
          <p className="text-mac-caption text-[var(--text-tertiary)]">Nenhum documento pendente de revisão.</p>
        ) : (
          <ul className="border border-[var(--border-default)] rounded-[var(--radius-control)] divide-y divide-[var(--border-default)] overflow-hidden">
            {queue.map((q) => (
              <li key={q.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-mac-body text-[var(--text-primary)] truncate">{q.document_name}</p>
                  <p className="text-mac-caption text-[var(--text-tertiary)]">
                    {q.policy_name_snapshot} · venceu em {new Date(q.computed_expires_at + "T00:00:00").toLocaleDateString("pt-BR")}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => decideQueue(q, "deferred")}>Adiar</Button>
                <Button variant="ghost" size="sm" onClick={() => decideQueue(q, "rejected")}>Manter</Button>
                <Button variant="primary" size="sm" onClick={() => decideQueue(q, "approved")}>Aprovar descarte</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PolicySection({ companyId, policies, loading, onArchive, onCreated }: {
  companyId: string | undefined; policies: Policy[]; loading: boolean; onArchive: (p: Policy) => void; onCreated: () => void;
}) {
  const { success, error: showError } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [legalBasis, setLegalBasis] = useState("");
  const [durationMonths, setDurationMonths] = useState("");
  const [indeterminate, setIndeterminate] = useState(false);
  const [locked, setLocked] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!companyId || !name.trim()) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/retention/policies`, {
        company_id: companyId, name: name.trim(), legal_basis: legalBasis.trim() || null,
        trigger_type: "upload_date", duration_months: indeterminate ? null : (durationMonths ? Number(durationMonths) : null),
        locked,
      });
      success("Política criada.");
      setShowForm(false); setName(""); setLegalBasis(""); setDurationMonths(""); setIndeterminate(false); setLocked(false);
      onCreated();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar a política.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ScrollText className="w-4 h-4 text-teal-500" />
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Políticas de retenção legal</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus className="w-3.5 h-3.5" /> Nova política
        </Button>
      </div>

      {showForm && (
        <div className="border border-[var(--border-default)] rounded-[var(--radius-control)] p-4 space-y-3">
          <div>
            <label className={labelClass}>Nome</label>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Fiscal — 5 anos" autoFocus />
          </div>
          <div>
            <label className={labelClass}>Base legal (opcional)</label>
            <input className={inputClass} value={legalBasis} onChange={(e) => setLegalBasis(e.target.value)} placeholder="Ex.: Arts. 173 e 174 do CTN" />
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={indeterminate} onChange={(e) => setIndeterminate(e.target.checked)} id="indeterminate" />
            <label htmlFor="indeterminate" className="text-mac-caption text-[var(--text-secondary)]">Retenção indeterminada (nunca expira sozinha)</label>
          </div>
          {!indeterminate && (
            <div>
              <label className={labelClass}>Duração em meses</label>
              <input type="number" min={1} className={inputClass} value={durationMonths} onChange={(e) => setDurationMonths(e.target.value)} placeholder="Ex.: 60 (5 anos)" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <input type="checkbox" checked={locked} onChange={(e) => setLocked(e.target.checked)} id="locked" />
            <label htmlFor="locked" className="text-mac-caption text-[var(--text-secondary)]">Política travada — vence qualquer outra em caso de conflito</label>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancelar</Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={saving || !name.trim() || (!indeterminate && !durationMonths)}>{saving ? "Criando…" : "Criar"}</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-12 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />
      ) : policies.length === 0 ? (
        <p className="text-mac-caption text-[var(--text-tertiary)]">Nenhuma política cadastrada ainda.</p>
      ) : (
        <ul className="border border-[var(--border-default)] rounded-[var(--radius-control)] divide-y divide-[var(--border-default)] overflow-hidden">
          {policies.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-mac-body text-[var(--text-primary)] truncate">{p.name} {p.locked && <Badge variant="warning">Travada</Badge>}</p>
                <p className="text-mac-caption text-[var(--text-tertiary)]">
                  {p.duration_months ? `${p.duration_months} meses` : "Indeterminada"} · {TRIGGER_LABEL[p.trigger_type]}{p.legal_basis ? ` · ${p.legal_basis}` : ""}
                </p>
              </div>
              <button onClick={() => onArchive(p)} className="p-1.5 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title="Arquivar">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AssignmentSection({ companyId, policies, folderOptions, assignments, loading, onRemove, onCreated }: {
  companyId: string | undefined; policies: Policy[]; folderOptions: { value: string; label: string; depth?: number }[];
  assignments: Assignment[]; loading: boolean; onRemove: (a: Assignment) => void; onCreated: () => void;
}) {
  const { success, error: showError } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [policyId, setPolicyId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!companyId || !policyId) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/retention/assignments`, { company_id: companyId, folder_id: folderId || null, policy_id: policyId });
      success("Política atribuída.");
      setShowForm(false); setPolicyId(""); setFolderId("");
      onCreated();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível atribuir.");
    } finally {
      setSaving(false);
    }
  }

  if (policies.length === 0) return null;

  return (
    <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Onde cada política vale</h2>
        <Button variant="ghost" size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus className="w-3.5 h-3.5" /> Nova atribuição
        </Button>
      </div>

      {showForm && (
        <div className="border border-[var(--border-default)] rounded-[var(--radius-control)] p-4 space-y-3">
          <div>
            <label className={labelClass}>Política</label>
            <Dropdown value={policyId} onChange={setPolicyId} placeholder="Escolha a política" options={policies.map((p) => ({ value: p.id, label: p.name }))} />
          </div>
          <div>
            <label className={labelClass}>Pasta</label>
            <Dropdown value={folderId} onChange={setFolderId} placeholder="Empresa toda (raiz)" options={folderOptions} />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancelar</Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={saving || !policyId}>{saving ? "Atribuindo…" : "Atribuir"}</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-12 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />
      ) : assignments.length === 0 ? (
        <p className="text-mac-caption text-[var(--text-tertiary)]">Nenhuma política atribuída a uma pasta ainda.</p>
      ) : (
        <ul className="border border-[var(--border-default)] rounded-[var(--radius-control)] divide-y divide-[var(--border-default)] overflow-hidden">
          {assignments.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-4 py-2.5">
              <p className="flex-1 text-mac-body text-[var(--text-primary)]">
                {a.policy_name} <span className="text-[var(--text-tertiary)]">em</span> {a.folder_path ? a.folder_path.replace(/\./g, " / ") : "empresa toda"}
              </p>
              <button onClick={() => onRemove(a)} className="p-1.5 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title="Remover">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HoldSection({ companyId, folderOptions, holds, loading, onRelease, onCreated }: {
  companyId: string | undefined; folderOptions: { value: string; label: string; depth?: number }[];
  holds: Hold[]; loading: boolean; onRelease: (h: Hold) => void; onCreated: () => void;
}) {
  const { success, error: showError } = useToast();
  const [showForm, setShowForm] = useState(false);
  const [resourceType, setResourceType] = useState<"folder" | "document">("folder");
  const [folderId, setFolderId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (resourceType !== "document" || query.trim().length < 2 || !companyId) { setResults([]); return; }
    const handle = setTimeout(() => {
      api.get("/search", { params: { q: query.trim(), company_id: companyId, page_size: 8 } })
        .then((r) => setResults(Array.isArray(r.data?.results) ? r.data.results : []))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(handle);
  }, [query, companyId, resourceType]);

  async function submit() {
    if (!companyId || !reason.trim()) return;
    const resourceId = resourceType === "folder" ? folderId : documentId;
    if (!resourceId) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/retention/holds`, { company_id: companyId, resource_type: resourceType, resource_id: resourceId, reason: reason.trim() });
      success("Hold criado — recurso bloqueado para exclusão.");
      setShowForm(false); setFolderId(""); setDocumentId(""); setQuery(""); setReason("");
      onCreated();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar o hold.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Lock className="w-4 h-4 text-amber-500" />
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Legal Hold</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setShowForm((v) => !v)}>
          <Plus className="w-3.5 h-3.5" /> Novo hold
        </Button>
      </div>
      <p className="text-mac-caption text-[var(--text-secondary)]">Bloqueia exclusão mesmo com o prazo de retenção vencido — para documentos que viram prova num processo, por exemplo. Um hold em pasta protege tudo dentro dela, inclusive o que for adicionado depois.</p>

      {showForm && (
        <div className="border border-[var(--border-default)] rounded-[var(--radius-control)] p-4 space-y-3">
          <div className="flex gap-2">
            <button onClick={() => setResourceType("folder")} className={`px-3 py-1.5 rounded-full text-mac-caption border ${resourceType === "folder" ? "bg-teal-500/15 border-teal-500 text-teal-600 dark:text-teal-400" : "border-[var(--border-default)] text-[var(--text-secondary)]"}`}>Pasta</button>
            <button onClick={() => setResourceType("document")} className={`px-3 py-1.5 rounded-full text-mac-caption border ${resourceType === "document" ? "bg-teal-500/15 border-teal-500 text-teal-600 dark:text-teal-400" : "border-[var(--border-default)] text-[var(--text-secondary)]"}`}>Documento</button>
          </div>
          {resourceType === "folder" ? (
            <div>
              <label className={labelClass}>Pasta</label>
              <Dropdown value={folderId} onChange={setFolderId} placeholder="Escolha a pasta" options={folderOptions.filter((o) => o.value !== "")} />
            </div>
          ) : (
            <div>
              <label className={labelClass}>Buscar documento</label>
              <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Digite o nome do documento…" />
              {results.length > 0 && (
                <ul className="mt-2 border border-[var(--border-default)] rounded-[var(--radius-control)] overflow-hidden divide-y divide-[var(--border-default)]">
                  {results.map((r) => (
                    <li key={r.id}>
                      <button
                        onClick={() => { setDocumentId(r.id); setQuery(r.name); setResults([]); }}
                        className={`w-full text-left px-3 py-2 text-mac-body hover:bg-[var(--bg-hover)] ${documentId === r.id ? "text-teal-500" : "text-[var(--text-primary)]"}`}
                      >
                        {r.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div>
            <label className={labelClass}>Motivo (obrigatório)</label>
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: prova no processo nº 123/2026" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>Cancelar</Button>
            <Button variant="primary" size="sm" onClick={submit} disabled={saving || !reason.trim() || (resourceType === "folder" ? !folderId : !documentId)}>{saving ? "Criando…" : "Bloquear"}</Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="h-12 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />
      ) : holds.length === 0 ? (
        <p className="text-mac-caption text-[var(--text-tertiary)]">Nenhum hold ativo.</p>
      ) : (
        <ul className="border border-[var(--border-default)] rounded-[var(--radius-control)] divide-y divide-[var(--border-default)] overflow-hidden">
          {holds.map((h) => (
            <li key={h.id} className="flex items-center gap-3 px-4 py-2.5">
              <Lock className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-mac-body text-[var(--text-primary)] truncate">{h.reason}</p>
                <p className="text-mac-caption text-[var(--text-tertiary)]">{h.resource_type === "folder" ? "Pasta" : "Documento"} · criado em {new Date(h.created_at).toLocaleDateString("pt-BR")}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => onRelease(h)}>
                <Unlock className="w-3.5 h-3.5" /> Liberar
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
