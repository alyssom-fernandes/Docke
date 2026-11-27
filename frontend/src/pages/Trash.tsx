import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Trash2, RotateCcw, AlertTriangle, RefreshCw, Lock } from "lucide-react";
import { ItemIcon } from "@/lib/fileType";
import { relativeDate, fullDate } from "@/lib/date";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { pushUndo } from "@/lib/undo";
import EmptyState from "@/components/shared/EmptyState";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import { PageHeader } from "@/components/layout/window";
import { InspectorLayout, useInspectorTarget, useLargo } from "@/components/shared/ListInspector";

interface TrashItem {
  id: string;
  item_type: "document" | "folder";
  name: string;
  deleted_at: string;
  trash_expires_at?: string | null;
  original_path?: string | null;
  original_folder_name?: string | null;
  original_folder_deleted?: boolean;
  deleted_by_name?: string | null;
  document_count?: number;
  bloqueio?: "legal_hold" | "retencao" | null;
}
interface TrashResponse { documents: TrashItem[]; folders: TrashItem[]; total: number }

const DIA = 86_400_000;
function expiresText(iso?: string | null) {
  if (!iso) return null;
  const dias = Math.ceil((new Date(iso).getTime() - Date.now()) / DIA);
  if (dias <= 0) return "sai da lixeira hoje";
  return `sai da lixeira em ${dias} ${dias === 1 ? "dia" : "dias"}`;
}

/**
 * Lixeira (A6-31, A6-36, A6-T1, A6-T2): quando cada item é apagado de vez,
 * de onde veio e quem excluiu; bloqueios explicados; restaurar diz para
 * onde volta; exclusão definitiva em lote com progresso e resumo.
 */
export default function Trash() {
  const insp = useInspectorTarget();
  const largo = useLargo();
  usePageTitle("Lixeira");
  const { current } = useCompany();
  const navigate = useNavigate();
  const { toast, error: showError, success } = useToast();
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<TrashItem[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const isAdmin = ["admin", "supremo"].includes(current?.permission_level ?? "");

  function load() {
    if (!current) return;
    setFailed(false);
    api.get<TrashResponse>("/trash", { params: { company_id: current.id } })
      .then((r) => setItems([...(r.data.folders ?? []), ...(r.data.documents ?? [])].sort((a, b) => b.deleted_at.localeCompare(a.deleted_at))))
      .catch(() => setFailed(true));
  }
  useEffect(load, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    window.addEventListener("docke:desfeito", load);
    return () => window.removeEventListener("docke:desfeito", load);
  });

  const key = (i: TrashItem) => `${i.item_type}:${i.id}`;

  async function restore(item: TrashItem) {
    setBusyId(key(item));
    try {
      const r = await api.post(`/trash/${item.id}/restore`, null, { params: { item_type: item.item_type } });
      setItems((prev) => prev?.filter((i) => key(i) !== key(item)) ?? null);
      const folderId = r.data?.restored_to_folder_id ?? (item.item_type === "folder" ? item.id : null);
      const extra = item.item_type === "folder" && r.data?.restored_documents ? ` com ${r.data.restored_documents} documentos` : "";
      // Desfazer devolve à lixeira (Ctrl+Z); o aviso mantém "Abrir" como ação.
      pushUndo(`restaurar “${item.name}”`, async () => {
        if (item.item_type === "folder") await api.delete(`/folders/${item.id}`);
        else await api.post("/documents/bulk-delete", { document_ids: [item.id] });
      });
      toast({
        type: "success",
        message: `“${item.name}” voltou${extra}${item.original_path ? ` para ${item.original_path}` : ""}. Ctrl+Z desfaz.`,
        action: folderId ? { label: "Abrir", onClick: () => navigate(item.item_type === "folder" ? `/documents?folder_id=${item.id}` : `/documents?folder_id=${folderId}&doc=${item.id}`) } : undefined,
      });
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível restaurar. Tente de novo.");
    } finally {
      setBusyId(null);
    }
  }

  async function restoreSelected() {
    const targets = (items ?? []).filter((i) => sel.has(key(i)));
    setProgress({ done: 0, total: targets.length });
    let ok = 0;
    for (const [n, item] of targets.entries()) {
      try { await api.post(`/trash/${item.id}/restore`, null, { params: { item_type: item.item_type } }); ok++; } catch { /* conta no resumo */ }
      setProgress({ done: n + 1, total: targets.length });
    }
    setProgress(null); setSel(new Set()); load();
    if (ok === targets.length) success(`${ok} ${ok === 1 ? "item restaurado" : "itens restaurados"} para o lugar de origem.`);
    else showError(`${ok} de ${targets.length} restaurados. Os outros continuam na lixeira.`);
  }

  async function deleteForever(targets: TrashItem[]) {
    setProgress({ done: 0, total: targets.length });
    let ok = 0;
    const falhas: string[] = [];
    for (const [n, item] of targets.entries()) {
      try { await api.delete(`/trash/${item.id}/permanent`, { params: { item_type: item.item_type, confirm: true } }); ok++; }
      catch (e: any) { falhas.push(e?.response?.status === 423 ? `${item.name} (bloqueado)` : item.name); }
      setProgress({ done: n + 1, total: targets.length });
    }
    setProgress(null); setDeleting(null); setSel(new Set()); load();
    if (!falhas.length) success(`${ok} ${ok === 1 ? "item apagado" : "itens apagados"} para sempre.`);
    else showError(`${ok} apagados. Não foi possível apagar: ${falhas.slice(0, 3).join(", ")}${falhas.length > 3 ? ` e mais ${falhas.length - 3}` : ""}.`);
  }

  const list = items ?? [];
  const selecionados = useMemo(() => list.filter((i) => sel.has(key(i))), [list, sel]);
  const allOn = list.length > 0 && sel.size === list.length;

  return (
    <div className={`space-y-6 ${largo ? "max-w-[1480px]" : "max-w-[1100px]"} w-full mx-auto`}>
      <PageHeader title="Lixeira" subtitle={items ? `${list.length} ${list.length === 1 ? "item" : "itens"}` : undefined} />
      <p className="text-mac-footnote text-(--text-secondary) mb-3!">O que foi excluído fica aqui por um tempo e volta para o lugar de origem ao restaurar. Depois do prazo, sai sozinho.</p>

      {failed ? (
        <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) flex flex-wrap items-center gap-3 px-5 py-4">
          <AlertTriangle className="w-4 h-4 text-(--text-warning)" aria-hidden="true" />
          <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar a lixeira.</p>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
        </div>
      ) : !items ? (
        <div className="space-y-2" aria-label="Carregando">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>
      ) : list.length === 0 ? (
        <EmptyState title="Lixeira vazia" description="Nada excluído por aqui." icon={<Trash2 className="w-6 h-6" />} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 min-h-9">
            <label className="inline-flex items-center gap-2 text-mac-body text-(--text-primary) mr-2">
              <Checkbox checked={allOn} indeterminate={sel.size > 0 && !allOn} onChange={() => setSel(allOn ? new Set() : new Set(list.map(key)))} /> Todos ({list.length})
            </label>
            {sel.size > 0 && (
              <div className="reveal flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" disabled={!!progress} onClick={restoreSelected}><RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Restaurar {sel.size}</Button>
                {isAdmin && <Button size="sm" variant="danger" disabled={!!progress} onClick={() => setDeleting(selecionados)}><Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> Apagar para sempre</Button>}
              </div>
            )}
            {progress && <span role="status" className="text-mac-caption text-(--text-secondary)">{progress.done} de {progress.total}…</span>}
          </div>
          <InspectorLayout item={insp.item}><ul className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden">
            {list.map((item) => {
              const k = key(item);
              const bloqueio = item.bloqueio === "legal_hold" ? "Bloqueio judicial: não pode ser apagado" : item.bloqueio === "retencao" ? "Prazo de guarda travado: não pode ser apagado ainda" : null;
              return (
                <li key={k} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 sm:px-5 py-3 border-b border-(--border-default) last:border-0" {...insp.bind({ kind: item.item_type, id: item.id, name: item.name, extra: [["Veio de", item.original_path ?? item.original_folder_name ?? null], ["Excluído em", fullDate(item.deleted_at)], ["Por", item.deleted_by_name ?? null], ["Sai da lixeira", item.trash_expires_at ? fullDate(item.trash_expires_at) : null], ["Bloqueio", bloqueio]] })}>
                  <Checkbox aria-label={`Selecionar ${item.name}`} checked={sel.has(k)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
                  <ItemIcon name={item.name} folder={item.item_type === "folder"} className="w-8 h-8 shrink-0" />
                  <div className="flex-1 min-w-[14rem]">
                    <p className="text-mac-body text-(--text-primary) truncate">{item.name}{item.item_type === "folder" && item.document_count ? <span className="text-(--text-secondary)"> · {item.document_count} documentos</span> : null}</p>
                    <p className="text-mac-caption text-(--text-secondary)">
                      Excluído <time dateTime={item.deleted_at} title={fullDate(item.deleted_at)}>{relativeDate(item.deleted_at)}</time>{item.deleted_by_name ? ` por ${item.deleted_by_name}` : ""}
                      {item.original_path ? ` · estava em ${item.original_path}` : ""}
                    </p>
                    <p className={`text-mac-caption ${bloqueio ? "text-(--text-warning)" : "text-(--text-secondary)"}`}>
                      {bloqueio ? <><Lock className="inline w-3 h-3 -mt-0.5" aria-hidden="true" /> {bloqueio}</> : expiresText(item.trash_expires_at)}
                      {item.original_folder_deleted ? " · a pasta de origem também foi excluída: volta para a raiz" : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="secondary" size="sm" loading={busyId === k} disabled={!!progress} onClick={() => restore(item)} aria-label={`Restaurar ${item.name}`}>
                      <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Restaurar
                    </Button>
                    {isAdmin && !bloqueio && (
                      <Button variant="ghost" size="sm" disabled={!!progress} onClick={() => setDeleting([item])} aria-label={`Apagar ${item.name} para sempre`}>
                        <Trash2 className="w-3.5 h-3.5 text-(--text-danger)" aria-hidden="true" /> Apagar
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul></InspectorLayout>
        </>
      )}

      {deleting && (
        <ConfirmModal
          title={deleting.length === 1 ? `Apagar “${deleting[0].name}” para sempre?` : `Apagar ${deleting.length} itens para sempre?`}
          description={<>O arquivo e o histórico de versões somem e não dá para recuperar.{deleting.some((d) => d.bloqueio) ? " Os itens com bloqueio ficam de fora." : ""}</>}
          confirmLabel="Apagar para sempre" danger loading={!!progress}
          onClose={() => setDeleting(null)}
          onConfirm={() => deleteForever(deleting.filter((d) => !d.bloqueio))}
        />
      )}
    </div>
  );
}
