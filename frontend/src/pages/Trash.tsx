import { useEffect, useState } from "react";
import { FolderOpen, Trash2, RotateCcw, X } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import { usePageTitle } from "@/hooks/usePageTitle";
import { fullDate } from "@/lib/date";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import EmptyState from "@/components/shared/EmptyState";
import ConfirmModal from "@/components/ui/ConfirmModal";

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmSingle, setConfirmSingle] = useState<TrashItem | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
      setSelected((prev) => { const next = new Set(prev); next.delete(item.id); return next; });
      success(`"${item.name}" restaurado.`);
    } catch {
      showError("Não foi possível restaurar o item.");
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function permanentlyDeleteOne(item: TrashItem) {
    setDeleting(true);
    try {
      await api.delete(`/trash/${item.id}/permanent`, { params: { item_type: item.item_type, confirm: true } });
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setSelected((prev) => { const next = new Set(prev); next.delete(item.id); return next; });
      success(`"${item.name}" excluído permanentemente.`);
      setConfirmSingle(null);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível excluir permanentemente.");
    } finally {
      setDeleting(false);
    }
  }

  async function permanentlyDeleteBulk() {
    setDeleting(true);
    const targets = items.filter((i) => selected.has(i.id));
    let okCount = 0;
    for (const item of targets) {
      try {
        await api.delete(`/trash/${item.id}/permanent`, { params: { item_type: item.item_type, confirm: true } });
        okCount++;
      } catch {
        // segue tentando os demais — reporta ao final quantos deram certo
      }
    }
    setItems((prev) => prev.filter((i) => !selected.has(i.id)));
    setSelected(new Set());
    setDeleting(false);
    setConfirmBulk(false);
    if (okCount === targets.length) {
      success(`${okCount} ite${okCount !== 1 ? "ns excluídos" : "m excluído"} permanentemente.`);
    } else {
      showError(`${okCount} de ${targets.length} itens excluídos. Alguns falharam.`);
    }
  }

  return (
    <div className="space-y-6 pb-16">
      <div className="flex items-center justify-between">
        <h1 className="text-mac-title2 font-semibold text-[var(--text-primary)]">Lixeira</h1>
        {items.length > 0 && (
          <p className="text-mac-body text-[var(--text-secondary)]">{items.length} ite{items.length !== 1 ? "ns" : "m"}</p>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Lixeira vazia"
          description="Documentos e pastas excluídos aparecerão aqui."
          icon={<Trash2 className="w-6 h-6" />}
        />
      ) : (
        <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
          <ul>
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0 group"
              >
                <input
                  type="checkbox"
                  checked={selected.has(item.id)}
                  onChange={() => toggleSelect(item.id)}
                  className="w-4 h-4 rounded accent-teal-500 flex-shrink-0"
                  aria-label={`Selecionar ${item.name}`}
                />
                {item.item_type === "folder" ? (
                  <FolderOpen className="w-4 h-4 text-teal-500 flex-shrink-0" />
                ) : (
                  (() => { const s = getFileStyle(item.name); const Icon = s.icon; return (
                    <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-3.5 h-3.5 ${s.iconColor}`} />
                    </div>
                  ); })()
                )}
                <span className="flex-1 text-mac-body text-[var(--text-primary)] truncate">{item.name}</span>
                <span className="text-mac-caption text-[var(--text-tertiary)] mr-2">
                  Excluído em {fmtDate(item.deleted_at)}
                </span>
                <button
                  onClick={() => restore(item)}
                  className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2.5 py-1 rounded-full text-mac-caption text-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/20 transition-all duration-fast"
                  title="Restaurar"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Restaurar
                </button>
                <button
                  onClick={() => setConfirmSingle(item)}
                  className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2.5 py-1 rounded-full text-mac-caption text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-fast"
                  title="Excluir permanentemente"
                >
                  <X className="w-3.5 h-3.5" />
                  Excluir
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Barra de ações em lote */}
      {selected.size > 0 && (
        <div className="glass-panel glass-blur-pill fixed bottom-[76px] md:bottom-7 lg:bottom-[100px] left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-[50px] pl-[18px] pr-1.5 py-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.55)] z-40">
          <span className="text-mac-body text-[var(--text-primary)]">{selected.size} selecionado{selected.size !== 1 ? "s" : ""}</span>
          <button
            onClick={() => setConfirmBulk(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-mac-body text-white bg-red-600 hover:bg-red-500 transition-colors duration-fast"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Excluir permanentemente
          </button>
        </div>
      )}

      {/* Confirmação — nível Médio (item único) */}
      {confirmSingle && (
        <ConfirmModal
          title={`Excluir "${confirmSingle.name}" permanentemente?`}
          description="Esta ação não tem volta — o arquivo é removido do banco e do armazenamento."
          confirmLabel="Excluir permanentemente"
          danger
          loading={deleting}
          onConfirm={() => permanentlyDeleteOne(confirmSingle)}
          onClose={() => setConfirmSingle(null)}
        />
      )}

      {/* Confirmação — nível Alto (lote, exige digitar CONFIRMAR) */}
      {confirmBulk && (
        <ConfirmModal
          title={`Excluir ${selected.size} itens permanentemente?`}
          description="Esta ação não tem volta. Os itens são removidos do banco e do armazenamento."
          confirmLabel="Excluir permanentemente"
          danger
          requireTypedConfirmation
          loading={deleting}
          onConfirm={permanentlyDeleteBulk}
          onClose={() => setConfirmBulk(false)}
        />
      )}
    </div>
  );
}
