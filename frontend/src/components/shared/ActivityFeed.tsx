import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, ChevronDown, ChevronRight, Clock, RefreshCw } from "lucide-react";
import api from "@/lib/api";
import { fullDate, dateGroupLabel, relativeDate } from "@/lib/date";
import Avatar from "@/components/ui/Avatar";
import EmptyState from "@/components/shared/EmptyState";

export interface ActivityEvent {
  id: string;
  action: string;
  item_type: string;
  item_id: string;
  item_name_snapshot: string;
  current_folder_id: string | null;
  user_id: string;
  user_name: string;
  metadata: Record<string, any> | null;
  created_at: string;
}

interface ActivityResponse {
  results: ActivityEvent[];
  total: number;
}

export interface ActivityFilters {
  userId?: string;
  action?: string;
  itemType?: string;
  dateFrom?: string;
  dateTo?: string;
  /** Esconde visualizações e downloads (resumos, como o do Início). */
  semAcessos?: boolean;
}

// Narrativa em português, nunca o código bruto da ação.
export const ACTION_LABELS: Record<string, string> = {
  upload: "enviou",
  view: "abriu",
  move: "moveu",
  rename: "renomeou",
  delete: "excluiu",
  restore: "restaurou",
  download: "baixou",
  favorite: "ancorou",
  unfavorite: "desancorou",
  undo: "desfez uma ação em",
  copy: "copiou a estrutura de",
  update_metadata: "atualizou um campo de",
  version_delete: "excluiu uma versão de",
  obligation_create: "cadastrou a obrigação",
  obligation_update: "alterou a obrigação",
  obligation_archive: "arquivou a obrigação",
  obligation_restore: "reativou a obrigação",
  obligation_generate: "abriu a competência",
  obligation_link: "enviou documento para",
  obligation_unlink: "tirou documento de",
  obligation_approve: "aprovou",
  obligation_return: "devolveu para correção",
  obligation_dispense: "dispensou",
  obligation_cancel: "cancelou",
  obligation_reopen: "reabriu",
  obligation_assign: "trocou o responsável de",
  obligation_dependency_add: "ligou uma dependência em",
  obligation_dependency_remove: "desligou uma dependência de",
  retention_policy_create: "cadastrou o prazo de guarda",
  retention_policy_update: "alterou o prazo de guarda",
  retention_policy_archive: "arquivou o prazo de guarda",
  retention_assign: "atribuiu o prazo",
  retention_unassign: "removeu o prazo",
  retention_hold_create: "bloqueou judicialmente",
  retention_hold_release: "liberou o bloqueio de",
  retention_queue_approved: "aprovou o descarte de",
  retention_queue_rejected: "manteve",
  retention_queue_deferred: "adiou a decisão sobre",
};

/** Verbo para o resumo de um grupo de eventos iguais ("enviou 5 documentos"). */
const GROUP_VERB: Record<string, string> = {
  upload: "enviou", view: "abriu", move: "moveu", rename: "renomeou", delete: "excluiu",
  restore: "restaurou", download: "baixou", favorite: "ancorou", unfavorite: "desancorou",
  update_metadata: "atualizou metadados de", version_delete: "excluiu versões de",
};

// Eventos consecutivos do mesmo usuário dentro dessa janela viram um item só.
const CLUSTER_WINDOW_MS = 3 * 60 * 1000;

interface Cluster {
  key: string;
  userId: string;
  userName: string;
  events: ActivityEvent[];
}

function clusterEvents(events: ActivityEvent[]): Cluster[] {
  const clusters: Cluster[] = [];
  for (const ev of events) {
    const last = clusters[clusters.length - 1];
    if (last && last.userId === ev.user_id) {
      const lastTs = new Date(last.events[last.events.length - 1].created_at).getTime();
      if (Math.abs(lastTs - new Date(ev.created_at).getTime()) <= CLUSTER_WINDOW_MS) {
        last.events.push(ev);
        continue;
      }
    }
    clusters.push({ key: ev.id, userId: ev.user_id, userName: ev.user_name, events: [ev] });
  }
  return clusters;
}

/** "enviou 5 documentos: Nota 1.pdf, Nota 2.pdf e mais 3" em vez de "fez 5 alterações" (A3-29). */
function clusterSummary(c: Cluster): { verbo: string; nomes: string } {
  const actions = new Set(c.events.map((e) => e.action));
  const itens = [...new Map(c.events.map((e) => [e.item_id, e])).values()];
  const nomes = itens.slice(0, 2).map((e) => e.item_name_snapshot).join(", ") + (itens.length > 2 ? ` e mais ${itens.length - 2}` : "");
  if (actions.size === 1 && itens.length === 1) {
    const a = c.events[0].action;
    return { verbo: `${ACTION_LABELS[a] ?? a} ${itens[0].item_name_snapshot} ${c.events.length} vezes`, nomes: "" };
  }
  if (actions.size === 1) {
    const a = c.events[0].action;
    const pastas = itens.every((e) => e.item_type === "folder");
    const n = itens.length;
    const noun = pastas ? (n === 1 ? "pasta" : "pastas") : n === 1 ? "documento" : "documentos";
    return { verbo: `${GROUP_VERB[a] ?? ACTION_LABELS[a] ?? a} ${n} ${noun}`, nomes };
  }
  return { verbo: `fez ${c.events.length} alterações em`, nomes };
}

/** Destino do deep-link, ou null se o item não existe mais. */
export function activityTarget(ev: ActivityEvent): string | null {
  if (ev.item_type === "retention") return "/settings/retention";
  if (ev.item_type === "obligation") {
    return ev.metadata?.tipo === "competencia" ? `/obligations?instancia=${ev.item_id}` : "/obligations?aba=configuracao";
  }
  if (ev.item_type === "folder") return `/documents?folder_id=${ev.item_id}`;
  if (ev.item_type === "document" && ev.current_folder_id) {
    return `/documents?folder_id=${ev.current_folder_id}&doc=${ev.item_id}`;
  }
  return null;
}

function EventDetail({ ev }: { ev: ActivityEvent }) {
  if (ev.action === "update_metadata" && ev.metadata?.field_label) {
    return (
      <p className="text-mac-caption text-(--text-secondary) mt-1 pl-9">
        <span className="font-medium">{ev.metadata.field_label}:</span>{" "}
        <span className="line-through">{ev.metadata.old_value || "vazio"}</span>
        {" → "}
        <span className="text-(--text-primary)">{ev.metadata.new_value}</span>
      </p>
    );
  }
  if (ev.action === "rename" && ev.metadata?.de) {
    return (
      <p className="text-mac-caption text-(--text-secondary) mt-1 pl-9 truncate">
        <span className="line-through">{ev.metadata.de}</span> → <span className="text-(--text-primary)">{ev.metadata.para}</span>
      </p>
    );
  }
  if (ev.metadata && Object.keys(ev.metadata).length > 0) {
    return (
      <p className="text-mac-caption text-(--text-secondary) mt-1 pl-9 truncate">
        {Object.entries(ev.metadata).map(([k, v]) => `${k}: ${v}`).join(" · ")}
      </p>
    );
  }
  return null;
}

function timeLabel(iso: string, relative: boolean) {
  return relative ? relativeDate(iso) : new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function EventRow({ ev, onNavigate, relative }: { ev: ActivityEvent; onNavigate: (target: string) => void; relative: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const target = activityTarget(ev);
  const hasDetail = !!(ev.metadata && Object.keys(ev.metadata).length > 0);
  const texto = (
    <>
      <span className="font-medium">{ev.user_name}</span> {ACTION_LABELS[ev.action] ?? ev.action}{" "}
      <span className="text-(--text-secondary)">{ev.item_name_snapshot}</span>
    </>
  );

  return (
    <li className="px-4 sm:px-5 py-2.5 border-b border-(--border-default) last:border-0">
      <div className="flex items-center gap-3 min-h-8">
        <Avatar name={ev.user_name} size="sm" />
        {target ? (
          <button
            onClick={() => onNavigate(target)}
            className="flex-1 min-w-0 text-left text-mac-body text-(--text-primary) line-clamp-2 rounded-[6px] hover:underline underline-offset-2 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
          >
            {texto}
          </button>
        ) : (
          <p className="flex-1 min-w-0 text-mac-body text-(--text-primary) line-clamp-2" title="O item não existe mais">{texto}</p>
        )}
        {hasDetail && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1 pointer-coarse:p-2.5 rounded-full text-(--text-secondary) hover:bg-(--bg-hover) transition-colors duration-fast shrink-0"
            aria-label={expanded ? "Ocultar detalhes" : "Ver detalhes"}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        )}
        <time dateTime={ev.created_at} className="text-mac-caption text-(--text-secondary) shrink-0" title={fullDate(ev.created_at)}>
          {timeLabel(ev.created_at, relative)}
        </time>
      </div>
      {expanded && <EventDetail ev={ev} />}
    </li>
  );
}

function ClusterRow({ cluster, onNavigate, relative }: { cluster: Cluster; onNavigate: (target: string) => void; relative: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const latest = cluster.events[0];

  if (cluster.events.length === 1) return <EventRow ev={latest} onNavigate={onNavigate} relative={relative} />;
  const { verbo, nomes } = clusterSummary(cluster);

  return (
    <li className="border-b border-(--border-default) last:border-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 sm:px-5 py-2.5 min-h-11 text-left hover:bg-(--bg-hover) transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)"
      >
        <Avatar name={cluster.userName} size="sm" />
        <p className="flex-1 min-w-0 text-mac-body text-(--text-primary) line-clamp-2">
          <span className="font-medium">{cluster.userName}</span> {verbo}
          {nomes && <span className="text-(--text-secondary)">: {nomes}</span>}
        </p>
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-(--text-secondary)" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5 text-(--text-secondary)" aria-hidden="true" />}
        <time dateTime={latest.created_at} className="text-mac-caption text-(--text-secondary) shrink-0" title={fullDate(latest.created_at)}>
          {timeLabel(latest.created_at, relative)}
        </time>
      </button>
      {expanded && (
        <ul className="bg-(--bg-hover)/40">
          {cluster.events.map((ev) => <EventRow key={ev.id} ev={ev} onNavigate={onNavigate} relative={relative} />)}
        </ul>
      )}
    </li>
  );
}

/**
 * Componente único da trilha (documento, pasta, empresa e Início). Falha de
 * carga mostra erro com "Tentar de novo", nunca "Nenhuma atividade" (A3-03).
 * `embedded` desenha só a lista, para caber num cartão de outra tela.
 */
export default function ActivityFeed({
  companyId,
  itemId,
  page = 1,
  pageSize = 25,
  groupByDay = true,
  emptyDescription = "As ações realizadas nos documentos aparecerão aqui.",
  onLoaded,
  filters,
  embedded = false,
  refreshKey = 0,
}: {
  companyId: string;
  itemId?: string;
  page?: number;
  pageSize?: number;
  groupByDay?: boolean;
  emptyDescription?: string;
  onLoaded?: (total: number) => void;
  filters?: ActivityFilters;
  embedded?: boolean;
  refreshKey?: number;
}) {
  const navigate = useNavigate();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const f = filters ?? {};

  useEffect(() => {
    if (!companyId) return;
    let alive = true;
    setFailed(false);
    api
      .get<ActivityResponse>("/activity", {
        params: {
          company_id: companyId, item_id: itemId, page, page_size: pageSize,
          user_id: f.userId || undefined, action: f.action || undefined, item_type: f.itemType || undefined,
          date_from: f.dateFrom || undefined, date_to: f.dateTo || undefined, sem_acessos: f.semAcessos || undefined,
        },
      })
      .then((r) => { if (!alive) return; setEvents(r.data.results ?? []); onLoaded?.(r.data.total ?? 0); })
      .catch(() => { if (!alive) return; setFailed(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, itemId, page, pageSize, f.userId, f.action, f.itemType, f.dateFrom, f.dateTo, f.semAcessos, retry, refreshKey]);

  if (failed && !events) {
    return (
      <div role="alert" className={`flex flex-wrap items-center gap-3 ${embedded ? "px-5 py-4" : "glass-panel glass-blur-card rounded-(--radius-panel) p-5"}`}>
        <AlertTriangle className="w-4 h-4 text-(--text-warning)" aria-hidden="true" />
        <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar a atividade agora.</p>
        <button onClick={() => setRetry((n) => n + 1)} className="inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover)">
          <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo
        </button>
      </div>
    );
  }

  if (!events) {
    return (
      <div className={embedded ? "p-4 space-y-2" : "space-y-2"} aria-label="Carregando atividade">
        {Array.from({ length: Math.min(pageSize, 5) }, (_, i) => (
          <div key={i} className={`${embedded ? "h-9" : "h-14"} bg-(--bg-hover) rounded-(--radius-control) animate-pulse`} />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return embedded ? (
      <p className="px-5 py-6 text-mac-body text-(--text-secondary) flex items-center gap-2"><Clock className="w-4 h-4" aria-hidden="true" /> {emptyDescription}</p>
    ) : (
      <EmptyState title="Nenhuma atividade" description={emptyDescription} icon={<Clock className="w-6 h-6" />} />
    );
  }

  if (embedded) {
    return (
      <ul>
        {clusterEvents(events).map((c) => <ClusterRow key={c.key} cluster={c} onNavigate={navigate} relative />)}
      </ul>
    );
  }

  const groups: { label: string; items: ActivityEvent[] }[] = groupByDay
    ? (() => {
        const g: { label: string; items: ActivityEvent[] }[] = [];
        for (const ev of events) {
          const label = dateGroupLabel(ev.created_at);
          const last = g[g.length - 1];
          if (last && last.label === label) last.items.push(ev);
          else g.push({ label, items: [ev] });
        }
        return g;
      })()
    : [{ label: "", items: events }];

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.label || "all"} aria-label={group.label || undefined}>
          {group.label && (
            <h2 className="px-1 pb-1.5 text-mac-caption font-semibold text-(--text-secondary) uppercase tracking-wide">
              {group.label}
            </h2>
          )}
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden">
            <ul>
              {clusterEvents(group.items).map((c) => (
                <ClusterRow key={c.key} cluster={c} onNavigate={navigate} relative={!groupByDay} />
              ))}
            </ul>
          </div>
        </section>
      ))}
    </div>
  );
}
