import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Plus, Sparkles, AlertTriangle, RefreshCw, ShieldCheck, Pencil, Archive, ArchiveRestore, Pause, Play, GitBranch, Trash2,
  ChevronRight, CalendarPlus, User, CalendarDays, FileSpreadsheet,
} from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import ConformityMatrix from "@/components/obligations/ConformityMatrix";
import AsoMatrix from "@/components/obligations/AsoMatrix";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Dropdown from "@/components/ui/Dropdown";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Input from "@/components/ui/Input";
import EmptyState from "@/components/shared/EmptyState";
import InstanceDialog from "@/components/obligations/InstanceDialog";
import TemplateDialog from "@/components/obligations/TemplateDialog";
import CatalogDialog from "@/components/obligations/CatalogDialog";
import {
  type Template, type Instance, type Dependency, type Member,
  STATUS, StatusChip, URGENCY, OPEN_STATUSES, CRIT_LABEL, MESES, dueText, scheduleText, friendly,
} from "@/components/obligations/shared";
import { PageHeader, ToolbarGroup, ToolbarButton } from "@/components/layout/window";

type Tab = "pendencias" | "calendario" | "configuracao" | "matriz" | "aso";
type Load<T> = { state: "loading" | "ok" | "error"; data: T };

const GROUPS: { id: string; title: string; statuses: string[] }[] = [
  { id: "atrasadas", title: "Atrasadas", statuses: ["overdue"] },
  { id: "vencidas", title: "Documento vencido", statuses: ["expired"] },
  { id: "breve", title: "Vencem em breve", statuses: ["at_risk"] },
  { id: "conferir", title: "Esperando conferência", statuses: ["reviewing"] },
  { id: "afazer", title: "A fazer", statuses: ["pending"] },
  { id: "aguardando", title: "Aguardando outra obrigação", statuses: ["blocked"] },
  { id: "cumpridas", title: "Cumpridas", statuses: ["approved"] },
  { id: "fechadas", title: "Dispensadas, canceladas e que não se aplicam", statuses: ["dispensado", "cancelado", "not_applicable"] },
];

const FILTERS: { value: string; label: string }[] = [
  { value: "abertas", label: "Tudo que está aberto" },
  { value: "overdue", label: "Atrasadas" },
  { value: "expired", label: "Documento vencido" },
  { value: "at_risk", label: "Vencem em breve" },
  { value: "reviewing", label: "Esperando conferência" },
  { value: "pending", label: "A fazer" },
  { value: "blocked", label: "Aguardando outra" },
  { value: "approved", label: "Cumpridas" },
  { value: "sem_responsavel", label: "Sem responsável" },
  { value: "criticas", label: "Críticas pendentes" },
  { value: "todas", label: "Todas, inclusive fechadas" },
];

// Cache entre visitas (A7-18): ao voltar para Obrigações, a última lista
// aparece na hora e é atualizada por trás, sem esqueleto.
const cacheInstancias = new Map<string, Instance[]>();
const cacheModelos = new Map<string, Template[]>();

export default function Obligations() {
  const { success: exportToast, error: exportErro } = useToast();
  usePageTitle("Obrigações");
  const { current, companies } = useCompany();
  const { user } = useAuthContext();
  const [params, setParams] = useSearchParams();
  const uid = useId();

  const tab = (["pendencias", "calendario", "configuracao", "matriz", "aso"].includes(params.get("aba") ?? "") ? params.get("aba") : "pendencias") as Tab;
  const grupo = params.get("escopo") === "grupo" && companies.length > 1;
  const mine = params.get("minhas") === "1";
  const prazo = params.get("prazo");
  const filtro = params.get("status") ?? (prazo === "vencidas" ? "overdue" : "abertas");
  const dept = params.get("depto") ?? "";
  const empresaFiltro = params.get("empresa") ?? "";
  const aberta = params.get("instancia");

  const setParam = useCallback((changes: Record<string, string | null>) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(changes)) { if (v === null || v === "") n.delete(k); else n.set(k, v); }
      return n;
    }, { replace: true });
  }, [setParams]);

  const perm = (companyId: string) => companies.find((c) => c.id === companyId)?.permission_level ?? current?.permission_level;
  const isAdminOf = (companyId: string) => ["admin", "supremo"].includes(perm(companyId) ?? "");
  const canOperateIn = (companyId: string) => ["admin", "operador", "supremo"].includes(perm(companyId) ?? "");
  const isAdmin = current ? isAdminOf(current.id) : false;

  const chaveInst = `${current?.id}:${grupo}:${mine}:${filtro === "todas"}`;
  const [instances, setInstances] = useState<Load<Instance[]>>(() => {
    const c = cacheInstancias.get(chaveInst);
    return c ? { state: "ok", data: c } : { state: "loading", data: [] };
  });
  const [empresas, setEmpresas] = useState<{ company_id: string; name: string; overdue: number; expired: number; at_risk: number; reviewing: number; approved: number; relevant: number }[]>([]);
  const [templates, setTemplates] = useState<Load<Template[]>>(() => {
    const c = current ? cacheModelos.get(current.id) : undefined;
    return c ? { state: "ok", data: c } : { state: "loading", data: [] };
  });
  const [deps, setDeps] = useState<Dependency[]>([]);
  const [members, setMembers] = useState<Member[]>([]);

  const loadInstances = useCallback(() => {
    if (!current) return;
    setInstances((s) => ({ ...s, state: s.data.length ? "ok" : "loading" }));
    const req = grupo
      ? api.get("/obligations/group", { params: { mine: mine || undefined } }).then((r) => { setEmpresas(r.data.empresas ?? []); return r.data.instancias as Instance[]; })
      : api.get<Instance[]>(`/companies/${current.id}/obligations/instances`, { params: { mine: mine || undefined, history: filtro === "todas" || undefined } }).then((r) => r.data);
    // Avisa a navegação para atualizar o contador de obrigações (A2-13).
    req.then((data) => {
      const lista = Array.isArray(data) ? data : [];
      cacheInstancias.set(chaveInst, lista);
      setInstances({ state: "ok", data: lista });
      window.dispatchEvent(new Event("docke:obrigacoes"));
    })
      .catch(() => setInstances((s) => ({ ...s, state: "error" })));
  }, [current?.id, grupo, mine, filtro === "todas"]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadConfig = useCallback(() => {
    if (!current) return;
    setTemplates((s) => ({ ...s, state: s.data.length ? "ok" : "loading" }));
    api.get<Template[]>(`/companies/${current.id}/obligations/templates`, { params: { include_archived: true } })
      .then((r) => { const l = Array.isArray(r.data) ? r.data : []; cacheModelos.set(current.id, l); setTemplates({ state: "ok", data: l }); })
      .catch(() => setTemplates((s) => ({ ...s, state: "error" })));
    api.get<Dependency[]>(`/companies/${current.id}/obligations/dependencies`).then((r) => setDeps(r.data ?? [])).catch(() => setDeps([]));
    api.get<Member[]>(`/companies/${current.id}/members`).then((r) => setMembers(r.data ?? [])).catch(() => setMembers([]));
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(loadInstances, [loadInstances]);
  useEffect(loadConfig, [loadConfig]);

  // Atualiza só a linha que mudou, sem recarregar a página (A7-13).
  function patchInstance(inst: Instance) {
    setInstances((s) => ({ ...s, data: s.data.map((i) => (i.id === inst.id ? { ...i, ...inst } : i)) }));
  }

  const activeTemplates = templates.data.filter((t) => !t.archived_at);
  const departments = useMemo(() => [...new Set(instances.data.map((i) => i.department).filter(Boolean) as string[])].sort(), [instances.data]);

  const visible = useMemo(() => {
    let list = instances.data;
    if (empresaFiltro) list = list.filter((i) => i.company_id === empresaFiltro);
    if (dept) list = list.filter((i) => i.department === dept);
    if (prazo === "semana") {
      const lim = new Date(); lim.setDate(lim.getDate() + 7);
      list = list.filter((i) => OPEN_STATUSES.includes(i.effective_status) && new Date(`${i.due_date.slice(0, 10)}T12:00:00`) <= lim);
    }
    switch (filtro) {
      case "abertas": return list.filter((i) => OPEN_STATUSES.includes(i.effective_status));
      case "todas": return list;
      case "sem_responsavel": return list.filter((i) => !i.owner_id && OPEN_STATUSES.includes(i.effective_status));
      case "criticas": return list.filter((i) => i.criticality === "critica" && OPEN_STATUSES.includes(i.effective_status));
      default: return list.filter((i) => i.effective_status === filtro);
    }
  }, [instances.data, filtro, dept, prazo, empresaFiltro]);

  const [showTemplate, setShowTemplate] = useState<Template | "nova" | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const [newInstance, setNewInstance] = useState<{ template?: Template; period?: string } | null>(null);

  if (!current) return <EmptyState title="Nenhuma empresa selecionada" description="Escolha uma empresa no topo para ver as obrigações." />;

  const semModelos = templates.state === "ok" && activeTemplates.length === 0 && !grupo;

  async function exportar(formato: "ics" | "csv") {
    try {
      const r = await api.get("/obligations/calendar", { params: { formato, company_id: grupo ? undefined : current?.id }, responseType: "blob" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(r.data as Blob);
      a.download = `obrigacoes_${new Date().toISOString().slice(0, 10)}.${formato}`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      exportToast(formato === "ics" ? "Arquivo da agenda baixado: abra no Google Agenda, Outlook ou no celular. Cada obrigação avisa 3 dias antes." : "Planilha baixada.");
    } catch {
      exportErro("Não foi possível exportar agora. Tente de novo.");
    }
  }

  return (
    <div className="space-y-6 sm:space-y-6 max-w-[1440px] w-full mx-auto">
      <PageHeader title="Obrigações" subtitle={grupo ? `Todas as ${companies.length} empresas que você acessa` : current.name}>
        {/* Calendário e exportação (B3.5.10): as abertas para a agenda do celular ou planilha. */}
        <ToolbarGroup label="Exportar">
          <ToolbarButton inGroup label="Para a agenda (.ics)" onClick={() => exportar("ics")}><CalendarDays aria-hidden="true" /></ToolbarButton>
          <ToolbarButton inGroup label="Planilha (CSV)" onClick={() => exportar("csv")}><FileSpreadsheet aria-hidden="true" /></ToolbarButton>
        </ToolbarGroup>
        {isAdmin && !grupo && (
          <>
            <ToolbarButton showLabel label="Modelos prontos" onClick={() => setShowCatalog(true)}><Sparkles aria-hidden="true" /></ToolbarButton>
            <ToolbarButton prominent label="Nova obrigação" onClick={() => setShowTemplate("nova")}><Plus aria-hidden="true" /></ToolbarButton>
          </>
        )}
      </PageHeader>
      <p className="text-mac-footnote text-(--text-secondary) -mb-2">O que precisa ser comprovado, até quando e por quem.</p>

      {/* Abas e escopo */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Visões de obrigações" className="flex items-center gap-0.5 p-0.5 rounded-full bg-(--bg-hover)">
          {([["pendencias", "Pendências"], ["matriz", "Matriz"], ["calendario", "Calendário"], ["configuracao", "Cadastro"], ["aso", "Exames (ASO)"]] as const)
            .filter(([id]) => (grupo ? id === "pendencias" || id === "matriz" : id !== "matriz" && (id !== "aso" || isAdmin)))
            .map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} onClick={() => setParam({ aba: id === "pendencias" ? null : id })}
                className={`px-3 h-8 pointer-coarse:h-10 rounded-full text-mac-body font-medium transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${tab === id ? "bg-(--bg-card) text-(--text-primary) shadow-sm" : "text-(--text-secondary) hover:text-(--text-primary)"}`}>
                {label}
              </button>
            ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {companies.length > 1 && (
            <div role="group" aria-label="Escopo" className="flex items-center gap-0.5 p-0.5 rounded-full bg-(--bg-hover)">
              {([["empresa", "Esta empresa"], ["grupo", "Todas as empresas"]] as const).map(([v, label]) => (
                <button key={v} aria-pressed={(v === "grupo") === grupo}
                  onClick={() => setParam({ escopo: v === "grupo" ? "grupo" : null, aba: null, empresa: null })}
                  className={`px-3 h-8 pointer-coarse:h-10 rounded-full text-mac-body font-medium transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${(v === "grupo") === grupo ? "bg-(--bg-card) text-(--text-primary) shadow-sm" : "text-(--text-secondary) hover:text-(--text-primary)"}`}>
                  {label}
                </button>
              ))}
            </div>
          )}
          <button aria-pressed={mine} onClick={() => setParam({ minhas: mine ? null : "1" })}
            className={`inline-flex items-center gap-1.5 px-3 h-8 pointer-coarse:h-10 rounded-full border text-mac-body font-medium transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${mine ? "bg-teal-600 text-white border-teal-600" : "border-(--border-control) text-(--text-primary) hover:bg-(--bg-hover)"}`}>
            <User className="w-3.5 h-3.5" aria-hidden="true" /> Só as minhas
          </button>
        </div>
      </div>

      {/* Troca de aba com entrada suave (A7-22), em vez de corte seco. */}
      <div key={`aba-${tab}`} className="page-enter">
      {semModelos && tab !== "configuracao" ? (
        <div className="glass-panel glass-blur-card rounded-(--radius-panel)">
          <EmptyState
            title="Nenhuma obrigação cadastrada"
            description={isAdmin
              ? "Comece pelos modelos prontos (impostos, folha, certidões, alvarás e licenças de postos, restaurantes e hotéis) ou cadastre a sua."
              : "Quem administra a empresa cadastra as obrigações; depois elas aparecem aqui com prazo e responsável."}
            icon={<ShieldCheck className="w-6 h-6" />}
            action={isAdmin ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={() => setShowCatalog(true)}><Sparkles className="w-4 h-4" aria-hidden="true" /> Ver modelos prontos</Button>
                <Button variant="secondary" onClick={() => setShowTemplate("nova")}>Cadastrar do zero</Button>
              </div>
            ) : undefined}
          />
        </div>
      ) : tab === "matriz" && grupo ? (
        <ConformityMatrix />
      ) : tab === "aso" && !grupo && current && isAdmin ? (
        <AsoMatrix companyId={current.id} />
      ) : tab === "pendencias" ? (
        <>
          {instances.state === "error" ? (
            <LoadError what="as obrigações" onRetry={loadInstances} />
          ) : instances.state === "loading" ? (
            <div className="space-y-3" aria-label="Carregando">
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-[84px] rounded-(--radius-panel) bg-(--bg-hover) animate-pulse" />)}</div>
              {[0, 1, 2].map((i) => <div key={i} className="h-14 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}
            </div>
          ) : (
            <>
              <Compliance instances={empresaFiltro ? instances.data.filter((i) => i.company_id === empresaFiltro) : instances.data} filtro={filtro}
                onFilter={(f) => { setParam({ status: f === "abertas" ? null : f, prazo: null }); document.getElementById(`${uid}-lista`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }} />

              {grupo && empresas.length > 0 && (
                <section aria-labelledby={`${uid}-emp`} className="space-y-2">
                  <h2 id={`${uid}-emp`} className="text-mac-body font-semibold text-(--text-primary)">Por empresa</h2>
                  <ul className="flex flex-wrap gap-2">
                    {empresas.map((e) => {
                      const pct = e.relevant ? Math.round((e.approved / e.relevant) * 100) : null;
                      const on = empresaFiltro === e.company_id;
                      return (
                        <li key={e.company_id}>
                          <button aria-pressed={on} onClick={() => setParam({ empresa: on ? null : e.company_id })}
                            className={`text-left rounded-(--radius-control) border px-3 py-2 min-h-11 transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${on ? "border-teal-600 bg-(--tint-accent)" : "border-(--border-default) hover:bg-(--bg-hover)"}`}>
                            <span className="block text-mac-body font-medium text-(--text-primary)">{e.name}</span>
                            <span className="block text-mac-caption text-(--text-secondary)">
                              {e.overdue > 0 ? <span className="text-(--text-danger) font-medium">{e.overdue} atrasada{e.overdue > 1 ? "s" : ""}</span> : "nada atrasado"}
                              {e.expired > 0 && <> · <span className="text-(--text-danger)">{e.expired} documento{e.expired > 1 ? "s" : ""} vencido{e.expired > 1 ? "s" : ""}</span></>}
                              {pct !== null && ` · ${pct}% em dia`}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section aria-labelledby={`${uid}-lista`} className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id={`${uid}-lista`} className="text-mac-body font-semibold text-(--text-primary) scroll-mt-24">
                    {FILTERS.find((f) => f.value === filtro)?.label ?? "Obrigações"}{prazo === "semana" ? " · até daqui a 7 dias" : ""} <span className="font-normal text-(--text-secondary)">({visible.length})</span>
                  </h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="w-56"><Dropdown ariaLabel="Filtrar por situação" value={filtro} onChange={(v) => setParam({ status: v === "abertas" ? null : v, prazo: null })} options={FILTERS} /></div>
                    {departments.length > 1 && (
                      <div className="w-44"><Dropdown ariaLabel="Filtrar por departamento" value={dept} onChange={(v) => setParam({ depto: v || null })} placeholder="Todos os departamentos"
                        options={[{ value: "", label: "Todos os departamentos" }, ...departments.map((d) => ({ value: d, label: d }))]} /></div>
                    )}
                    {(prazo || dept || empresaFiltro || filtro !== "abertas") && (
                      <Button variant="ghost" size="sm" onClick={() => setParam({ status: null, prazo: null, depto: null, empresa: null })}>Limpar filtros</Button>
                    )}
                  </div>
                </div>
                {visible.length === 0 ? (
                  <p className="glass-panel glass-blur-card rounded-(--radius-panel) px-5 py-6 text-mac-body text-(--text-secondary)">
                    {filtro === "abertas" ? "Nada em aberto. Tudo em dia por aqui." : "Nenhuma obrigação nesta situação."}
                  </p>
                ) : (
                  <InstanceGroups list={visible} showCompany={grupo} onOpen={(id) => setParam({ instancia: id })} />
                )}
              </section>
            </>
          )}
        </>
      ) : tab === "calendario" ? (
        <Calendar templates={activeTemplates} instances={instances.data} canOperate={canOperateIn(current.id)}
          onOpen={(id) => setParam({ instancia: id })} onCreate={(template, period) => setNewInstance({ template, period })} />
      ) : (
        <ConfigPanel
          companyId={current.id} isAdmin={isAdmin} canOperate={canOperateIn(current.id)} templates={templates} deps={deps}
          onReload={() => { loadConfig(); loadInstances(); }} onEdit={(t) => setShowTemplate(t)} onNewInstance={(t) => setNewInstance({ template: t })}
        />
      )}
      </div>

      {aberta && (
        <InstanceDialog
          instanceId={aberta}
          members={grupo ? undefined : members}
          canOperate={canOperateIn(instances.data.find((i) => i.id === aberta)?.company_id ?? current.id)}
          canAdmin={isAdminOf(instances.data.find((i) => i.id === aberta)?.company_id ?? current.id)}
          showCompany={grupo}
          onClose={() => setParam({ instancia: null })}
          onChanged={patchInstance}
        />
      )}
      {showTemplate && (
        <TemplateDialog companyId={current.id} template={showTemplate === "nova" ? undefined : showTemplate} members={members}
          onClose={() => setShowTemplate(null)}
          onSaved={() => { setShowTemplate(null); loadConfig(); loadInstances(); }} />
      )}
      {showCatalog && (
        <CatalogDialog companyId={current.id} companyName={current.name} members={members}
          onClose={() => setShowCatalog(false)}
          onApplied={() => { setShowCatalog(false); loadConfig(); loadInstances(); setParam({ aba: null }); }} />
      )}
      {newInstance && (
        <NewInstanceDialog companyId={current.id} templates={activeTemplates} members={members} initial={newInstance} currentUserId={user?.id}
          onClose={() => setNewInstance(null)}
          onCreated={(inst) => { setNewInstance(null); loadInstances(); setParam({ instancia: inst.id }); }} />
      )}
    </div>
  );
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

/**
 * Central de conformidade (A7-28..A7-34): cada número é um filtro, com o
 * filtro ativo marcado; o percentual explica o que falta.
 */
function Compliance({ instances, filtro, onFilter }: { instances: Instance[]; filtro: string; onFilter: (f: string) => void }) {
  const relevant = instances.filter((i) => !["dispensado", "cancelado", "not_applicable"].includes(i.effective_status));
  const approved = relevant.filter((i) => i.effective_status === "approved").length;
  const pct = relevant.length ? Math.round((approved / relevant.length) * 100) : null;
  const count = (s: string) => instances.filter((i) => i.effective_status === s).length;
  const semDono = instances.filter((i) => !i.owner_id && OPEN_STATUSES.includes(i.effective_status)).length;
  const criticas = instances.filter((i) => i.criticality === "critica" && OPEN_STATUSES.includes(i.effective_status)).length;

  const cards = [
    { f: "abertas", label: "Em dia", value: pct === null ? "—" : `${pct}%`, hint: pct === null ? "nada para contar ainda" : `${approved} de ${relevant.length} cumpridas`, tone: "text-(--text-primary)" },
    { f: "overdue", label: "Atrasadas", value: count("overdue"), tone: count("overdue") ? "text-(--text-danger)" : "text-(--text-primary)" },
    { f: "expired", label: "Documento vencido", value: count("expired"), tone: count("expired") ? "text-(--text-danger)" : "text-(--text-primary)" },
    { f: "at_risk", label: "Vencem em breve", value: count("at_risk"), tone: count("at_risk") ? "text-(--text-warning)" : "text-(--text-primary)" },
    { f: "reviewing", label: "Esperando conferência", value: count("reviewing"), tone: count("reviewing") ? "text-(--text-accent)" : "text-(--text-primary)" },
    { f: criticas ? "criticas" : "sem_responsavel", label: criticas ? "Críticas pendentes" : "Sem responsável", value: criticas || semDono, tone: criticas ? "text-(--text-danger)" : "text-(--text-primary)" },
  ];

  return (
    <section aria-label="Central de conformidade" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {cards.map((c, idx) => {
        const on = filtro === c.f && !(idx === 0 && filtro !== "abertas");
        return (
          <button key={c.label} aria-pressed={on} onClick={() => onFilter(c.f)}
            className={`glass-panel glass-blur-card rounded-(--radius-panel) p-3 sm:p-4 text-left min-h-[84px] transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${on ? "ring-2 ring-teal-600" : "hover:bg-(--bg-hover)"} ${idx === 0 ? "col-span-2 sm:col-span-1" : ""}`}>
            <span className={`block text-mac-title2 font-semibold tabular-nums ${c.tone}`}>{c.value}</span>
            <span className="block text-mac-caption text-(--text-secondary)">{c.label}</span>
            {c.hint && <span className="block text-mac-caption2 text-(--text-secondary)">{c.hint}</span>}
          </button>
        );
      })}
    </section>
  );
}

function InstanceGroups({ list, showCompany, onOpen }: { list: Instance[]; showCompany: boolean; onOpen: (id: string) => void }) {
  const sorted = [...list].sort((a, b) => (URGENCY[a.effective_status] ?? 9) - (URGENCY[b.effective_status] ?? 9) || a.due_date.localeCompare(b.due_date));
  return (
    <div className="space-y-4">
      {GROUPS.map((g) => {
        const items = sorted.filter((i) => g.statuses.includes(i.effective_status));
        if (!items.length) return null;
        return (
          <section key={g.id} aria-label={`${g.title}: ${items.length}`} className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden">
            <h3 className="px-4 sm:px-5 py-2 border-b border-(--border-default) text-mac-caption font-semibold uppercase tracking-[0.06em] text-(--text-secondary)">
              {g.title} · {items.length}
            </h3>
            <ul>
              {items.map((i) => {
                const S = STATUS[i.effective_status] ?? STATUS.pending;
                return (
                  <li key={i.id} className="border-b border-(--border-default) last:border-0">
                    <button onClick={() => onOpen(i.id)}
                      className="w-full text-left flex items-start sm:items-center gap-3 px-4 sm:px-5 py-2.5 min-h-14 hover:bg-(--bg-hover) transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)">
                      <S.icon className={`w-4 h-4 shrink-0 mt-0.5 sm:mt-0 ${S.tone}`} aria-hidden="true" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-mac-body text-(--text-primary) truncate">
                          {i.template_name} <span className="text-(--text-secondary)">· {i.period_label}</span>
                          {i.criticality === "critica" && <span className="ml-1.5 text-mac-caption font-semibold text-(--text-danger)">crítica</span>}
                        </span>
                        <span className="block text-mac-caption text-(--text-secondary) truncate">
                          {showCompany && i.company_name ? `${i.company_name} · ` : ""}
                          <span className={i.effective_status === "overdue" || i.effective_status === "expired" ? "text-(--text-danger)" : ""}>{dueText(i)}</span>
                          {" · "}{i.owner_name ?? <span className="italic">sem responsável</span>}
                          {i.document_count > 0 ? ` · ${i.document_count} documento${i.document_count > 1 ? "s" : ""}` : ""}
                          {i.effective_status === "blocked" && i.blocking_templates ? ` · espera ${i.blocking_templates.join(", ")}` : ""}
                        </span>
                      </span>
                      <StatusChip status={i.effective_status} className="hidden sm:inline-flex" />
                      <ChevronRight className="w-4 h-4 shrink-0 text-(--text-secondary)" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * Calendário (A7-20..A7-26): obrigações nas linhas, meses do ano nas
 * colunas, estado com ícone e texto acessível, alvo de 32/44 px.
 */
function Calendar({ templates, instances, canOperate, onOpen, onCreate }: {
  templates: Template[]; instances: Instance[]; canOperate: boolean;
  onOpen: (id: string) => void; onCreate: (t: Template, period: string) => void;
}) {
  const [year, setYear] = useState(new Date().getFullYear());
  const mensais = templates.filter((t) => t.frequency === "mensal" && t.active);
  const byKey = useMemo(() => new Map(instances.map((i) => [`${i.template_id}|${i.period}`, i])), [instances]);
  const outras = templates.filter((t) => t.frequency !== "mensal" && t.active);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setYear((y) => y - 1)} aria-label="Ano anterior">‹</Button>
        <span className="text-mac-body font-semibold text-(--text-primary) tabular-nums w-14 text-center" aria-live="polite">{year}</span>
        <Button variant="secondary" size="sm" onClick={() => setYear((y) => y + 1)} aria-label="Próximo ano">›</Button>
      </div>
      {mensais.length === 0 ? (
        <p className="text-mac-body text-(--text-secondary)">Nenhuma obrigação mensal ativa. O calendário mostra as que se repetem todo mês.</p>
      ) : (
        <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-x-auto">
          <table className="w-full border-collapse min-w-[760px]">
            <caption className="sr-only">Obrigações mensais de {year}, por mês da competência</caption>
            <thead>
              <tr>
                <th scope="col" className="text-left px-4 py-2.5 text-mac-caption font-medium text-(--text-secondary) sticky left-0 bg-(--bg-card) min-w-48">Obrigação</th>
                {MESES.map((m) => <th key={m} scope="col" className="px-1 py-2.5 text-mac-caption font-medium text-(--text-secondary) text-center">{m.slice(0, 3)}</th>)}
              </tr>
            </thead>
            <tbody>
              {mensais.map((t) => (
                <tr key={t.id} className="border-t border-(--border-default)">
                  <th scope="row" className="text-left px-4 py-2 text-mac-body font-normal text-(--text-primary) sticky left-0 bg-(--bg-card) max-w-64 truncate">{t.name}</th>
                  {MESES.map((m, idx) => {
                    const period = `${year}-${String(idx + 1).padStart(2, "0")}`;
                    const inst = byKey.get(`${t.id}|${period}`);
                    const label = `${t.name}, ${m} de ${year}`;
                    if (inst) {
                      const S = STATUS[inst.effective_status] ?? STATUS.pending;
                      return (
                        <td key={m} className="px-1 py-1.5 text-center">
                          <button onClick={() => onOpen(inst.id)} aria-label={`${label}: ${S.label}`} title={`${label}: ${S.label}`}
                            className={`inline-flex items-center justify-center w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 rounded-full transition-colors duration-fast hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${S.tone}`}>
                            {/* Célula anima quando o estado muda (A7-22). */}
                            <span key={inst.effective_status} className="reveal inline-flex"><S.icon className="w-4 h-4" aria-hidden="true" /></span>
                          </button>
                        </td>
                      );
                    }
                    return (
                      <td key={m} className="px-1 py-1.5 text-center">
                        {canOperate ? (
                          <button onClick={() => onCreate(t, period)} aria-label={`${label}: abrir competência`} title="Abrir competência"
                            className="inline-flex items-center justify-center w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 rounded-full text-(--text-secondary) opacity-40 hover:opacity-100 hover:bg-(--bg-hover) focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
                            <CalendarPlus className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        ) : <span className="text-(--text-secondary)" aria-label={`${label}: sem competência`}>·</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-mac-caption text-(--text-secondary)" aria-label="Legenda">
        {["approved", "reviewing", "at_risk", "overdue", "expired", "pending", "blocked"].map((s) => {
          const S = STATUS[s];
          return <li key={s} className="flex items-center gap-1.5"><S.icon className={`w-3.5 h-3.5 ${S.tone}`} aria-hidden="true" /> {S.label}</li>;
        })}
      </ul>
      {outras.length > 0 && (
        <section aria-labelledby="cal-outras" className="space-y-2">
          <h2 id="cal-outras" className="text-mac-body font-semibold text-(--text-primary)">Anuais, licenças e certidões</h2>
          <ul className="glass-panel glass-blur-card rounded-(--radius-panel) divide-y divide-(--border-default)">
            {outras.map((t) => {
              const ultima = instances.filter((i) => i.template_id === t.id).sort((a, b) => b.due_date.localeCompare(a.due_date))[0];
              return (
                <li key={t.id}>
                  <button disabled={!ultima} onClick={() => ultima && onOpen(ultima.id)}
                    className="w-full text-left flex items-center gap-3 px-4 py-2.5 min-h-12 hover:bg-(--bg-hover) disabled:hover:bg-transparent focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)">
                    <span className="flex-1 min-w-0">
                      <span className="block text-mac-body text-(--text-primary) truncate">{t.name}</span>
                      <span className="block text-mac-caption text-(--text-secondary)">{ultima ? `${ultima.period_label} · ${dueText(ultima)}` : `${scheduleText(t)} · nenhuma competência aberta`}</span>
                    </span>
                    {ultima && <StatusChip status={ultima.effective_status} />}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Cadastro: editar, pausar, arquivar com confirmação e dependências legíveis (A7-10, A7-62..A7-68). */
function ConfigPanel({ companyId, isAdmin, canOperate, templates, deps, onReload, onEdit, onNewInstance }: {
  companyId: string; isAdmin: boolean; canOperate: boolean; templates: Load<Template[]>; deps: Dependency[];
  onReload: () => void; onEdit: (t: Template) => void; onNewInstance: (t: Template) => void;
}) {
  const { success, error: showError } = useToast();
  const [archiving, setArchiving] = useState<Template | null>(null);
  const [removingDep, setRemovingDep] = useState<Dependency | null>(null);
  const [addingDep, setAddingDep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  async function act(fn: () => Promise<unknown>, ok: string, fallback: string) {
    setBusy(true);
    try { await fn(); success(ok); onReload(); return true; } catch (e) { showError(friendly(e, fallback)); return false; } finally { setBusy(false); }
  }

  if (templates.state === "error") return <LoadError what="o cadastro de obrigações" onRetry={onReload} />;
  if (templates.state === "loading") return <div className="space-y-2" aria-label="Carregando">{[0, 1, 2].map((i) => <div key={i} className="h-14 rounded bg-(--bg-hover) animate-pulse" />)}</div>;

  const ativos = templates.data.filter((t) => !t.archived_at);
  const arquivados = templates.data.filter((t) => t.archived_at);

  return (
    <div className="space-y-6">
      <section aria-labelledby="cfg-modelos" className="space-y-2">
        <h2 id="cfg-modelos" className="text-mac-body font-semibold text-(--text-primary)">Obrigações cadastradas ({ativos.length})</h2>
        <ul className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) divide-y divide-(--border-default)">
          {ativos.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 sm:px-5 py-3">
              <div className="flex-1 min-w-48">
                <p className="text-mac-body text-(--text-primary)">
                  {t.name}
                  {!t.active && <span className="ml-2 text-mac-caption font-medium text-(--text-warning)">pausada</span>}
                </p>
                <p className="text-mac-caption text-(--text-secondary)">
                  {scheduleText(t)} · criticidade {CRIT_LABEL[t.criticality].toLowerCase()} · {t.default_owner_name ?? "sem responsável padrão"}
                  {t.requires_review ? " · conferência antes de cumprir" : ""}{t.department ? ` · ${t.department}` : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                {canOperate && t.active && (
                  <Button variant="ghost" size="sm" onClick={() => onNewInstance(t)}><CalendarPlus className="w-3.5 h-3.5" aria-hidden="true" /> Abrir competência</Button>
                )}
                {isAdmin && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(t)} aria-label={`Editar ${t.name}`}><Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Editar</Button>
                    <Button variant="ghost" size="sm" disabled={busy}
                      onClick={() => act(() => api.patch(`/obligations/templates/${t.id}`, { active: !t.active }), t.active ? "Pausada: não abre novas competências." : "Reativada.", "Não foi possível alterar.")}
                      aria-label={`${t.active ? "Pausar" : "Reativar"} ${t.name}`}>
                      {t.active ? <Pause className="w-3.5 h-3.5" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />} {t.active ? "Pausar" : "Reativar"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setArchiving(t)} aria-label={`Arquivar ${t.name}`}><Archive className="w-3.5 h-3.5" aria-hidden="true" /> Arquivar</Button>
                  </>
                )}
              </div>
            </li>
          ))}
          {ativos.length === 0 && <li className="px-5 py-4 text-mac-body text-(--text-secondary)">Nenhuma obrigação ativa.</li>}
        </ul>
        {arquivados.length > 0 && (
          <div>
            <button aria-expanded={showArchived} onClick={() => setShowArchived((v) => !v)} className="text-mac-caption font-medium text-(--text-accent) hover:underline">
              {showArchived ? "Esconder" : "Ver"} {arquivados.length} arquivada{arquivados.length > 1 ? "s" : ""}
            </button>
            {showArchived && (
              <ul className="mt-2 rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)">
                {arquivados.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="flex-1 text-mac-body text-(--text-secondary)">{t.name}</span>
                    {isAdmin && (
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => act(() => api.post(`/obligations/templates/${t.id}/archive`, null, { params: { restore: true } }), "Obrigação reativada.", "Não foi possível reativar.")}>
                        <ArchiveRestore className="w-3.5 h-3.5" aria-hidden="true" /> Reativar
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="cfg-deps" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="cfg-deps" className="text-mac-body font-semibold text-(--text-primary)">Uma depende da outra</h2>
          {isAdmin && ativos.length >= 2 && <Button variant="ghost" size="sm" onClick={() => setAddingDep(true)}><GitBranch className="w-3.5 h-3.5" aria-hidden="true" /> Nova dependência</Button>}
        </div>
        <p className="text-mac-caption text-(--text-secondary)">Ex.: a DCTFWeb só fecha depois do eSocial da mesma competência. Enquanto o pré-requisito não estiver cumprido, a outra aparece como “aguardando”.</p>
        {deps.length === 0 ? (
          <p className="text-mac-body text-(--text-secondary)">Nenhuma dependência.</p>
        ) : (
          <ul className="glass-panel glass-blur-card rounded-(--radius-panel) divide-y divide-(--border-default)">
            {deps.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-2 min-h-11">
                <span className="flex-1 text-mac-body text-(--text-primary)">
                  <strong>{d.depends_on_name}</strong> <span className="text-(--text-secondary)">vem antes de</span> <strong>{d.template_name}</strong>
                </span>
                {isAdmin && (
                  <Button variant="icon" size="sm" aria-label={`Remover: ${d.template_name} depende de ${d.depends_on_name}`} onClick={() => setRemovingDep(d)}>
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {archiving && (
        <ConfirmModal
          title={`Arquivar “${archiving.name}”?`}
          description={<>Ela some da lista e dos números{archiving.instance_count ? `, com ${archiving.instance_count} competência${archiving.instance_count > 1 ? "s" : ""} e os documentos vinculados guardados` : ""}. Dá para reativar depois em “arquivadas”.</>}
          confirmLabel="Arquivar" loading={busy}
          onClose={() => setArchiving(null)}
          onConfirm={async () => { if (await act(() => api.post(`/obligations/templates/${archiving.id}/archive`), "Obrigação arquivada.", "Não foi possível arquivar.")) setArchiving(null); }}
        />
      )}
      {removingDep && (
        <ConfirmModal
          title="Remover a dependência?"
          description={<>“{removingDep.template_name}” deixa de esperar “{removingDep.depends_on_name}”.</>}
          confirmLabel="Remover" danger loading={busy}
          onClose={() => setRemovingDep(null)}
          onConfirm={async () => { if (await act(() => api.delete(`/obligations/dependencies/${removingDep.id}`, { params: { company_id: companyId } }), "Dependência removida.", "Não foi possível remover.")) setRemovingDep(null); }}
        />
      )}
      {addingDep && <DependencyDialog companyId={companyId} templates={ativos} onClose={() => setAddingDep(false)} onCreated={() => { setAddingDep(false); onReload(); }} />}
    </div>
  );
}

function DependencyDialog({ companyId, templates, onClose, onCreated }: { companyId: string; templates: Template[]; onClose: () => void; onCreated: () => void }) {
  const { success, error: showError } = useToast();
  const [antes, setAntes] = useState(templates[0]?.id ?? "");
  const [depois, setDepois] = useState(templates[1]?.id ?? "");
  const [saving, setSaving] = useState(false);
  const opts = templates.map((t) => ({ value: t.id, label: t.name }));
  async function submit() {
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/obligations/dependencies`, { template_id: depois, depends_on_template_id: antes });
      success("Dependência criada.");
      onCreated();
    } catch (e) {
      showError(friendly(e, "Não foi possível criar a dependência."));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog onClose={onClose} title="Nova dependência" description="A segunda só pode ser cumprida depois da primeira, na mesma competência." size="md" busy={saving}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} disabled={!antes || !depois || antes === depois} onClick={submit}>Criar</Button></>}>
      <div className="space-y-4">
        <div>
          <label id="dep-antes" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Primeiro</label>
          <Dropdown ariaLabelledby="dep-antes" value={antes} onChange={setAntes} options={opts} />
        </div>
        <div>
          <label id="dep-depois" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Depois</label>
          <Dropdown ariaLabelledby="dep-depois" value={depois} onChange={setDepois} options={opts.filter((o) => o.value !== antes)} />
        </div>
      </div>
    </Dialog>
  );
}

/** Abrir competência à mão, com o prazo sugerido pelo próprio modelo (A7-46, A7-47). */
function NewInstanceDialog({ companyId, templates, members, initial, currentUserId, onClose, onCreated }: {
  companyId: string; templates: Template[]; members: Member[]; initial: { template?: Template; period?: string };
  currentUserId?: string; onClose: () => void; onCreated: (inst: Instance) => void;
}) {
  const { success, error: showError } = useToast();
  const [templateId, setTemplateId] = useState(initial.template?.id ?? templates[0]?.id ?? "");
  const t = templates.find((x) => x.id === templateId);
  const today = new Date();
  const defaultPeriod = (tt?: Template) => {
    if (!tt) return "";
    if (initial.period && tt.id === initial.template?.id) return tt.frequency === "mensal" ? `${initial.period.slice(5, 7)}/${initial.period.slice(0, 4)}` : initial.period;
    if (tt.frequency === "mensal") return `${String(today.getMonth() + 1).padStart(2, "0")}/${today.getFullYear()}`;
    if (tt.frequency === "anual") return String(today.getFullYear());
    return tt.frequency === "unica" ? "Vigente" : "";
  };
  const [period, setPeriod] = useState(defaultPeriod(t));
  const suggestDue = (tt: Template | undefined, p: string) => {
    if (!tt?.due_day) return "";
    let y: number, m: number;
    if (tt.frequency === "mensal") {
      const mm = p.match(/^(\d{2})\/(\d{4})$/); if (!mm) return "";
      m = Number(mm[1]) - 1 + (tt.due_month_offset ?? 1); y = Number(mm[2]);
    } else if (tt.frequency === "anual" && tt.due_month) { if (!/^\d{4}$/.test(p)) return ""; y = Number(p); m = tt.due_month - 1; } else return "";
    const last = new Date(y, m + 1, 0).getDate();
    const d = new Date(y, m, Math.min(tt.due_day, last));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const [due, setDue] = useState(suggestDue(t, defaultPeriod(t)) || today.toISOString().slice(0, 10));
  const [owner, setOwner] = useState(t?.default_owner_id ?? currentUserId ?? "");
  const [saving, setSaving] = useState(false);
  const people = [...new Map(members.filter((m) => !m.folder_id && m.role !== "visualizador").map((m) => [m.user_id, m])).values()];
  const periodHint = t?.frequency === "mensal" ? "mm/aaaa" : t?.frequency === "anual" ? "aaaa" : "Ex.: Vigente, Reforma 2026";

  async function submit() {
    setSaving(true);
    try {
      const r = await api.post<Instance>(`/companies/${companyId}/obligations/instances`, { template_id: templateId, period, due_date: due, owner_id: owner || null });
      success(`Competência ${r.data.period_label} aberta.`);
      onCreated(r.data);
    } catch (e) {
      showError(friendly(e, "Não foi possível abrir a competência."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog onClose={onClose} title="Abrir competência" description="Para períodos que não abriram sozinhos ou obrigações por ocorrência." size="md" busy={saving}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} disabled={!templateId || !period.trim() || !due} onClick={submit}>Abrir</Button></>}>
      <div className="space-y-4">
        <div>
          <label id="ni-tpl" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Obrigação</label>
          <Dropdown ariaLabelledby="ni-tpl" value={templateId} options={templates.map((x) => ({ value: x.id, label: x.name }))}
            onChange={(v) => { setTemplateId(v); const nt = templates.find((x) => x.id === v); const p = defaultPeriod(nt); setPeriod(p); setDue(suggestDue(nt, p) || due); setOwner(nt?.default_owner_id ?? owner); }} />
        </div>
        <Input label={`Competência (${periodHint})`} value={period} onChange={(e) => { setPeriod(e.target.value); const s = suggestDue(t, e.target.value); if (s) setDue(s); }} placeholder={periodHint} />
        <Input label="Vence em" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <div>
          <label id="ni-own" className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Responsável</label>
          <Dropdown ariaLabelledby="ni-own" value={owner} onChange={setOwner} placeholder="Sem responsável"
            options={[{ value: "", label: "Sem responsável" }, ...people.map((m) => ({ value: m.user_id, label: m.full_name }))]} />
        </div>
      </div>
    </Dialog>
  );
}
