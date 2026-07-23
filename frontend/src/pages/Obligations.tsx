import { useEffect, useMemo, useState } from "react";
import { Plus, X, FileText, Link2, Trash2, ShieldQuestion, GitBranch, Lock, List, LayoutGrid } from "lucide-react";
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
  // Sempre TODAS as instâncias, sem filtro de status — a Central de
  // Conformidade e a Matriz precisam ver o conjunto inteiro pra calcular
  // porcentagens e desenhar todas as colunas/linhas; o filtro de status da
  // visão em Lista é aplicado no cliente (filteredInstances), não no fetch.
  const [allInstances, setAllInstances] = useState<Instance[]>([]);
  const [dependencies, setDependencies] = useState<Dependency[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [showInstanceModal, setShowInstanceModal] = useState<Template | null>(null);
  const [linkingInstance, setLinkingInstance] = useState<Instance | null>(null);
  const [showDependencyModal, setShowDependencyModal] = useState(false);
  const [view, setView] = useState<"list" | "matrix">("list");
  const [matrixInstanceModal, setMatrixInstanceModal] = useState<{ template: Template; period: string } | null>(null);

  const filteredInstances = useMemo(
    () => (statusFilter ? allInstances.filter((i) => i.effective_status === statusFilter) : allInstances),
    [allInstances, statusFilter]
  );

  function load() {
    if (!current) return;
    setLoading(true);
    Promise.all([
      api.get<Template[]>("/companies/" + current.id + "/obligations/templates"),
      api.get<Instance[]>("/companies/" + current.id + "/obligations/instances"),
      api.get<Dependency[]>("/companies/" + current.id + "/obligations/dependencies"),
    ])
      .then(([t, i, d]) => {
        setTemplates(Array.isArray(t.data) ? t.data : []);
        setAllInstances(Array.isArray(i.data) ? i.data : []);
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

  useEffect(load, [current?.id]);

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

      {/* Central de Conformidade (Fase 4.7) */}
      {allInstances.length > 0 && (
        <ComplianceCenter
          instances={allInstances}
          onFilter={(status) => { setStatusFilter(status); setView("list"); }}
        />
      )}

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
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 p-0.5 bg-[var(--bg-hover)] rounded-[var(--radius-control)]">
              <button
                onClick={() => setView("list")}
                className={`p-1.5 rounded-[6px] transition-colors duration-fast ${view === "list" ? "bg-[var(--bg-card)] text-teal-500" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"}`}
                title="Lista"
              >
                <List className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setView("matrix")}
                className={`p-1.5 rounded-[6px] transition-colors duration-fast ${view === "matrix" ? "bg-[var(--bg-card)] text-teal-500" : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"}`}
                title="Matriz de completude"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
            </div>
            {view === "list" && (
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
            )}
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
            ))}
          </div>
        ) : allInstances.length === 0 ? (
          <EmptyState
            title="Nenhuma instância encontrada"
            description="Gere uma instância a partir de um modelo acima para começar a acompanhar o prazo."
            icon={<ShieldQuestion className="w-6 h-6" />}
          />
        ) : view === "matrix" ? (
          <CompletionMatrix
            templates={templates}
            instances={allInstances}
            onCellClick={(inst) => setLinkingInstance(inst)}
            onEmptyCellClick={(template, period) => setMatrixInstanceModal({ template, period })}
          />
        ) : filteredInstances.length === 0 ? (
          <p className="text-mac-caption text-[var(--text-tertiary)] px-1">Nenhuma instância com esse status.</p>
        ) : (
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
            <ul>
              {filteredInstances.map((inst) => (
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
      {matrixInstanceModal && (
        <InstanceModal
          companyId={current!.id} template={matrixInstanceModal.template} defaultPeriod={matrixInstanceModal.period}
          onClose={() => setMatrixInstanceModal(null)} onCreated={() => { setMatrixInstanceModal(null); load(); }}
        />
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

// Fase 4.4 — Matriz 2D de completude (linhas = período, colunas = tipo de
// obrigação). Reaproveita os dados já carregados de templates/instâncias —
// nenhum endpoint novo. Pílula colorida = status; célula tracejada = ainda
// sem instância gerada nesse período (clicável, abre o modal de geração já
// com o período preenchido).
const MATRIX_PILL: Record<string, string> = {
  approved: "bg-emerald-500",
  at_risk: "bg-amber-400",
  expired: "bg-amber-400",
  overdue: "bg-red-500",
  blocked: "bg-blue-400",
  reviewing: "bg-blue-400",
  pending: "bg-[var(--bg-hover)] border border-[var(--border-default)]",
  dispensado: "bg-[var(--bg-hover)] border border-[var(--border-default)]",
  cancelado: "bg-[var(--bg-hover)] border border-[var(--border-default)]",
};

function CompletionMatrix({
  templates, instances, onCellClick, onEmptyCellClick,
}: {
  templates: Template[]; instances: Instance[];
  onCellClick: (inst: Instance) => void; onEmptyCellClick: (template: Template, period: string) => void;
}) {
  const activeTemplates = useMemo(() => templates.filter((t) => t.active), [templates]);
  const periods = useMemo(() => Array.from(new Set(instances.map((i) => i.period))).sort(), [instances]);
  const byKey = useMemo(() => {
    const map = new Map<string, Instance>();
    instances.forEach((i) => map.set(`${i.template_id}|${i.period}`, i));
    return map;
  }, [instances]);

  if (periods.length === 0 || activeTemplates.length === 0) {
    return <p className="text-mac-caption text-[var(--text-tertiary)]">Sem dados suficientes para montar a matriz ainda.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="text-left px-4 py-2.5 text-mac-caption font-medium text-[var(--text-secondary)] sticky left-0 bg-[var(--bg-card)] whitespace-nowrap">Período</th>
              {activeTemplates.map((t) => (
                <th key={t.id} className="px-3 py-2.5 text-mac-caption font-medium text-[var(--text-secondary)] whitespace-nowrap text-center">{t.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((period) => (
              <tr key={period} className="border-t border-[var(--border-default)]">
                <td className="px-4 py-2.5 text-mac-caption text-[var(--text-primary)] font-medium sticky left-0 bg-[var(--bg-card)] whitespace-nowrap">{period}</td>
                {activeTemplates.map((t) => {
                  const inst = byKey.get(`${t.id}|${period}`);
                  return (
                    <td key={t.id} className="px-3 py-2.5 text-center">
                      {inst ? (
                        <button
                          onClick={() => onCellClick(inst)}
                          title={`${t.name} · ${period} — ${STATUS_LABEL[inst.effective_status] ?? inst.effective_status}`}
                          className={`w-4 h-4 rounded-full inline-block hover:ring-2 hover:ring-teal-400/50 transition-all duration-fast ${MATRIX_PILL[inst.effective_status] ?? "bg-[var(--bg-hover)]"}`}
                        />
                      ) : (
                        <button
                          onClick={() => onEmptyCellClick(t, period)}
                          title={`Gerar instância de ${t.name} para ${period}`}
                          className="w-4 h-4 rounded-full inline-block border border-dashed border-[var(--border-default)] hover:border-teal-400 transition-colors duration-fast"
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-4 flex-wrap text-mac-caption text-[var(--text-tertiary)]">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" /> Aprovada</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" /> Vencendo/Expirada</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" /> Atrasada</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400 inline-block" /> Bloqueada/Em revisão</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-[var(--bg-hover)] border border-[var(--border-default)] inline-block" /> Pendente/Dispensada</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full border border-dashed border-[var(--border-default)] inline-block" /> Sem instância</span>
      </div>
    </div>
  );
}

// Fase 4.7 — Central de Conformidade: não mostra documentos, mostra as
// perguntas que o gestor realmente faz. Cada card é clicável e abre a lista
// já filtrada — nenhum número aqui é um beco sem saída (mesma regra dos
// KPIs do dashboard, Fase 3). Tudo calculado a partir de allInstances, já
// carregado pela tela — sem endpoint novo.
function ComplianceCenter({ instances, onFilter }: { instances: Instance[]; onFilter: (status: string) => void }) {
  const relevant = instances.filter((i) => i.effective_status !== "dispensado" && i.effective_status !== "cancelado");
  const approved = relevant.filter((i) => i.effective_status === "approved").length;
  const pct = relevant.length > 0 ? Math.round((approved / relevant.length) * 100) : null;

  const atRisk = instances.filter((i) => i.effective_status === "at_risk").length;
  const overdue = instances.filter((i) => i.effective_status === "overdue").length;
  const blocked = instances.filter((i) => i.effective_status === "blocked").length;
  const expired = instances.filter((i) => i.effective_status === "expired").length;
  const criticalPending = instances.filter(
    (i) => i.criticality === "critica" && !["approved", "dispensado", "cancelado"].includes(i.effective_status)
  ).length;

  const byDept = new Map<string, number>();
  instances
    .filter((i) => !["approved", "dispensado", "cancelado"].includes(i.effective_status))
    .forEach((i) => {
      const key = i.department?.trim() || "Sem departamento";
      byDept.set(key, (byDept.get(key) ?? 0) + 1);
    });
  const deptEntries = Array.from(byDept.entries()).sort((a, b) => b[1] - a[1]);

  const cards: { label: string; value: string; hint?: string; onClick?: () => void; tone: "default" | "warning" | "error" | "info" }[] = [
    { label: "Conformidade geral", value: pct !== null ? `${pct}%` : "—", hint: `${approved} de ${relevant.length} obrigações`, tone: "default" },
    { label: "Críticas pendentes", value: String(criticalPending), tone: criticalPending > 0 ? "error" : "default" },
    { label: "Vencendo em breve", value: String(atRisk), onClick: atRisk > 0 ? () => onFilter("at_risk") : undefined, tone: "warning" },
    { label: "Atrasadas", value: String(overdue), onClick: overdue > 0 ? () => onFilter("overdue") : undefined, tone: "error" },
    { label: "Bloqueadas", value: String(blocked), onClick: blocked > 0 ? () => onFilter("blocked") : undefined, tone: "info" },
    { label: "Expiradas", value: String(expired), onClick: expired > 0 ? () => onFilter("expired") : undefined, tone: "error" },
  ];

  const toneClass: Record<string, string> = {
    default: "text-[var(--text-primary)]",
    warning: "text-amber-500",
    error: "text-red-500",
    info: "text-blue-500",
  };

  return (
    <section className="space-y-3">
      <h2 className="text-mac-callout font-semibold text-[var(--text-primary)]">Central de Conformidade</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {cards.map((c) => (
          <button
            key={c.label}
            onClick={c.onClick}
            disabled={!c.onClick}
            className={`glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-4 text-left transition-transform duration-fast ${c.onClick ? "hover:scale-[1.02] cursor-pointer" : "cursor-default"}`}
          >
            <div className={`text-mac-title2 font-semibold ${toneClass[c.tone]}`}>{c.value}</div>
            <div className="text-mac-caption text-[var(--text-secondary)] mt-1">{c.label}</div>
            {c.hint && <div className="text-mac-caption2 text-[var(--text-tertiary)] mt-0.5">{c.hint}</div>}
          </button>
        ))}
      </div>
      {deptEntries.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap text-mac-caption text-[var(--text-secondary)]">
          <span className="text-[var(--text-tertiary)]">Pendências por departamento:</span>
          {deptEntries.map(([dept, count]) => (
            <span key={dept}>{dept} <strong className="text-[var(--text-primary)]">{count}</strong></span>
          ))}
        </div>
      )}
    </section>
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

function InstanceModal({ companyId, template, defaultPeriod, onClose, onCreated }: { companyId: string; template: Template; defaultPeriod?: string; onClose: () => void; onCreated: () => void }) {
  const { success, error: showError } = useToast();
  const now = new Date();
  const [period, setPeriod] = useState(defaultPeriod ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
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
