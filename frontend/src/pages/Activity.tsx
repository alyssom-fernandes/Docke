import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, ShieldCheck, ShieldAlert, ChevronLeft, ChevronRight } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import ActivityFeed, { ACTION_LABELS, InspecionarEvento, readableMetadata } from "@/components/shared/ActivityFeed";
import { InspectorLayout, useInspectorTarget, useLargo } from "@/components/shared/ListInspector";
import Dropdown from "@/components/ui/Dropdown";
import Button from "@/components/ui/Button";
import Menu from "@/components/ui/Menu";
import { PageHeader, ToolbarGroup, ToolbarButton } from "@/components/layout/window";

interface Member { user_id: string; full_name: string }

// Relatórios prontos (FA-A6-07): grupos de ações que um auditor costuma pedir.
const RELATORIOS: { value: string; label: string }[] = [
  { value: "delete,version_delete,retention_queue_approved", label: "Exclusões e descartes" },
  { value: "download", label: "Downloads" },
  { value: "share_create,share_revoke,share_policy,upload_request", label: "Compartilhamentos" },
  { value: "features", label: "Recursos da empresa" },
  { value: "access_grant,access_revoke,access_role_change,member_remove,account_deactivate,account_activate,account_password_reset,mfa_reset,mfa_policy,sessions_end", label: "Acessos e permissões" },
  { value: "audit_export,audit_verify,integrity_check", label: "Auditoria da trilha" },
];

const ACTION_GROUPS: { value: string; label: string }[] = [
  { value: "", label: "Todas as ações" },
  ...RELATORIOS,
  { value: "upload", label: "Envios" },
  { value: "view", label: "Aberturas" },
  { value: "download", label: "Downloads" },
  { value: "move", label: "Movimentações" },
  { value: "rename", label: "Renomeações" },
  { value: "delete", label: "Exclusões" },
  { value: "restore", label: "Restaurações" },
  { value: "update_metadata", label: "Metadados alterados" },
  { value: "version_delete", label: "Versões excluídas" },
  { value: "integrity_check", label: "Integridade conferida" },
  { value: "obligation_link", label: "Documentos enviados para obrigações" },
  { value: "obligation_approve", label: "Obrigações aprovadas" },
  { value: "retention_hold_create", label: "Bloqueios judiciais" },
  { value: "retention_queue_approved", label: "Descartes aprovados" },
];

const PERIODS = [
  { value: "", label: "Qualquer data" },
  { value: "hoje", label: "Hoje" },
  { value: "7", label: "Últimos 7 dias" },
  { value: "30", label: "Últimos 30 dias" },
  { value: "90", label: "Últimos 90 dias" },
];

function daysAgo(n: number) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }

/**
 * Atividade (A6-22..A6-29): filtros por pessoa, ação, tipo e período na URL;
 * exportar leva só o que está filtrado, com aviso de erro; integridade da
 * trilha verificável aqui (A6-23).
 */
export default function Activity() {
  const insp = useInspectorTarget();
  const largo = useLargo();
  usePageTitle("Atividade");
  const { current } = useCompany();
  const { error: showError, success } = useToast();
  const [params, setParams] = useSearchParams();
  const uid = useId();
  const [total, setTotal] = useState(0);
  const [members, setMembers] = useState<Member[]>([]);
  const [exporting, setExporting] = useState(false);
  const [integrity, setIntegrity] = useState<{ intact: boolean; total_events: number; broken_count: number } | null>(null);
  const [checking, setChecking] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const PAGE_SIZE = 25;
  const isAdmin = ["admin", "supremo"].includes(current?.permission_level ?? "");

  const acao = params.get("acao") ?? "";
  const pessoa = params.get("pessoa") ?? "";
  const tipo = params.get("tipo") ?? "";
  const periodo = params.get("periodo") ?? "";
  // "Ver tudo na Atividade" a partir do documento (A5-28).
  const item = params.get("item") ?? "";
  const itemNome = params.get("nome") ?? "";
  const page = Math.max(1, Number(params.get("pagina") ?? 1) || 1);

  function setP(changes: Record<string, string | null>) {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(changes)) { if (!v) n.delete(k); else n.set(k, v); }
      if (!("pagina" in changes)) n.delete("pagina");
      return n;
    }, { replace: true });
  }

  useEffect(() => {
    if (!current) return;
    api.get<Member[]>(`/companies/${current.id}/members`)
      .then((r) => setMembers([...new Map((r.data ?? []).map((m) => [m.user_id, m])).values()].sort((a, b) => a.full_name.localeCompare(b.full_name, "pt-BR"))))
      .catch(() => setMembers([]));
  }, [current?.id]);

  const dateFrom = periodo === "hoje" ? daysAgo(0) : periodo ? daysAgo(Number(periodo)) : undefined;
  const filters = useMemo(() => ({ userId: pessoa || undefined, action: acao || undefined, itemType: tipo || undefined, dateFrom }), [pessoa, acao, tipo, dateFrom]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtrado = !!(acao || pessoa || tipo || periodo || item);

  async function exportActivity(format: "csv" | "xlsx") {
    if (!current) return;
    setExporting(true);
    try {
      const r = await api.get("/activity/export", {
        params: { company_id: current.id, format, user_id: pessoa || undefined, action: acao || undefined, item_type: tipo || undefined, date_from: dateFrom },
        responseType: "blob",
      });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `atividade-${current.name.replace(/[^\w-]+/g, "-").toLowerCase()}-${new Date().toISOString().slice(0, 10)}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      success(filtrado ? "Exportado só o que está filtrado." : "Atividade exportada.");
    } catch {
      showError("Não foi possível exportar agora. Tente de novo.");
    } finally {
      setExporting(false);
    }
  }

  async function verify() {
    if (!current) return;
    setChecking(true);
    try {
      const r = await api.get("/activity/verify-integrity", { params: { company_id: current.id } });
      setIntegrity(r.data);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível verificar agora.");
    } finally {
      setChecking(false);
    }
  }

  const memberOpts = [{ value: "", label: "Todas as pessoas" }, ...members.map((m) => ({ value: m.user_id, label: m.full_name }))];
  const labelOf = (v: string) => ACTION_GROUPS.find((a) => a.value === v)?.label ?? ACTION_LABELS[v] ?? v;

  return (
    <div className={`space-y-6 ${largo ? "max-w-[1480px]" : "max-w-[1100px]"} w-full mx-auto`}>
      <PageHeader title="Atividade" subtitle="Quem fez o quê, quando">
        <ToolbarGroup label="Atividade">
          {isAdmin && (
            <ToolbarButton inGroup label="Verificar integridade da trilha" onClick={verify} disabled={checking}>
              <ShieldCheck className={checking ? "animate-pulse" : ""} aria-hidden="true" />
            </ToolbarButton>
          )}
          <ToolbarButton inGroup label={filtrado ? "Exportar o que está filtrado" : "Exportar"} disabled={exporting}
            aria-haspopup="menu" aria-expanded={!!menuAnchor} onClick={(e) => setMenuAnchor(e.currentTarget)}>
            <Download aria-hidden="true" />
          </ToolbarButton>
        </ToolbarGroup>
      </PageHeader>
      <p className="text-mac-footnote text-(--text-secondary) mb-3!">Cada registro fica encadeado ao anterior e não pode ser alterado.</p>
      {menuAnchor && (
        <Menu
          anchor={menuAnchor} label="Exportar atividade" align="end" onClose={() => setMenuAnchor(null)}
          items={[
            { label: "Planilha CSV", onSelect: () => exportActivity("csv") },
            { label: "Excel (.xlsx)", onSelect: () => exportActivity("xlsx") },
          ]}
        />
      )}

      {integrity && (
        <p role="status" className={`flex items-center gap-2 rounded-(--radius-control) px-3 py-2 text-mac-body ${integrity.intact ? "bg-green-600/10 text-(--text-primary)" : "bg-(--tint-danger) text-(--text-primary)"}`}>
          {integrity.intact ? <ShieldCheck className="w-4 h-4 text-(--text-success)" aria-hidden="true" /> : <ShieldAlert className="w-4 h-4 text-(--text-danger)" aria-hidden="true" />}
          {integrity.intact
            ? `Trilha íntegra: ${integrity.total_events.toLocaleString("pt-BR")} registros conferidos, nenhum alterado.`
            : `${integrity.broken_count} ${integrity.broken_count === 1 ? "registro não confere" : "registros não conferem"}. Detalhes em Ajustes → Segurança.`}
        </p>
      )}

      <div role="group" aria-label="Relatórios prontos" className="flex flex-wrap items-center gap-1.5">
        <span className="text-mac-caption font-medium text-(--text-secondary) mr-1">Relatórios prontos:</span>
        {RELATORIOS.map((r) => (
          <button key={r.value} type="button" aria-pressed={acao === r.value} onClick={() => setP({ acao: acao === r.value ? null : r.value })}
            className={`h-8 pointer-coarse:h-10 px-3 text-mac-caption font-medium rounded-full border transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${acao === r.value ? "bg-(--accent) border-(--accent) text-white" : "border-(--border-control) text-(--text-primary) hover:bg-(--bg-hover)"}`}>
            {r.label}
          </button>
        ))}
      </div>

      <section aria-label="Filtros" className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <div><label id={`${uid}-p`} className="sr-only">Pessoa</label><Dropdown ariaLabelledby={`${uid}-p`} value={pessoa} onChange={(v) => setP({ pessoa: v })} options={memberOpts} /></div>
        <div><label id={`${uid}-a`} className="sr-only">Ação</label><Dropdown ariaLabelledby={`${uid}-a`} value={acao} onChange={(v) => setP({ acao: v })} options={ACTION_GROUPS.some((a) => a.value === acao) ? ACTION_GROUPS : [...ACTION_GROUPS, { value: acao, label: labelOf(acao) }]} /></div>
        <div><label id={`${uid}-t`} className="sr-only">Tipo de item</label><Dropdown ariaLabelledby={`${uid}-t`} value={tipo} onChange={(v) => setP({ tipo: v })}
          options={[{ value: "", label: "Documentos e pastas" }, { value: "document", label: "Só documentos" }, { value: "folder", label: "Só pastas" }, { value: "obligation", label: "Obrigações" }, { value: "retention", label: "Retenção" }]} /></div>
        <div><label id={`${uid}-d`} className="sr-only">Período</label><Dropdown ariaLabelledby={`${uid}-d`} value={periodo} onChange={(v) => setP({ periodo: v })} options={PERIODS} /></div>
      </section>
      {filtrado && (
        <div className="flex flex-wrap items-center gap-2 text-mac-caption text-(--text-secondary)">
          <span aria-live="polite">{total.toLocaleString("pt-BR")} {total === 1 ? "registro" : "registros"} com estes filtros.</span>
          {item && <span className="rounded-full bg-(--bg-hover) px-2 py-0.5 text-(--text-primary)">Só {itemNome ? `“${itemNome}”` : "este item"}</span>}
          <button onClick={() => setP({ acao: null, pessoa: null, tipo: null, periodo: null, item: null, nome: null })} className="font-medium text-(--text-accent) hover:underline">Limpar filtros</button>
        </div>
      )}

      {current && (
        <InspectorLayout item={insp.item} vazio="Passe o ponteiro num registro para ver os detalhes dele aqui.">
          <InspecionarEvento.Provider value={(ev) => insp.bind({
            kind: ev.item_type === "document" ? "document" : ev.item_type === "folder" ? "folder" : "other",
            id: ev.item_type === "document" || ev.item_type === "folder" ? ev.item_id : ev.id,
            name: ev.item_name_snapshot || (ACTION_LABELS[ev.action] ?? ev.action),
            icon: ev.item_type === "document" || ev.item_type === "folder" ? undefined : <ShieldCheck className="w-14 h-14 text-(--text-secondary)" aria-hidden="true" />,
            extra: [
              ["Quem", ev.user_name], ["O quê", ACTION_LABELS[ev.action] ?? ev.action],
              ["Quando", new Date(ev.created_at).toLocaleString("pt-BR")],
              ...readableMetadata(ev.metadata).map((m, i) => [i === 0 ? "Detalhes" : "", m] as [string, string]),
            ],
          })}>
            <ActivityFeed companyId={current.id} itemId={item || undefined} page={page} pageSize={PAGE_SIZE} onLoaded={setTotal} filters={filters}
              emptyDescription={filtrado ? "Nada com estes filtros." : "As ações nos documentos aparecem aqui."} />
          </InspecionarEvento.Provider>
        </InspectorLayout>
      )}

      {totalPages > 1 && (
        <nav aria-label="Páginas da atividade" className="flex items-center justify-center gap-2">
          <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => { setP({ pagina: String(page - 1) }); window.scrollTo({ top: 0 }); }}><ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> Anterior</Button>
          <span className="text-mac-body text-(--text-secondary) tabular-nums">{page} / {totalPages}</span>
          <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={() => { setP({ pagina: String(page + 1) }); window.scrollTo({ top: 0 }); }}>Próxima <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" /></Button>
        </nav>
      )}
    </div>
  );
}
