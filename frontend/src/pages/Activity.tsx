import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Clock, Download, ChevronDown } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { relativeDate, fullDate } from "@/lib/date";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import Avatar from "@/components/ui/Avatar";
import EmptyState from "@/components/shared/EmptyState";

interface ActivityEvent {
  id: string;
  action: string;
  item_type: string;
  item_id: string;
  item_name_snapshot: string;
  current_folder_id: string | null;
  user_name: string;
  created_at: string;
}

/** Retorna o destino do deep-link, ou null se o item não existe mais (ex.:
 * documento excluído permanentemente depois do evento) — nesse caso a linha
 * não é clicável em vez de navegar pra um lugar que não vai achar nada. */
function activityTarget(ev: ActivityEvent): string | null {
  if (ev.item_type === "folder") return `/documents?folder_id=${ev.item_id}`;
  if (ev.item_type === "document" && ev.current_folder_id) {
    return `/documents?folder_id=${ev.current_folder_id}&doc=${ev.item_id}`;
  }
  return null;
}

interface ActivityResponse {
  results: ActivityEvent[];
  items?: ActivityEvent[];
  total: number;
}

const ACTION_LABELS: Record<string, string> = {
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
};

export default function Activity() {
  usePageTitle("Atividade");
  const { current } = useCompany();
  const navigate = useNavigate();
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);
  const PAGE_SIZE = 25;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setExportOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    if (!current) return;
    setLoading(true);
    api
      .get<ActivityResponse>("/activity", {
        params: { company_id: current.id, page, page_size: PAGE_SIZE },
      })
      .then((r) => {
        setEvents(r.data.results ?? r.data.items ?? []);
        setTotal(r.data.total ?? 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [current?.id, page]);

  async function exportActivity(format: "csv" | "xlsx") {
    if (!current) return;
    setExportOpen(false);
    const r = await api.get("/activity/export", {
      params: { company_id: current.id, format },
      responseType: "blob",
    });
    const url = URL.createObjectURL(r.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = `atividade_${current.name}_${new Date().toISOString().slice(0, 10)}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-mac-title2 font-semibold text-[var(--text-primary)]">Atividade</h1>
        <div className="relative" ref={exportRef}>
          <button
            onClick={() => setExportOpen((v) => !v)}
            className="flex items-center gap-1.5 h-8 px-3.5 text-mac-body text-[var(--text-secondary)] border border-[var(--border-default)] rounded-full hover:bg-[var(--bg-hover)] transition-colors duration-fast"
          >
            <Download className="w-3.5 h-3.5" />
            Exportar
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {exportOpen && (
            <div className="absolute top-full right-0 mt-1 w-40 glass-panel glass-blur-strong rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50">
              <button
                onClick={() => exportActivity("csv")}
                className="w-full text-left px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
              >
                CSV
              </button>
              <button
                onClick={() => exportActivity("xlsx")}
                className="w-full text-left px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
              >
                Excel (.xlsx)
              </button>
            </div>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
          ))}
        </div>
      ) : events.length === 0 ? (
        <EmptyState
          title="Nenhuma atividade"
          description="As ações realizadas nos documentos aparecerão aqui."
          icon={<Clock className="w-6 h-6" />}
        />
      ) : (
        <>
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
            <ul>
              {events.map((ev) => {
                const target = activityTarget(ev);
                return (
                  <li
                    key={ev.id}
                    role={target ? "button" : undefined}
                    tabIndex={target ? 0 : undefined}
                    onClick={target ? () => navigate(target) : undefined}
                    onKeyDown={
                      target
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              navigate(target);
                            }
                          }
                        : undefined
                    }
                    title={target ? undefined : "Item não está mais disponível"}
                    className={`flex items-center gap-3 px-5 py-3 transition-colors duration-fast border-b border-[var(--border-default)] last:border-0 ${
                      target ? "hover:bg-[var(--bg-hover)] cursor-pointer" : ""
                    }`}
                  >
                    <Avatar name={ev.user_name} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-mac-body text-[var(--text-primary)] truncate">
                        <span className="font-medium">{ev.user_name}</span>{" "}
                        {ACTION_LABELS[ev.action] ?? ev.action}{" "}
                        <span className="text-[var(--text-secondary)]">{ev.item_name_snapshot}</span>
                      </p>
                    </div>
                    <span className="text-mac-caption text-[var(--text-tertiary)] flex-shrink-0" title={fullDate(ev.created_at)}>
                      {relativeDate(ev.created_at)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="h-8 px-3.5 text-mac-body border border-[var(--border-default)] rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
              >
                Anterior
              </button>
              <span className="text-mac-body text-[var(--text-secondary)]">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="h-8 px-3.5 text-mac-body border border-[var(--border-default)] rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
              >
                Próxima
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
