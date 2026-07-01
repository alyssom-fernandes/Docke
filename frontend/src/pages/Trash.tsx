import { useEffect, useState } from "react";
import { FolderOpen, Trash2, RotateCcw } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import { usePageTitle } from "@/hooks/usePageTitle";
import { fullDate } from "@/lib/date";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import EmptyState from "@/components/shared/EmptyState";

interface TrashItem {
  id: string;
  item_type: "document" | "folder";
  name: string;
  deleted_at: string;
}

interface TrashResponse {
  documents: TrashItem[];
  folders: TrashItem[];
  total: number;
}

const fmtDate = fullDate;

export default function Trash() {
  usePageTitle("Lixeira");
  const { current } = useCompany();
  const { success, error: showError } = useToast();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);

  function load() {
    if (!current) return;
    setLoading(true);
    api
      .get<TrashResponse>("/trash", { params: { company_id: current.id } })
      .then((r) => {
        const docs = r.data.documents ?? [];
        const folders = r.data.folders ?? [];
        setItems(Array.isArray(r.data) ? r.data : [...docs, ...folders]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, [current?.id]);

  async function restore(item: TrashItem) {
    try {
      await api.post(`/trash/${item.id}/restore`, null, { params: { item_type: item.item_type } });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      success(`"${item.name}" restaurado.`);
    } catch {
      showError("Não foi possível restaurar o item.");
    }
  }

  return (
    <div className="max-w-[800px] mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">Lixeira</h1>
        {items.length > 0 && (
          <p className="text-sm text-[var(--text-secondary)]">{items.length} ite{items.length !== 1 ? "ns" : "m"}</p>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Lixeira vazia"
          description="Documentos e pastas excluídos aparecerão aqui."
          icon={<Trash2 className="w-6 h-6" />}
        />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
          <ul>
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0 group"
              >
                {item.item_type === "folder" ? (
                  <FolderOpen className="w-4 h-4 text-teal-500 flex-shrink-0" />
                ) : (
                  (() => { const s = getFileStyle(item.name); const Icon = s.icon; return (
                    <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-3.5 h-3.5 ${s.iconColor}`} />
                    </div>
                  ); })()
                )}
                <span className="flex-1 text-sm text-[var(--text-primary)] truncate">{item.name}</span>
                <span className="text-xs text-[var(--text-tertiary)] mr-2">
                  Excluído em {fmtDate(item.deleted_at)}
                </span>
                <button
                  onClick={() => restore(item)}
                  className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-xs text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-all duration-fast"
                  title="Restaurar"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Restaurar
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
