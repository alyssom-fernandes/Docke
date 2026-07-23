import { useEffect, useRef, useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import ActivityFeed from "@/components/shared/ActivityFeed";

export default function Activity() {
  usePageTitle("Atividade");
  const { current } = useCompany();
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
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
            <div className="popover-tail-right absolute top-full right-0 mt-1 w-40 glass-panel glass-blur-strong rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50">
              <button
                onClick={() => exportActivity("csv")}
                className="w-full text-left px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white transition-colors duration-fast"
              >
                CSV
              </button>
              <button
                onClick={() => exportActivity("xlsx")}
                className="w-full text-left px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white transition-colors duration-fast"
              >
                Excel (.xlsx)
              </button>
            </div>
          )}
        </div>
      </div>

      {current && <ActivityFeed companyId={current.id} page={page} pageSize={PAGE_SIZE} onLoaded={setTotal} />}

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
    </div>
  );
}
