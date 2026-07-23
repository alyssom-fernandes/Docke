import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Clock } from "lucide-react";
import api from "@/lib/api";
import { fullDate, dateGroupLabel } from "@/lib/date";
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

// Fase 2.3: narrativa em português, nunca o código bruto da ação — ninguém
// deveria precisar saber o que "DOCUMENT_METADATA_UPDATE" significa.
export const ACTION_LABELS: Record<string, string> = {
  upload: "enviou",
  view: "visualizou",
  move: "moveu",
  rename: "renomeou",
  delete: "excluiu",
  restore: "restaurou",
  download: "baixou",
  favorite: "ancorou",
  unfavorite: "desancorou",
  undo: "desfez",
  copy: "copiou a estrutura para",
  update_metadata: "atualizou um campo de",
};

// Fase 2.5: eventos consecutivos do mesmo usuário dentro dessa janela viram
// um único item agrupado ("Maria fez 5 alterações · 09:31") em vez de
// inundar a timeline — sem isso, um preenchimento de formulário inteiro
// (autosave por campo, Fase 1.5) gera uma linha por campo.
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
      const thisTs = new Date(ev.created_at).getTime();
      if (Math.abs(lastTs - thisTs) <= CLUSTER_WINDOW_MS) {
        last.events.push(ev);
        continue;
      }
    }
    clusters.push({ key: ev.id, userId: ev.user_id, userName: ev.user_name, events: [ev] });
  }
  return clusters;
}

/** Destino do deep-link, ou null se o item não existe mais. */
function activityTarget(ev: ActivityEvent): string | null {
  if (ev.item_type === "folder") return `/documents?folder_id=${ev.item_id}`;
  if (ev.item_type === "document" && ev.current_folder_id) {
    return `/documents?folder_id=${ev.current_folder_id}&doc=${ev.item_id}`;
  }
  return null;
}

function EventDetail({ ev }: { ev: ActivityEvent }) {
  // Fase 2.4: before/after — só update_metadata guarda esse formato hoje;
  // outras ações com metadata (ex.: move → target_folder_id) caem no
  // fallback genérico abaixo.
  if (ev.action === "update_metadata" && ev.metadata?.field_label) {
    return (
      <p className="text-mac-caption text-[var(--text-secondary)] mt-1 pl-9">
        <span className="font-medium">{ev.metadata.field_label}:</span>{" "}
        <span className="line-through text-[var(--text-tertiary)]">{ev.metadata.old_value || "vazio"}</span>
        {" → "}
        <span className="text-[var(--text-primary)]">{ev.metadata.new_value}</span>
      </p>
    );
  }
  if (ev.metadata && Object.keys(ev.metadata).length > 0) {
    return (
      <p className="text-mac-caption text-[var(--text-tertiary)] mt-1 pl-9 truncate">
        {Object.entries(ev.metadata).map(([k, v]) => `${k}: ${v}`).join(" · ")}
      </p>
    );
  }
  return null;
}

function EventRow({ ev, onNavigate }: { ev: ActivityEvent; onNavigate: (target: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const target = activityTarget(ev);
  const hasDetail = !!(ev.metadata && Object.keys(ev.metadata).length > 0);

  return (
    <li className="px-5 py-3 border-b border-[var(--border-default)] last:border-0">
      <div className="flex items-center gap-3">
        <Avatar name={ev.user_name} size="sm" />
        <div
          className={`flex-1 min-w-0 ${target ? "cursor-pointer" : ""}`}
          onClick={target ? () => onNavigate(target) : undefined}
        >
          <p className="text-mac-body text-[var(--text-primary)] line-clamp-2">
            <span className="font-medium">{ev.user_name}</span>{" "}
            {ACTION_LABELS[ev.action] ?? ev.action}{" "}
            <span className="text-[var(--text-secondary)]">{ev.item_name_snapshot}</span>
          </p>
        </div>
        {hasDetail && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast flex-shrink-0"
            aria-label={expanded ? "Ocultar detalhes" : "Ver detalhes"}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
        )}
        <span className="text-mac-caption text-[var(--text-tertiary)] flex-shrink-0" title={fullDate(ev.created_at)}>
          {new Date(ev.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      {expanded && <EventDetail ev={ev} />}
    </li>
  );
}

function ClusterRow({ cluster, onNavigate }: { cluster: Cluster; onNavigate: (target: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const latest = cluster.events[0];

  if (cluster.events.length === 1) return <EventRow ev={latest} onNavigate={onNavigate} />;

  return (
    <li className="border-b border-[var(--border-default)] last:border-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-[var(--bg-hover)] transition-colors duration-fast"
      >
        <Avatar name={cluster.userName} size="sm" />
        <div className="flex-1 min-w-0">
          <p className="text-mac-body text-[var(--text-primary)]">
            <span className="font-medium">{cluster.userName}</span> fez {cluster.events.length} alterações
          </p>
        </div>
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-tertiary)]" /> : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />}
        <span className="text-mac-caption text-[var(--text-tertiary)] flex-shrink-0" title={fullDate(latest.created_at)}>
          {new Date(latest.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </button>
      {expanded && (
        <ul className="bg-[var(--bg-hover)]/40">
          {cluster.events.map((ev) => <EventRow key={ev.id} ev={ev} onNavigate={onNavigate} />)}
        </ul>
      )}
    </li>
  );
}

/**
 * Fase 2.6: componente único reusado nos 3 escopos (documento, pasta,
 * administração/empresa toda) — o que muda é só o filtro inicial (itemId).
 */
export default function ActivityFeed({
  companyId,
  itemId,
  page = 1,
  pageSize = 25,
  groupByDay = true,
  emptyDescription = "As ações realizadas nos documentos aparecerão aqui.",
  onLoaded,
}: {
  companyId: string;
  itemId?: string;
  page?: number;
  pageSize?: number;
  groupByDay?: boolean;
  emptyDescription?: string;
  onLoaded?: (total: number) => void;
}) {
  const navigate = useNavigate();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!companyId) return;
    setLoading(true);
    api
      .get<ActivityResponse & { total: number }>("/activity", { params: { company_id: companyId, item_id: itemId, page, page_size: pageSize } })
      .then((r) => { setEvents(r.data.results ?? []); onLoaded?.(r.data.total ?? 0); })
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, itemId, page, pageSize]);

  if (loading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
        ))}
      </div>
    );
  }

  if (events.length === 0) {
    return <EmptyState title="Nenhuma atividade" description={emptyDescription} icon={<Clock className="w-6 h-6" />} />;
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
        <div key={group.label || "all"}>
          {group.label && (
            <h2 className="px-1 pb-1.5 text-mac-caption font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
              {group.label}
            </h2>
          )}
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
            <ul>
              {clusterEvents(group.items).map((c) => (
                <ClusterRow key={c.key} cluster={c} onNavigate={navigate} />
              ))}
            </ul>
          </div>
        </div>
      ))}
    </div>
  );
}
