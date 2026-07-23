import { useEffect, useState } from "react";
import { Plus, X, FileText, Link2, Trash2, ShieldQuestion, GitBranch, Lock } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { relativeDate } from "@/lib/date";
import EmptyState from "@/components/shared/EmptyState";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import Portal from "@/components/ui/Portal";
import Dropdown from "@/components/ui/Dropdown";

// Fase 4.1 — Modelo de Obrigações (Obrigação → Documento comprobatório).
// Regras condicionais (4.2), matriz 2D (4.4) e Self-Service Collect (4.6)
// ficam para fatias seguintes; esta tela cobre só o CRUD do modelo base e a
// vinculação manual de documento comprobatório.

interface Template {
  id: string;
  name: string;
  description: string | null;
  frequency: string;
  criticality: string;
  department: string | null;
  sla_days: number;
  weight: number;
  validity_months: number | null;
  active: boolean;
}

interface Instance {
  id: string;
  template_id: string;
  template_name: string;
  criticality: string;
  department: string | null;
  period: string;
  due_date: string;
  effective_status: string;
  status: string;
  dispensa_motivo: string | null;
  document_count: number;
  blocking_templates: string[] | null;
  document_expires_at: string | null;
}

interface Dependency {
  id: string;
  template_id: string;
  template_name: string;
  depends_on_template_id: string;
  depends_on_name: string;
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendente",
  at_risk: "Vencendo",
  overdue: "Atrasada",
  blocked: "Bloqueada",
  expired: "Expirada",
  reviewing: "Em revisão",
  approved: "Aprovada",
  dispensado: "Dispensada",
  cancelado: "Cancelada",
};

const STATUS_VARIANT: Record<string, "default" | "success" | "error" | "warning" | "info" | "teal"> = {
  pending: "default",
  at_risk: "warning",
  overdue: "error",
  blocked: "info",
  expired: "error",
  reviewing: "info",
  approved: "success",
  dispensado: "default",
  cancelado: "default",
};

const FREQ_LABEL: Record<string, string> = { mensal: "Mensal", anual: "Anual", unica: "Única", evento: "Por evento" };

function StatusBadge({ status }: { status: string }) {
  return <Badge variant={STATUS_VARIANT[status] ?? "default"}>{STATUS_LABEL[status] ?? status}</Badge>;
}

export default function Obligations() {
  usePageTitle("Obrigações");
  const { current } = useCompany();
  const { success, error: showError } = useToast();
  const isAdmin = current?.permission_level === "admin" || current?.permission_level === "supremo";

  const [templates, setTemplates] = useState<Template[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showInstanceModal, setShowInstanceModal] = useState<Template | null>(null);
  const [linkingInstance, setLinkingInstance] = useState<Instance | null>(null);
  const [showDependencyModal, setShowDependencyModal] = useState(false);

  function load() {
    if (!current) return;
    setLoading(true);
    Promise.all([
      api.get<Template[]>("/companies/" + current.id + "/obligations/templates"),
      api.get<Instance[]>("/companies/" + current.id + "/obligations/instances", {
        params: statusFilter ? { status: statusFilter } : {},
      }),
      api.get<Dependency[]>("/companies/" + current.id + "/obligations/dependencies"),
    ])
      .then(([t, i, d]) => {
        setTemplates(Array.isArray(t.data) ? t.data : []);
        setInstances(Array.isArray(i.data) ? i.data : []);
        setDependencies(Array.isArray(d.data) ? d.data : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  async function removeDependency(dep: Dependency) {
    try {
      await api.delete(`/obligations/dependencies/${dep.id}`, { params: { company_id: current!.id } });
      success("Dependência removida.");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível remover a dependência.");
    }
  }

  useEffect(load, [current?.id, statusFilter]);

  async function dispense(instance: Instance) {
    const motivo = window.prompt("Motivo da dispensa (obrigatório):");
    if (!motivo) return;
    try {
      await api.patch(`/obligations/instances/${instance.id}/status`, { status: "dispensado", dispensa_motivo: motivo });
      success("Obrigação dispensada.");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível dispensar.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-mac-title2 font-semibold text-[var(--text-primary)]">Obrigações</h1>
          <p className="text-mac-caption text-[var(--text-secondary)] mt-1">
            Cada obrigação pode ser satisfeita por documentos diferentes — o que importa é comprovar, não um arquivo específico.
          </p>
        </div>
        {isAdmin && (
          <Button variant="primary" onClick={() => setShowTemplateModal(true)}>
            <Plus className="w-4 h-4" /> Novo modelo
          </Button>
        )}
      </div>

      {/* Modelos */}
      <section className="space-y-2">
        <h2 className="text-mac-callout font-semibold text-[var(--text-primary)]">Modelos</h2>
        {templates.length === 0 ? (
          <p className="text-mac-caption text-[var(--text-tertiary)]">Nenhum modelo de obrigação cadastrado ainda.</p>
        ) : (
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
            <ul>
              {templates.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border-default)] last:border-0">
                  <ShieldQuestion className="w-4 h-4 text-teal-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-mac-body text-[var(--text-primary)] truncate">{t.name}</div>
                    <div className="text-mac-caption text-[var(--text-tertiary)]">
                      {FREQ_LABEL[t.frequency] ?? t.frequency}
                      {t.department ? ` · ${t.department}` : ""}
                      {t.sla_days > 0 ? ` · alerta ${t.sla_days}d antes do prazo` : ""}
                      {t.validity_months ? ` · documento vale ${t.validity_months} ${t.validity_months === 1 ? "mês" : "meses"}` : ""}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setShowInstanceModal(t)}>
                    <Plus className="w-3.5 h-3.5" /> Gerar instância
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Dependências */}
      {templates.length >= 2 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-mac-callout font-semibold text-[var(--text-primary)]">Dependências</h2>
            {isAdmin && (
              <Button variant="ghost" size="sm" onClick={() => setShowDependencyModal(true)}>
                <GitBranch className="w-3.5 h-3.5" /> Nova dependência
              </Button>
            )}
          </div>
          {dependencies.length === 0 ? (
            <p className="text-mac-caption text-[var(--text-tertiary)]">
              Nenhuma dependência cadastrada — nenhum modelo está condicionado à conclusão de outro.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {dependencies.map((d) => (
                <li key={d.id} className="flex items-center gap-2 text-mac-caption text-[var(--text-secondary)]">
                  <GitBranch className="w-3.5 h-3.5 text-teal-500 flex-shrink-0" />
                  <span>
                    <strong className="text-[var(--text-primary)]">{d.template_name}</strong> só fica ativa depois de{" "}
                    <strong className="text-[var(--text-primary)]">{d.depends_on_name}</strong> ser aprovada no mesmo período
                  </span>
                  {isAdmin && (
                    <button onClick={() => removeDependency(d)} className="p-1 rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]" title="Remover dependência">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Instâncias */}
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-mac-callout font-semibold text-[var(--text-primary)]">Instâncias</h2>
          <div className="w-48">
            <Dropdown
              value={statusFilter}
              onChange={setStatusFilter}
              placeholder="Todos os status"
              options={[
                { value: "", label: "Todos os status" },
                ...Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })),
              ]}
            />
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
            ))}
          </div>
        ) : instances.length === 0 ? (
          <EmptyState
            title="Nenhuma instância encontrada"
            description="Gere uma instância a partir de um modelo acima para começar a acompanhar o prazo."
            icon={<ShieldQuestion className="w-6 h-6" />}
          />
        ) : (
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
            <ul>
              {instances.map((inst) => (
                <li key={inst.id} className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border-default)] last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="text-mac-body text-[var(--text-primary)] truncate">{inst.template_name} · {inst.period}</div>
                    <div className="text-mac-caption text-[var(--text-tertiary)]">
                      {inst.effective_status === "blocked" ? (
                        <span className="inline-flex items-center gap-1">
                          <Lock className="w-3 h-3" /> Aguardando: {inst.blocking_templates?.join(", ")}
                        </span>
                      ) : inst.effective_status === "expired" ? (
                        <span>O documento vinculado venceu {relativeDate(inst.document_expires_at!)} — precisa de um documento atualizado.</span>
                      ) : (
                        <>
                          Prazo {relativeDate(inst.due_date)}
                          {inst.document_count > 0 ? ` · ${inst.document_count} documento(s) vinculado(s)` : " · sem documento vinculado"}
                          {inst.effective_status === "approved" && inst.document_expires_at ? ` · válido até ${new Date(inst.document_expires_at + "T00:00:00").toLocaleDateString("pt-BR")}` : ""}
                          {inst.dispensa_motivo ? ` · Dispensada: ${inst.dispensa_motivo}` : ""}
                        </>
                      )}
                    </div>
                  </div>
                  <StatusBadge status={inst.effective_status} />
                  {inst.effective_status !== "dispensado" && inst.effective_status !== "cancelado" && inst.effective_status !== "blocked" && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setLinkingInstance(inst)}>
                        <Link2 className="w-3.5 h-3.5" /> Vincular documento
                      </Button>
                      {isAdmin && (
                        <Button variant="ghost" size="sm" onClick={() => dispense(inst)}>
                          Dispensar
                        </Button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {showTemplateModal && (
        <TemplateModal companyId={current!.id} onClose={() => setShowTemplateModal(false)} onCreated={() => { setShowTemplateModal(false); load(); }} />
      )}
      {showInstanceModal && (
        <InstanceModal companyId={current!.id} template={showInstanceModal} onClose={() => setShowInstanceModal(null)} onCreated={() => { setShowInstanceModal(null); load(); }} />
      )}
      {linkingInstance && (
        <LinkDocumentModal companyId={current!.id} instance={linkingInstance} onClose={() => setLinkingInstance(null)} onLinked={() => { setLinkingInstance(null); load(); }} />
      )}
      {showDependencyModal && (
        <DependencyModal companyId={current!.id} templates={templates} onClose={() => setShowDependencyModal(false)} onCreated={() => { setShowDependencyModal(false); load(); }} />
      )}
    </div>
  );
}

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <Portal>
      <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[480px] max-h-[85vh] overflow-y-auto">
          <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
            <h2 className="text-mac-body font-semibold text-[var(--text-primary)] truncate">{title}</h2>
            <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] flex-shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-5 space-y-4">{children}</div>
        </div>
      </div>
    </Portal>
  );
}

const inputClass = "w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70";
const labelClass = "block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5";

function TemplateModal({ companyId, onClose, onCreated }: { companyId: string; onClose: () => void; onCreated: () => void }) {
  const { success, error: showError } = useToast();
  const [name, setName] = useState("");
  const [department, setDepartment] = useState("");
  const [frequency, setFrequency] = useState("mensal");
  const [criticality, setCriticality] = useState("media");
  const [slaDays, setSlaDays] = useState(7);
  const [validityMonths, setValidityMonths] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/obligations/templates`, {
        company_id: companyId, name: name.trim(), department: department.trim() || null,
        frequency, criticality, sla_days: slaDays,
        validity_months: validityMonths.trim() ? Number(validityMonths) : null,
      });
      success("Modelo de obrigação criado.");
      onCreated();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar o modelo.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title="Novo modelo de obrigação" onClose={onClose}>
      <div>
        <label className={labelClass}>Nome</label>
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: DARF mensal" autoFocus />
      </div>
      <div>
        <label className={labelClass}>Departamento (opcional)</label>
        <input className={inputClass} value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="Ex.: Fiscal" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>Frequência</label>
          <Dropdown value={frequency} onChange={setFrequency} placeholder="Frequência" options={Object.entries(FREQ_LABEL).map(([value, label]) => ({ value, label }))} />
        </div>
        <div>
          <label className={labelClass}>Criticidade</label>
          <Dropdown value={criticality} onChange={setCriticality} placeholder="Criticidade" options={[
            { value: "baixa", label: "Baixa" }, { value: "media", label: "Média" },
            { value: "alta", label: "Alta" }, { value: "critica", label: "Crítica" },
          ]} />
        </div>
      </div>
      <div>
        <label className={labelClass}>Avisar quantos dias antes do prazo</label>
        <input type="number" min={0} className={inputClass} value={slaDays} onChange={(e) => setSlaDays(Number(e.target.value))} />
      </div>
      <div>
        <label className={labelClass}>Validade do documento em meses (opcional)</label>
        <input
          type="number" min={1} className={inputClass} value={validityMonths}
          onChange={(e) => setValidityMonths(e.target.value)}
          placeholder="Deixe em branco se o documento não expira sozinho"
        />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={submit} disabled={saving || !name.trim()}>{saving ? "Criando…" : "Criar modelo"}</Button>
      </div>
    </ModalShell>
  );
}

function InstanceModal({ companyId, template, onClose, onCreated }: { companyId: string; template: Template; onClose: () => void; onCreated: () => void }) {
  const { success, error: showError } = useToast();
  const now = new Date();
  const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const [dueDate, setDueDate] = useState(() => {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return d.toISOString().slice(0, 10);
  });
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!period.trim() || !dueDate) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/obligations/instances`, {
        template_id: template.id, period: period.trim(), due_date: dueDate,
      });
      success("Instância gerada.");
      onCreated();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível gerar a instância.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell title={`Gerar instância — ${template.name}`} onClose={onClose}>
      <div>
        <label className={labelClass}>Período</label>
        <input className={inputClass} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Ex.: 2026-07" autoFocus />
      </div>
      <div>
        <label className={labelClass}>Prazo</label>
        <input type="date" className={inputClass} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={submit} disabled={saving || !period.trim() || !dueDate}>{saving ? "Gerando…" : "Gerar"}</Button>
      </div>
    </ModalShell>
  );
}

function LinkDocumentModal({ companyId, instance, onClose, onLinked }: { companyId: string; instance: Instance; onClose: () => void; onLinked: () => void }) {
  const { success, error: showError } = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; name: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const handle = setTimeout(() => {
      setSearching(true);
      api.get("/search", { params: { q: query.trim(), company_id: companyId, page_size: 8 } })
        .then((r) => setResults(Array.isArray(r.data?.results) ? r.data.results : []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(handle);
  }, [query, companyId]);

  async function link(documentId: string) {
    setLinkingId(documentId);
    try {
      await api.post(`/obligations/instances/${instance.id}/documents`, { document_id: documentId });
      success("Documento vinculado — a obrigação foi marcada como aprovada.");
      onLinked();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível vincular o documento.");
    } finally {
      setLinkingId(null);
    }
  }

  return (
    <ModalShell title={`Vincular documento — ${instance.template_name}`} onClose={onClose}>
      <div>
        <label className={labelClass}>Buscar documento</label>
        <input className={inputClass} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Digite o nome do documento…" autoFocus />
      </div>
      {searching && <p className="text-mac-caption text-[var(--text-tertiary)]">Buscando…</p>}
      {results.length > 0 && (
        <ul className="border border-[var(--border-default)] rounded-[var(--radius-control)] overflow-hidden divide-y divide-[var(--border-default)]">
          {results.map((r) => (
            <li key={r.id} className="flex items-center gap-2 px-3 py-2">
              <FileText className="w-3.5 h-3.5 text-[var(--text-tertiary)] flex-shrink-0" />
              <span className="flex-1 min-w-0 text-mac-body text-[var(--text-primary)] truncate">{r.name}</span>
              <Button variant="ghost" size="sm" onClick={() => link(r.id)} disabled={linkingId === r.id}>
                {linkingId === r.id ? "Vinculando…" : "Vincular"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {instance.document_count > 0 && (
        <p className="text-mac-caption text-[var(--text-tertiary)] flex items-center gap-1.5">
          <Trash2 className="w-3 h-3" /> Documentos já vinculados podem ser removidos na aba Atividade do documento.
        </p>
      )}
    </ModalShell>
  );
}

function DependencyModal({ companyId, templates, onClose, onCreated }: { companyId: string; templates: Template[]; onClose: () => void; onCreated: () => void }) {
  const { success, error: showError } = useToast();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [dependsOnId, setDependsOnId] = useState(templates[1]?.id ?? "");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!templateId || !dependsOnId || templateId === dependsOnId) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/obligations/dependencies`, { template_id: templateId, depends_on_template_id: dependsOnId });
      success("Dependência criada.");
      onCreated();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar a dependência.");
    } finally {
      setSaving(false);
    }
  }

  const options = templates.map((t) => ({ value: t.id, label: t.name }));

  return (
    <ModalShell title="Nova dependência" onClose={onClose}>
      <p className="text-mac-caption text-[var(--text-secondary)]">
        A obrigação abaixo só fica ativa depois que a segunda for aprovada no mesmo período — evita cobrar algo que ainda não faz sentido cobrar.
      </p>
      <div>
        <label className={labelClass}>Obrigação (fica bloqueada)</label>
        <Dropdown value={templateId} onChange={setTemplateId} placeholder="Escolha a obrigação" options={options} />
      </div>
      <div>
        <label className={labelClass}>Depende de</label>
        <Dropdown value={dependsOnId} onChange={setDependsOnId} placeholder="Escolha o pré-requisito" options={options.filter((o) => o.value !== templateId)} />
      </div>
      {templateId === dependsOnId && templateId !== "" && (
        <p className="text-mac-caption text-red-500">Uma obrigação não pode depender de si mesma.</p>
      )}
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" onClick={submit} disabled={saving || !templateId || !dependsOnId || templateId === dependsOnId}>
          {saving ? "Criando…" : "Criar dependência"}
        </Button>
      </div>
    </ModalShell>
  );
}
