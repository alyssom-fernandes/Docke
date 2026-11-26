import { AlertTriangle, CalendarClock, CheckCircle2, ClipboardCheck, Clock, Lock, MinusCircle, XCircle, Ban, type LucideIcon } from "lucide-react";

export interface Template {
  id: string;
  name: string;
  description: string | null;
  frequency: "mensal" | "anual" | "unica" | "evento";
  criticality: "baixa" | "media" | "alta" | "critica";
  department: string | null;
  sla_days: number;
  weight: number;
  validity_months: number | null;
  rules_json: { not_applicable_when?: { field: string; in: string[] } } | string;
  active: boolean;
  archived_at: string | null;
  due_day: number | null;
  due_month_offset: number;
  due_month: number | null;
  default_owner_id: string | null;
  default_owner_name?: string | null;
  requires_review: boolean;
  legal_basis: string | null;
  catalog_key: string | null;
  instance_count?: number;
}

export interface Instance {
  id: string;
  template_id: string;
  template_name: string;
  template_description?: string | null;
  company_id: string;
  company_name?: string;
  criticality: string;
  department: string | null;
  frequency: string;
  legal_basis?: string | null;
  requires_review?: boolean;
  period: string;
  period_label: string;
  due_date: string;
  effective_status: string;
  status: string;
  dispensa_motivo: string | null;
  document_count: number;
  blocking_templates: string[] | null;
  document_expires_at: string | null;
  owner_id: string | null;
  owner_name: string | null;
  notes: string | null;
  reviewer_name?: string | null;
  reviewed_at?: string | null;
  review_note?: string | null;
  days_late: number;
}

export interface Dependency {
  id: string;
  template_id: string;
  template_name: string;
  depends_on_template_id: string;
  depends_on_name: string;
}

export interface Member { user_id: string; full_name: string; role: string; folder_id: string | null }

/** Estado com ícone e texto, nunca só a cor (A7-24, A7-33). */
export const STATUS: Record<string, { label: string; icon: LucideIcon; tone: string; chip: string }> = {
  overdue: { label: "Atrasada", icon: AlertTriangle, tone: "text-(--text-danger)", chip: "bg-red-500/12 text-(--text-danger)" },
  at_risk: { label: "Vence em breve", icon: CalendarClock, tone: "text-(--text-warning)", chip: "bg-amber-500/15 text-(--text-warning)" },
  expired: { label: "Documento vencido", icon: XCircle, tone: "text-(--text-danger)", chip: "bg-red-500/12 text-(--text-danger)" },
  reviewing: { label: "Esperando conferência", icon: ClipboardCheck, tone: "text-(--text-accent)", chip: "bg-teal-500/12 text-(--text-accent)" },
  blocked: { label: "Aguardando outra", icon: Lock, tone: "text-(--text-secondary)", chip: "bg-(--bg-hover) text-(--text-secondary)" },
  pending: { label: "A fazer", icon: Clock, tone: "text-(--text-secondary)", chip: "bg-(--bg-hover) text-(--text-primary)" },
  approved: { label: "Cumprida", icon: CheckCircle2, tone: "text-(--text-success)", chip: "bg-green-600/12 text-(--text-success)" },
  dispensado: { label: "Dispensada", icon: MinusCircle, tone: "text-(--text-secondary)", chip: "bg-(--bg-hover) text-(--text-secondary)" },
  cancelado: { label: "Cancelada", icon: Ban, tone: "text-(--text-secondary)", chip: "bg-(--bg-hover) text-(--text-secondary)" },
  not_applicable: { label: "Não se aplica", icon: MinusCircle, tone: "text-(--text-secondary)", chip: "bg-(--bg-hover) text-(--text-secondary)" },
};

export function StatusChip({ status, className = "" }: { status: string; className?: string }) {
  const s = STATUS[status] ?? STATUS.pending;
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-mac-caption font-medium whitespace-nowrap ${s.chip} ${className}`}>
      <Icon className="w-3 h-3 shrink-0" aria-hidden="true" />
      {s.label}
    </span>
  );
}

export const FREQ_LABEL: Record<string, string> = { mensal: "Todo mês", anual: "Todo ano", unica: "Com validade / única", evento: "A cada ocorrência" };
export const CRIT_LABEL: Record<string, string> = { baixa: "Baixa", media: "Média", alta: "Alta", critica: "Crítica" };
export const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

/** Ordem de urgência: o que precisa de ação primeiro. */
export const URGENCY: Record<string, number> = {
  overdue: 0, expired: 1, at_risk: 2, reviewing: 3, pending: 4, blocked: 5, approved: 6, dispensado: 7, cancelado: 8, not_applicable: 9,
};

export const OPEN_STATUSES = ["overdue", "expired", "at_risk", "reviewing", "pending", "blocked"];

const DIA = 24 * 60 * 60 * 1000;
export function fmtDate(iso: string) {
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).replace(/\./g, "");
}

/** "venceu há 3 dias (12 nov 2026)" / "vence hoje" / "vence em 5 dias (…)". */
export function dueText(inst: Pick<Instance, "due_date" | "effective_status" | "document_expires_at">) {
  if (inst.effective_status === "expired" && inst.document_expires_at) return `documento venceu em ${fmtDate(inst.document_expires_at)}`;
  if (inst.effective_status === "approved") return inst.document_expires_at ? `vale até ${fmtDate(inst.document_expires_at)}` : "cumprida";
  const hoje = new Date(); hoje.setHours(12, 0, 0, 0);
  const due = new Date(`${inst.due_date.slice(0, 10)}T12:00:00`);
  const dias = Math.round((due.getTime() - hoje.getTime()) / DIA);
  if (dias < 0) return `venceu há ${-dias} ${-dias === 1 ? "dia" : "dias"} (${fmtDate(inst.due_date)})`;
  if (dias === 0) return "vence hoje";
  if (dias === 1) return "vence amanhã";
  return `vence em ${dias} dias (${fmtDate(inst.due_date)})`;
}

export function scheduleText(t: Pick<Template, "frequency" | "due_day" | "due_month" | "due_month_offset" | "validity_months">) {
  if (t.frequency === "mensal" && t.due_day) {
    return `todo mês, dia ${t.due_day}${t.due_month_offset === 0 ? " do próprio mês" : t.due_month_offset === 1 ? " do mês seguinte" : ` (${t.due_month_offset} meses depois)`}`;
  }
  if (t.frequency === "anual" && t.due_day && t.due_month) return `todo ano, ${t.due_day} de ${MESES[t.due_month - 1]}`;
  if (t.validity_months) return `documento vale ${t.validity_months} ${t.validity_months === 1 ? "mês" : "meses"}`;
  if (t.frequency === "evento") return "a cada ocorrência";
  if (t.frequency === "unica") return "uma vez, com a validade do documento";
  return "sem vencimento automático";
}

export function friendly(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, "");
  if (!e?.response) return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  return fallback;
}
