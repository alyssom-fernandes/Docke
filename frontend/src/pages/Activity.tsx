import { useEffect, useRef, useState } from "react";
import { Clock, Download, ChevronDown } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import Avatar from "@/components/ui/Avatar";
import EmptyState from "@/components/shared/EmptyState";

interface ActivityEvent {
  id: string;
  action: string;
  item_type: string;
  item_name_snapshot: string;
  user_name: string;
  created_at: string;
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

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Activity() {
  usePageTitle("Atividade");
  const { current } = useCompany();
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
    <div className="max-w-[900px] mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Atividade</h1>
        <div className="relative" ref={exportRef}>
          <button
            onClick={() => setExportOpen((v) => !v)}
            className="flex items-center gap-1.5 h-8 px-3 text-sm text-[var(--text-secondary)] border border-[var(--border-default)] rounded-[8px] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
          >
            <Download className="w-3.5 h-3.5" />
            Exportar
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          {exportOpen && (
            <div className="absolute top-full right-0 mt-1 w-40 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] shadow-dropdown py-1 z-50">
              <button
                onClick={() => exportActivity("csv")}
                className="w-full text-left px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
              >
                CSV
              </button>
              <button
                onClick={() => exportActivity("xlsx")}
                className="w-full text-left px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
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
            <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] animate-pulse" />
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
          <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
            <ul>
              {events.map((ev) => (
                <li
                  key={ev.id}
                  className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0"
                >
                  <Avatar name={ev.user_name} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[var(--text-primary)] truncate">
                      <span className="font-medium">{ev.user_name}</span>{" "}
                      {ACTION_LABELS[ev.action] ?? ev.action}{" "}
                      <span className="text-[var(--text-secondary)]">{ev.item_name_snapshot}</span>
                    </p>
                  </div>
                  <span className="text-xs text-[var(--text-tertiary)] flex-shrink-0">
                    {fmtDateTime(ev.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="h-8 px-3 text-sm border border-[var(--border-default)] rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
              >
                Anterior
              </button>
              <span className="text-sm text-[var(--text-secondary)]">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="h-8 px-3 text-sm border border-[var(--border-default)] rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast"
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
