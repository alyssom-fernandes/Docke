import { useEffect, useRef, useState, useCallback, type ElementType } from "react";
import { useSearchParams } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { relativeDate, fullDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import {
  FileText,
  FolderOpen,
  FolderPlus,
  Upload,
  Trash2,
  Anchor,
  ChevronRight,
  ChevronsUpDown,
  ArrowUp,
  ArrowDown,
  X,
  MoreHorizontal,
  Home,
  Download,
  Eye,
  Share2,
  Rows3,
  Rows4,
  Clock,
  Loader2,
  CheckCircle2,
  AlertCircle,
  MinusCircle,
  ListChecks,
  LayoutGrid,
  List,
} from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { useNavigation } from "@/lib/NavigationContext";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import EmptyState from "@/components/shared/EmptyState";
import TruncatedFileName from "@/components/ui/TruncatedFileName";
import ConfirmModal from "@/components/ui/ConfirmModal";
import PreviewModal from "@/components/documents/PreviewModal";
import VersionsPanel from "@/components/documents/VersionsPanel";
import ShareModal from "@/components/documents/ShareModal";
import FolderTree from "@/components/documents/FolderTree";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
}

interface Document {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  ocr_status: "pending" | "processing" | "done" | "failed" | "skipped";
  created_at: string;
  folder_id: string | null;
  favorited?: boolean;
  active_share_count?: number;
}

type Item = { kind: "folder"; data: Folder } | { kind: "document"; data: Document };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const fmtDate = relativeDate;
const fmtDateFull = fullDate;

// Caracteres proibidos em nomes de arquivo/pasta (compatibilidade Windows/macOS)
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/;

// Separa nome-base e extensão pra manter a extensão fixa durante renomeação inline
function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

function ocrBadge(status: Document["ocr_status"]) {
  const map: Record<Document["ocr_status"], { label: string; variant: "default" | "teal" | "warning" | "error" | "success" }> = {
    pending: { label: "Aguardando OCR", variant: "default" },
    processing: { label: "Processando OCR", variant: "warning" },
    done: { label: "OCR concluído", variant: "success" },
    failed: { label: "OCR falhou", variant: "error" },
    skipped: { label: "OCR ignorado", variant: "default" },
  };
  const { label, variant } = map[status] ?? { label: status, variant: "default" };
  return <Badge variant={variant}>{label}</Badge>;
}

function OcrIcon({ status }: { status: Document["ocr_status"] }) {
  const map: Record<Document["ocr_status"], { Icon: ElementType; className: string; label: string }> = {
    pending: { Icon: Clock, className: "text-[var(--text-tertiary)]", label: "Aguardando OCR" },
    processing: { Icon: Loader2, className: "text-amber-500 animate-spin", label: "Processando OCR" },
    done: { Icon: CheckCircle2, className: "text-emerald-500", label: "OCR concluído" },
    failed: { Icon: AlertCircle, className: "text-red-500", label: "OCR falhou" },
    skipped: { Icon: MinusCircle, className: "text-[var(--text-tertiary)]", label: "OCR ignorado" },
  };
  const { Icon, className, label } = map[status] ?? map.pending;
  return (
    <span title={label} aria-label={label} className="inline-flex">
      <Icon className={`w-4 h-4 ${className}`} />
    </span>
  );
}

type SortKey = "name" | "size" | "created_at";

// ─── Preferência de view/sort por pasta ─────────────────────────────────────
// Finder/Explorer lembram como cada pasta foi deixada (ordenação, modo de
// visualização) em vez de aplicar uma preferência global — ADENDO-09 §13.3.7.

interface FolderPref {
  sort: { key: SortKey; dir: "asc" | "desc" };
  view: "list" | "grid";
}

const DEFAULT_FOLDER_PREF: FolderPref = { sort: { key: "name", dir: "asc" }, view: "list" };
const FOLDER_PREFS_STORAGE_KEY = "docke_folder_prefs";

function loadFolderPref(folderId: string | null): FolderPref {
  try {
    const raw = localStorage.getItem(FOLDER_PREFS_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const stored = all[folderId ?? "__root__"];
    return stored ? { ...DEFAULT_FOLDER_PREF, ...stored } : DEFAULT_FOLDER_PREF;
  } catch {
    return DEFAULT_FOLDER_PREF;
  }
}

function saveFolderPref(folderId: string | null, patch: Partial<FolderPref>) {
  try {
    const raw = localStorage.getItem(FOLDER_PREFS_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    const key = folderId ?? "__root__";
    all[key] = { ...DEFAULT_FOLDER_PREF, ...(all[key] ?? {}), ...patch };
    localStorage.setItem(FOLDER_PREFS_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // localStorage indisponível (modo privado etc.) — degrada pra sessão sem persistência
  }
}

// ─── Larguras de coluna redimensionáveis ────────────────────────────────────

const DEFAULT_COL_WIDTHS = { name: 320, size: 100, ocr: 70, created: 110 };

function SortableHeader({ label, sortKey, sort, onSort, className = "", onResizeStart, onResizeReset }: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  className?: string;
  /** Início do drag-to-resize (mousedown na borda direita) — Explorer/Excel pattern */
  onResizeStart?: (e: React.MouseEvent) => void;
  /** Duplo-clique na borda reseta pro tamanho padrão (autofit simplificado) */
  onResizeReset?: () => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className={`relative px-3 py-2 text-mac-caption font-semibold uppercase tracking-wide text-[var(--text-tertiary)] text-left ${className}`}>
      <button
        onClick={() => onSort(sortKey)}
        className={`flex items-center gap-1 hover:text-[var(--text-primary)] transition-colors duration-fast ${active ? "text-[var(--text-primary)]" : ""}`}
      >
        {label}
        {active ? (
          sort.dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 opacity-40" />
        )}
      </button>
      {onResizeStart && (
        <div
          onMouseDown={onResizeStart}
          onDoubleClick={(e) => { e.stopPropagation(); onResizeReset?.(); }}
          className="absolute top-0 right-0 h-full w-2 cursor-col-resize select-none hover:bg-teal-400/40 active:bg-teal-400/60"
        />
      )}
    </th>
  );
}

// ─── Upload Modal (simplified inline) ────────────────────────────────────────

interface PendingFile {
  file: File;
  // Cadeia de subpastas em que o arquivo estava no drop de pasta local
  // (ex: "NotasFiscais/2026"); vazio pra seleção manual de arquivo solto.
  relativePath: string;
}

// Lê recursivamente uma FileSystemEntry (webkitGetAsEntry) reconstruindo a
// hierarquia de diretórios — padrão usado por Box/Dropbox/Drive/Egnyte pra
// upload de pasta local via drag-and-drop (ADENDO-09 §13.3 Tier 1 item 6).
async function walkEntry(entry: any, currentPath: string, collected: PendingFile[]): Promise<void> {
  if (entry.isFile) {
    await new Promise<void>((resolve) => {
      entry.file((file: File) => { collected.push({ file, relativePath: currentPath }); resolve(); });
    });
  } else if (entry.isDirectory) {
    const newPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;
    const reader = entry.createReader();
    // readEntries() não garante retornar tudo numa chamada só — precisa
    // repetir até vir vazio (particularidade documentada da API).
    const children: any[] = [];
    for (;;) {
      const batch: any[] = await new Promise((resolve) => reader.readEntries(resolve));
      if (!batch.length) break;
      children.push(...batch);
    }
    for (const child of children) {
      await walkEntry(child, newPath, collected);
    }
  }
}

function UploadModal({ folderId, companyId, onClose, onDone }: { folderId: string | null; companyId: string; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [dragOver, setDragOver] = useState(false);
  const uploadContainerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(uploadContainerRef);

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.items;
    if (!items || !items.length) return;
    const collected: PendingFile[] = [];
    const entries = Array.from(items)
      .map((it) => (it as any).webkitGetAsEntry?.())
      .filter(Boolean);
    for (const entry of entries) {
      await walkEntry(entry, "", collected);
    }
    setPending((prev) => [...prev, ...collected]);
  }

  // Resolve o relativePath de um arquivo pra um folder_id, criando as
  // subpastas que ainda não existem sob a pasta atualmente aberta.
  async function resolveFolderId(path: string, cache: Map<string, string>): Promise<string> {
    if (!path) return cache.get("")!;
    if (cache.has(path)) return cache.get(path)!;
    const segments = path.split("/");
    let parentPath = "";
    let parentId = cache.get("")!;
    for (const seg of segments) {
      const currentPath = parentPath ? `${parentPath}/${seg}` : seg;
      if (!cache.has(currentPath)) {
        const { data } = await api.post("/folders", { name: seg, company_id: companyId, parent_id: parentId });
        cache.set(currentPath, data.id);
      }
      parentId = cache.get(currentPath)!;
      parentPath = currentPath;
    }
    return parentId;
  }

  async function upload() {
    if (!pending.length) return;
    if (!folderId) {
      showError("Abra uma pasta antes de fazer upload.");
      return;
    }
    setUploading(true);
    setProgress({ done: 0, total: pending.length });
    const folderCache = new Map<string, string>([["", folderId]]);
    try {
      for (const { file, relativePath } of pending) {
        const targetFolderId = await resolveFolderId(relativePath, folderCache);

        // Etapa 1: solicitar URL de upload pré-assinada
        const { data } = await api.post("/documents/upload-url", {
          folder_id: targetFolderId,
          company_id: companyId,
          name: file.name,
          size_bytes: file.size,
          content_type: file.type || "application/octet-stream",
        });

        // Etapa 2: fazer PUT direto no storage (R2 ou mock)
        const putResp = await fetch(data.upload_url, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });
        if (!putResp.ok) throw new Error(`Storage PUT falhou: ${putResp.status}`);

        // Etapa 3: confirmar upload e disparar OCR
        await api.post(`/documents/${data.document_id}/confirm`);

        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      success(`${pending.length} arquivo${pending.length > 1 ? "s" : ""} enviado${pending.length > 1 ? "s" : ""}.`);
      onDone();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? e?.message ?? "Erro ao fazer upload.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={uploadContainerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[480px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Upload de documentos</h2>
          <button onClick={onClose} className="p-1 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <label
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            className={`block border-2 border-dashed rounded-[var(--radius-control)] p-8 text-center cursor-pointer transition-colors duration-fast ${
              dragOver ? "border-teal-400 bg-teal-500/5" : "border-[var(--border-default)] hover:border-teal-400"
            }`}
          >
            <Upload className="w-8 h-8 mx-auto mb-2 text-[var(--text-placeholder)]" />
            <p className="text-mac-body text-[var(--text-secondary)]">
              {pending.length > 0
                ? `${pending.length} arquivo${pending.length > 1 ? "s" : ""} selecionado${pending.length > 1 ? "s" : ""}`
                : "Clique para selecionar ou arraste arquivos ou pastas aqui"}
            </p>
            <p className="text-mac-caption text-[var(--text-tertiary)] mt-1">PDF, DOCX, XLSX, JPG, PNG — máx. 50 MB cada. Arrastar uma pasta recria a estrutura de subpastas.</p>
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => setPending((prev) => [...prev, ...Array.from(e.target.files ?? []).map((file) => ({ file, relativePath: "" }))])}
              accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.xml,.jpg,.jpeg,.png,.gif,.txt"
            />
          </label>
          {pending.length > 0 && (
            <ul className="max-h-32 overflow-y-auto space-y-1">
              {pending.map((p, i) => (
                <li key={i} className="flex items-center gap-2 text-mac-caption text-[var(--text-secondary)]">
                  <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="flex-1 truncate">{p.relativePath ? `${p.relativePath}/${p.file.name}` : p.file.name}</span>
                  <span>{fmtSize(p.file.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!folderId && (
          <div className="mx-5 mb-1 px-3 py-2 bg-yellow-50 border border-yellow-200 rounded-[var(--radius-control)] text-mac-caption text-yellow-800">
            Abra uma pasta primeiro para habilitar o upload.
          </div>
        )}
        {uploading && progress.total > 1 && (
          <div className="mx-5 mb-1 text-mac-caption text-[var(--text-secondary)]">
            Enviando {progress.done + 1} de {progress.total}…
          </div>
        )}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={uploading}>Cancelar</Button>
          <Button size="sm" loading={uploading} onClick={upload} disabled={!pending.length || !folderId}>
            Enviar
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Create Folder Modal ──────────────────────────────────────────────────────

function CreateFolderModal({ parentId, companyId, onClose, onDone }: { parentId: string | null; companyId: string; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const folderContainerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(folderContainerRef);

  async function create() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.post("/folders", { name: name.trim(), company_id: companyId, parent_id: parentId });
      success(`Pasta "${name.trim()}" criada.`);
      onDone();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar a pasta.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={folderContainerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[360px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Nova pasta</h2>
          <button onClick={onClose} className="p-1 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">
          <input
            autoFocus
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); if (e.key === "Escape") onClose(); }}
            placeholder="Nome da pasta"
            className="w-full h-9 px-3 text-mac-body bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
          />
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" loading={saving} onClick={create} disabled={!name.trim()}>
            Criar
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Detail Drawer ────────────────────────────────────────────────────────────

function DetailDrawer({ doc, onClose, onFavorite, onPreview, onDelete, onChanged }: { doc: Document; onClose: () => void; onFavorite: () => void; onPreview: () => void; onDelete: () => void; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);
  const [favorited, setFavorited] = useState(doc.favorited ?? false);
  const [sharing, setSharing] = useState(false);
  const [shareCount, setShareCount] = useState(doc.active_share_count ?? 0);

  useEffect(() => { setFavorited(doc.favorited ?? false); }, [doc.id, doc.favorited]);
  useEffect(() => { setShareCount(doc.active_share_count ?? 0); }, [doc.id, doc.active_share_count]);

  async function toggleFavorite() {
    try {
      if (favorited) {
        // need favorite_id — simplified: refetch
        showError("Use a lista de ancorados para remover.");
      } else {
        await api.post("/favorites", { document_id: doc.id });
        setFavorited(true);
        success(`"${doc.name}" adicionado aos ancorados.`);
        onFavorite();
      }
    } catch (e: any) {
      if (e?.response?.status === 409) { setFavorited(true); return; }
      showError("Erro ao ancorar.");
    }
  }

  async function download() {
    try {
      const r = await api.get(`/documents/${doc.id}/download-url`);
      const a = document.createElement("a");
      a.href = r.data.download_url;
      a.download = doc.name;
      a.click();
    } catch {
      showError("Erro ao baixar o documento.");
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[420px] max-h-[85vh] overflow-y-auto">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
        <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Detalhes</h2>
        <button onClick={onClose} className="p-1 rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3">
          {(() => { const s = getFileStyle(doc.name); const Icon = s.icon; return (
            <div className={`w-10 h-10 rounded-[var(--radius-control)] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
              <Icon className={`w-5 h-5 ${s.iconColor}`} />
            </div>
          ); })()}
          <div className="flex-1 min-w-0">
            <p className="text-mac-body font-medium text-[var(--text-primary)] break-words">{doc.name}</p>
            <p className="text-mac-caption text-[var(--text-secondary)] mt-0.5">{fmtSize(doc.size_bytes)}</p>
          </div>
        </div>

        <div className="space-y-2">
          <Row label="Tipo" value={doc.mime_type} />
          <Row label="Tamanho" value={fmtSize(doc.size_bytes)} />
          <Row label="Criado em" value={fmtDateFull(doc.created_at)} />
          <div className="flex justify-between py-1">
            <span className="text-mac-caption text-[var(--text-secondary)]">OCR</span>
            {ocrBadge(doc.ocr_status)}
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2 border-t border-[var(--border-default)]">
          <button
            onClick={onPreview}
            className="w-full h-9 flex items-center justify-center gap-2 text-mac-body bg-teal-600 text-white rounded-full hover:bg-teal-500 transition-colors duration-fast"
          >
            <Eye className="w-4 h-4" />
            Visualizar
          </button>
          <button
            onClick={download}
            className="w-full h-9 flex items-center justify-center gap-2 text-mac-body border border-[var(--border-default)] rounded-full text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
          >
            <Download className="w-4 h-4" />
            Baixar
          </button>
          <button
            onClick={toggleFavorite}
            className={`w-full h-9 flex items-center justify-center gap-2 text-mac-body border rounded-full transition-colors duration-fast ${
              favorited
                ? "border-teal-200 dark:border-teal-900/40 text-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/20"
                : "border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            <Anchor className={`w-4 h-4 ${favorited ? "fill-current" : ""}`} />
            {favorited ? "Remover ancoragem" : "Ancorar como favorito"}
          </button>
          <button
            onClick={() => setSharing(true)}
            className={`w-full h-9 flex items-center justify-center gap-2 text-mac-body border rounded-full transition-colors duration-fast ${
              shareCount > 0
                ? "border-teal-200 dark:border-teal-900/40 text-teal-500 hover:bg-teal-50 dark:hover:bg-teal-900/20"
                : "border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            <Share2 className="w-4 h-4" />
            {shareCount > 0 ? `Compartilhado (${shareCount})` : "Compartilhar"}
          </button>
          <button
            onClick={onDelete}
            className="w-full h-9 flex items-center justify-center gap-2 text-mac-body border border-red-200 dark:border-red-900/40 rounded-full text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors duration-fast"
          >
            <Trash2 className="w-4 h-4" />
            Excluir
          </button>
        </div>

        <VersionsPanel documentId={doc.id} documentName={doc.name} onChanged={onChanged} />
      </div>
      </div>

      {sharing && (
        <ShareModal
          resourceType="document"
          resourceId={doc.id}
          name={doc.name}
          onClose={() => setSharing(false)}
          onChanged={setShareCount}
        />
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-mac-caption text-[var(--text-secondary)]">{label}</span>
      <span className="text-mac-caption text-[var(--text-primary)] truncate max-w-[180px] text-right">{value}</span>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const NAV_KEY = "documents";

export default function Documents() {
  usePageTitle("Documentos");
  const { current } = useCompany();
  const { toast, success, error: showError } = useToast();
  const nav = useNavigation();

  // Restore saved nav state (session-only, React Context)
  const saved = nav.getFolderState(NAV_KEY);

  const [folders, setFolders] = useState<Folder[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(saved?.folderId ?? null);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string | null; name: string }>>(
    saved?.breadcrumbs ?? [{ id: null, name: "Início" }]
  );
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailDoc, setDetailDoc] = useState<Document | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<Folder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
  // ADR-026: densidade de tabela — compacto reduz padding vertical das linhas
  const [density, setDensity] = useState<"comfortable" | "compact">(
    () => (localStorage.getItem("docke_table_density") as "comfortable" | "compact") || "comfortable"
  );
  function toggleDensity() {
    const next = density === "comfortable" ? "compact" : "comfortable";
    setDensity(next);
    localStorage.setItem("docke_table_density", next);
  }

  // Preferência de ordenação e modo de visualização por pasta (Finder/Explorer
  // lembram como cada pasta foi deixada, não usam uma preferência global única).
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>(() => loadFolderPref(currentFolderId).sort);
  const [viewMode, setViewMode] = useState<"list" | "grid">(() => loadFolderPref(currentFolderId).view);
  useEffect(() => {
    const pref = loadFolderPref(currentFolderId);
    setSort(pref.sort);
    setViewMode(pref.view);
  }, [currentFolderId]);
  function toggleSort(key: SortKey) {
    setSort((prev) => {
      const next = prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" as const : "asc" as const } : { key, dir: "asc" as const };
      saveFolderPref(currentFolderId, { sort: next });
      return next;
    });
  }
  function setView(mode: "list" | "grid") {
    setViewMode(mode);
    saveFolderPref(currentFolderId, { view: mode });
  }

  // Larguras de coluna redimensionáveis (Explorer/Excel) — persistidas globalmente,
  // não por pasta (o usuário ajusta uma vez e espera que valha em todo lugar).
  const [colWidths, setColWidths] = useState<typeof DEFAULT_COL_WIDTHS>(() => {
    try {
      const raw = localStorage.getItem("docke_col_widths");
      return raw ? { ...DEFAULT_COL_WIDTHS, ...JSON.parse(raw) } : { ...DEFAULT_COL_WIDTHS };
    } catch {
      return { ...DEFAULT_COL_WIDTHS };
    }
  });
  function startColResize(col: keyof typeof DEFAULT_COL_WIDTHS, e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = colWidths[col];
    function onMove(ev: MouseEvent) {
      const next = Math.max(60, startWidth + (ev.clientX - startX));
      setColWidths((prev) => ({ ...prev, [col]: next }));
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setColWidths((prev) => {
        localStorage.setItem("docke_col_widths", JSON.stringify(prev));
        return prev;
      });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
  function resetColWidth(col: keyof typeof DEFAULT_COL_WIDTHS) {
    setColWidths((prev) => {
      const next = { ...prev, [col]: DEFAULT_COL_WIDTHS[col] };
      localStorage.setItem("docke_col_widths", JSON.stringify(next));
      return next;
    });
  }

  // Força remount do FolderTree da sidebar quando uma pasta é criada, renomeada,
  // movida (via drag na tabela) ou excluída pela tabela principal — o FolderTree
  // só recarrega sozinho ao montar, então sem isso a sidebar fica desatualizada.
  const [folderTreeVersion, setFolderTreeVersion] = useState(0);

  // Item "focado" (último clicado) — alvo dos atalhos de teclado Space (preview) e F2 (renomear)
  const [focusedId, setFocusedId] = useState<string | null>(null);
  // Renomeação inline: edita o nome direto na célula da tabela (F2, padrão Finder/Explorer)
  const [renaming, setRenaming] = useState<{ kind: "folder" | "document"; id: string; value: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) { renameInputRef.current?.focus(); renameInputRef.current?.select(); }
  }, [renaming?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function startRename(kind: "folder" | "document", id: string, currentName: string) {
    const [base] = kind === "document" ? splitExt(currentName) : [currentName, ""];
    setRenaming({ kind, id, value: base });
  }

  function confirmRename() {
    if (!renaming) return;
    const { kind, id, value } = renaming;
    const trimmed = value.trim();
    if (!trimmed) { setRenaming(null); return; }
    if (FORBIDDEN_NAME_CHARS.test(trimmed)) {
      showError('Caractere inválido: \\ / : * ? " < > |');
      return;
    }

    const oldName = kind === "folder"
      ? folders.find((f) => f.id === id)?.name
      : documents.find((d) => d.id === id)?.name;
    if (!oldName) { setRenaming(null); return; }

    const ext = kind === "document" ? splitExt(oldName)[1] : "";
    const newName = `${trimmed}${ext}`;
    if (newName === oldName) { setRenaming(null); return; }

    const siblings = kind === "folder"
      ? folders.filter((f) => f.id !== id).map((f) => f.name.toLowerCase())
      : documents.filter((d) => d.id !== id).map((d) => d.name.toLowerCase());
    if (siblings.includes(newName.toLowerCase())) {
      showError("Já existe um item com este nome nesta pasta.");
      return;
    }

    setRenaming(null);

    // Mesmo padrão de "Desfazer" com atraso usado em deleteDocuments: aplica
    // a mudança na tela na hora, só chama a API depois da janela de desfazer.
    if (kind === "folder") {
      setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: newName } : f)));
      setFolderTreeVersion((v) => v + 1);
    } else {
      setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, name: newName } : d)));
    }

    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        if (kind === "folder") await api.patch(`/folders/${id}/rename`, { name: newName });
        else await api.patch(`/documents/${id}`, { name: newName });
      } catch (e: any) {
        showError(e?.response?.data?.detail ?? "Erro ao renomear.");
        load();
      }
    }, 5000);

    toast({
      type: "success",
      message: `Renomeado para "${newName}".`,
      duration: 5000,
      action: {
        label: "Desfazer",
        onClick: () => {
          undone = true;
          clearTimeout(timer);
          if (kind === "folder") { setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: oldName } : f))); setFolderTreeVersion((v) => v + 1); }
          else setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, name: oldName } : d)));
        },
      },
    });
  }

  // Atalhos globais: Space abre preview do item focado, F2 inicia renomeação inline —
  // desativados quando o usuário está digitando em outro campo ou há modal aberto.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      const modalOpen = !!(detailDoc || previewDoc || showUpload || showNewFolder || confirmDeleteFolder || sharingFolder);
      if (typing || modalOpen || !focusedId) return;

      if (e.code === "Space") {
        const doc = documents.find((d) => d.id === focusedId);
        if (doc) { e.preventDefault(); setPreviewDoc(doc); }
      } else if (e.key === "F2") {
        const doc = documents.find((d) => d.id === focusedId);
        const folder = folders.find((f) => f.id === focusedId);
        if (doc) { e.preventDefault(); startRename("document", doc.id, doc.name); }
        else if (folder) { e.preventDefault(); startRename("folder", folder.id, folder.name); }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [focusedId, documents, folders, detailDoc, previewDoc, showUpload, showNewFolder, confirmDeleteFolder, sharingFolder]);

  // Seleção por arraste (rubber-band) — só ativa no modo de seleção, iniciada em área
  // vazia da lista (não sobre linhas/botões) pra não conflitar com cliques normais.
  const scrollBodyRef = useRef<HTMLDivElement>(null);
  // HTMLElement (não HTMLTableRowElement) porque a view em grade usa <div>, não <tr>
  const rowRefs = useRef<Map<string, HTMLElement>>(new Map());
  const [dragBox, setDragBox] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);

  // Arrastar documento(s) pra dentro de uma pasta (mover) — mesma convenção
  // de move/copy que Finder/Explorer, aqui só move (sem tecla modificadora ainda).
  const [dragDocIds, setDragDocIds] = useState<string[] | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  // Spring-loaded folders: manter um documento arrastado sobre uma pasta por
  // um tempo abre a pasta automaticamente (padrão Finder/Explorer).
  const dragHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearDragHoverTimer() {
    if (dragHoverTimerRef.current) { clearTimeout(dragHoverTimerRef.current); dragHoverTimerRef.current = null; }
  }

  function handleBodyMouseDown(e: React.MouseEvent) {
    if (!selectionMode) return;
    if ((e.target as HTMLElement).closest("tr, button, input, a")) return;
    const container = scrollBodyRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startX = e.clientX - rect.left + container.scrollLeft;
    const startY = e.clientY - rect.top + container.scrollTop;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    setDragBox({ x1: startX, y1: startY, x2: startX, y2: startY });

    function handleMove(ev: MouseEvent) {
      const r = container!.getBoundingClientRect();
      const x = ev.clientX - r.left + container!.scrollLeft;
      const y = ev.clientY - r.top + container!.scrollTop;
      setDragBox({ x1: startX, y1: startY, x2: x, y2: y });
    }

    function handleUp(ev: MouseEvent) {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      const r = container!.getBoundingClientRect();
      const endX = ev.clientX - r.left + container!.scrollLeft;
      const endY = ev.clientY - r.top + container!.scrollTop;
      const left = Math.min(startX, endX);
      const right = Math.max(startX, endX);
      const top = Math.min(startY, endY);
      const bottom = Math.max(startY, endY);
      const hitIds: string[] = [];
      rowRefs.current.forEach((el, id) => {
        const er = el.getBoundingClientRect();
        const rowTop = er.top - r.top + container!.scrollTop;
        const rowBottom = rowTop + er.height;
        const rowLeft = er.left - r.left + container!.scrollLeft;
        const rowRight = rowLeft + er.width;
        if (rowBottom >= top && rowTop <= bottom && rowRight >= left && rowLeft <= right) hitIds.push(id);
      });
      if (hitIds.length) {
        setSelected((prev) => {
          const next = additive ? new Set(prev) : new Set<string>();
          hitIds.forEach((id) => next.add(id));
          return next;
        });
      }
      setDragBox(null);
    }

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }

  // Checkboxes ficam ocultos por padrão (poluem a tabela pra quem só navega);
  // o botão "Selecionar" na toolbar liga o modo de seleção em massa.
  const [selectionMode, setSelectionMode] = useState(false);
  const [toolbarMenuOpen, setToolbarMenuOpen] = useState(false);
  const toolbarMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolbarMenuOpen) return;
    function handle(e: MouseEvent) {
      if (toolbarMenuRef.current && !toolbarMenuRef.current.contains(e.target as Node)) setToolbarMenuOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [toolbarMenuOpen]);

  // Seletor de níveis ocultos do breadcrumb truncado (mobile)
  const [crumbMenuOpen, setCrumbMenuOpen] = useState(false);
  const crumbMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!crumbMenuOpen) return;
    function handle(e: MouseEvent) {
      if (crumbMenuRef.current && !crumbMenuRef.current.contains(e.target as Node)) setCrumbMenuOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [crumbMenuOpen]);

  // ADR-017.2: desabilita o blur da moldura durante scroll ativo (custo de
  // GPU) e restaura 150ms após o scroll parar — transição imperceptível.
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const [tableScrolling, setTableScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleTableScroll = useCallback(() => {
    setTableScrolling(true);
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = setTimeout(() => setTableScrolling(false), 150);
  }, []);
  useEffect(() => () => {
    if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
  }, []);

  const load = useCallback(() => {
    if (!current) return;
    setLoading(true);
    setSelected(new Set());
    setFocusedId(null);

    const foldersParams: Record<string, string> = { company_id: current.id };
    if (currentFolderId) foldersParams.parent_id = currentFolderId;

    const foldersFetch = api.get<Folder[]>("/folders", { params: foldersParams })
      .catch(() => ({ data: [] as Folder[] }));

    const docsFetch = currentFolderId
      ? api.get<Document[]>("/documents", { params: { company_id: current.id, folder_id: currentFolderId } })
          .catch(() => ({ data: [] as Document[] }))
      : Promise.resolve({ data: [] as Document[] });

    Promise.all([foldersFetch, docsFetch]).then(([fRes, dRes]) => {
      setFolders(Array.isArray(fRes.data) ? fRes.data : []);
      setDocuments(Array.isArray(dRes.data) ? dRes.data : []);
    }).finally(() => setLoading(false));
  }, [current?.id, currentFolderId]);

  useEffect(() => { load(); }, [load]);

  // Deep link vindo da busca: /documents?folder_id=<id>&doc=<id>
  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingDocId, setPendingDocId] = useState<string | null>(null);
  useEffect(() => {
    const linkedFolderId = searchParams.get("folder_id");
    const linkedDocId = searchParams.get("doc");
    if (!linkedFolderId || !current) return;
    if (linkedDocId) setPendingDocId(linkedDocId);

    api.get<Array<Folder & { path: string }>>("/folders", { params: { company_id: current.id, flat: true } })
      .then((res) => {
        const all = Array.isArray(res.data) ? res.data : [];
        const target = all.find((f) => f.id === linkedFolderId);
        if (!target) return;

        const chain: Array<{ id: string | null; name: string }> = [{ id: null, name: "Início" }];
        const ancestorIds: string[] = [];
        let cur: (Folder & { path: string }) | undefined = target;
        while (cur) {
          ancestorIds.unshift(cur.id);
          cur = cur.parent_id ? all.find((f) => f.id === cur!.parent_id) : undefined;
        }
        ancestorIds.forEach((id) => {
          const f = all.find((x) => x.id === id);
          if (f) chain.push({ id: f.id, name: f.name });
        });

        setBreadcrumbs(chain);
        setCurrentFolderId(linkedFolderId);
      })
      .finally(() => {
        setSearchParams({}, { replace: true });
      });
    // searchParams muda de identidade a cada navegação (mesmo para a mesma rota já montada,
    // como ao clicar num resultado do Command Palette estando já em /documents) — precisa
    // reagir a isso, não só ao trocar de empresa.
  }, [current?.id, searchParams]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pendingDocId || loading) return;
    const doc = documents.find((d) => d.id === pendingDocId);
    if (doc) setDetailDoc(doc);
  }, [documents, loading, pendingDocId]);

  // Persist navigation state in session memory (folder + breadcrumbs only)
  useEffect(() => {
    nav.setFolderState(NAV_KEY, {
      folderId: currentFolderId,
      scrollY: 0,
      selected: [],
      breadcrumbs,
    });
  }, [currentFolderId, breadcrumbs]); // eslint-disable-line react-hooks/exhaustive-deps

  function openFolder(folder: Folder) {
    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setDetailDoc(null);
    setFocusedId(null);
  }

  function navigateBreadcrumb(idx: number) {
    const crumb = breadcrumbs[idx];
    setCurrentFolderId(crumb.id);
    setBreadcrumbs((prev) => prev.slice(0, idx + 1));
    setDetailDoc(null);
    setFocusedId(null);
  }

  function navigateHome() {
    setCurrentFolderId(null);
    setBreadcrumbs([{ id: null, name: "Início" }]);
    setDetailDoc(null);
    setFocusedId(null);
  }

  // Navegação a partir de um clique na sidebar de pastas: reconstrói a
  // cadeia de breadcrumbs subindo pelos parent_id (mesma lógica do deep
  // link vindo da busca, só que disparada por clique em vez de query param).
  async function jumpToFolder(targetFolderId: string) {
    if (!current) return;
    try {
      const res = await api.get<Array<Folder & { path: string }>>("/folders", {
        params: { company_id: current.id, flat: true },
      });
      const all = Array.isArray(res.data) ? res.data : [];
      const target = all.find((f) => f.id === targetFolderId);
      if (!target) return;

      const chain: Array<{ id: string | null; name: string }> = [{ id: null, name: "Início" }];
      const ancestorIds: string[] = [];
      let cur: (Folder & { path: string }) | undefined = target;
      while (cur) {
        ancestorIds.unshift(cur.id);
        cur = cur.parent_id ? all.find((f) => f.id === cur!.parent_id) : undefined;
      }
      ancestorIds.forEach((id) => {
        const f = all.find((x) => x.id === id);
        if (f) chain.push({ id: f.id, name: f.name });
      });

      setBreadcrumbs(chain);
      setCurrentFolderId(targetFolderId);
      setDetailDoc(null);
      setFocusedId(null);
    } catch {
      showError("Não foi possível abrir a pasta.");
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectAll() {
    const allIds = documents.map((d) => d.id);
    setSelected(selected.size === allIds.length ? new Set() : new Set(allIds));
  }

  function deleteDocuments(ids: string[]) {
    if (!ids.length) return;
    const count = ids.length;
    const label = `${count} documento${count > 1 ? "s" : ""} movido${count > 1 ? "s" : ""} para a lixeira.`;

    // Optimistic: hide items immediately
    setDocuments((prev) => prev.filter((d) => !ids.includes(d.id)));
    setSelected(new Set());

    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        await api.post("/documents/bulk-delete", { document_ids: ids });
      } catch (e: any) {
        showError(e?.response?.data?.detail ?? "Erro ao excluir documentos.");
        load(); // restore on failure
      }
    }, 5000);

    toast({
      type: "success",
      message: label,
      duration: 5000,
      action: {
        label: "Desfazer",
        onClick: () => {
          undone = true;
          clearTimeout(timer);
          load();
        },
      },
    });
  }

  function deleteSelected() {
    deleteDocuments([...selected]);
  }

  function moveDocuments(ids: string[], targetFolderId: string, targetFolderName: string) {
    if (!ids.length) return;
    const count = ids.length;
    const label = `${count} documento${count > 1 ? "s" : ""} movido${count > 1 ? "s" : ""} para "${targetFolderName}".`;

    // Mesmo padrão de "Desfazer" com atraso: some da pasta atual na hora,
    // só chama a API depois da janela de desfazer.
    setDocuments((prev) => prev.filter((d) => !ids.includes(d.id)));
    setSelected(new Set());

    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      try {
        await api.post("/documents/bulk-move", { document_ids: ids, target_folder_id: targetFolderId });
      } catch (e: any) {
        showError(e?.response?.data?.detail ?? "Erro ao mover documentos.");
        load();
      }
    }, 5000);

    toast({
      type: "success",
      message: label,
      duration: 5000,
      action: {
        label: "Desfazer",
        onClick: () => {
          undone = true;
          clearTimeout(timer);
          load();
        },
      },
    });
  }

  async function deleteFolder(folder: Folder) {
    setDeletingFolder(true);
    try {
      await api.delete(`/folders/${folder.id}`);
      success(`Pasta "${folder.name}" excluída.`);
      setConfirmDeleteFolder(null);
      load();
      setFolderTreeVersion((v) => v + 1);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Erro ao excluir pasta.");
    } finally {
      setDeletingFolder(false);
    }
  }

  const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  const sortedDocuments = [...documents].sort((a, b) => {
    let cmp = 0;
    if (sort.key === "name") cmp = a.name.localeCompare(b.name);
    else if (sort.key === "size") cmp = a.size_bytes - b.size_bytes;
    else cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return sort.dir === "asc" ? cmp : -cmp;
  });

  // Pastas sempre no topo (convenção de gerenciador de arquivos); só os documentos respeitam a ordenação escolhida
  const items: Item[] = [
    ...sortedFolders.map((f): Item => ({ kind: "folder", data: f })),
    ...sortedDocuments.map((d): Item => ({ kind: "document", data: d })),
  ];

  return (
    <div className="flex h-full -my-6 gap-4 p-2">
      {/* Sidebar de pastas — desktop only (lg+), mesma "receita" de vidro do painel principal */}
      <aside className="hidden lg:flex flex-col w-[220px] flex-shrink-0 glass-panel glass-highlight-line rounded-[var(--radius-panel)] glass-shadow overflow-hidden">
        <div className="px-3 py-3 border-b border-[var(--border-default)] flex-shrink-0">
          <h2 className="text-mac-caption font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Pastas</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          <button
            onClick={navigateHome}
            className={`w-full flex items-center gap-1.5 h-8 pl-3 pr-2 text-mac-body rounded-[6px] transition-colors duration-fast text-left ${
              currentFolderId === null
                ? "bg-teal-500/10 text-teal-500 font-medium"
                : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            }`}
          >
            <Home className="w-4 h-4 flex-shrink-0" />
            Início
          </button>
          {/* Divisor sutil separando "Início" da árvore de pastas — padrão Finder
              ("Favoritos" vs. "Locais" ficam separados por respiro visual). */}
          <div className="my-1.5 mx-2 border-t border-[var(--border-default)] opacity-60" />
          {current && (
            <FolderTree
              key={folderTreeVersion}
              companyId={current.id}
              activeFolderId={currentFolderId}
              onSelect={(f) => jumpToFolder(f.id)}
              onDropDocuments={(folderId, documentIds, folderName) => {
                moveDocuments(documentIds, folderId, folderName);
                setDragDocIds(null);
              }}
              onMove={(movedFolderId) => {
                // Pasta movida pela sidebar pode ser a que está aberta (ou uma
                // ancestral do breadcrumb atual) — nesse caso o caminho mostrado
                // ficaria inválido, então volta pra raiz por segurança. Fora
                // isso, só recarrega a listagem principal (a pasta pode ter
                // saído ou entrado como filha da pasta atualmente aberta).
                if (breadcrumbs.some((b) => b.id === movedFolderId)) navigateHome();
                else load();
              }}
            />
          )}
        </div>
      </aside>

      {/* Main area — moldura de vidro externa (ADR-017: blur raso, sem re-render no scroll) */}
      <div
        ref={tableWrapRef}
        className={`glass-panel glass-highlight-line relative flex-1 flex flex-col min-w-0 overflow-hidden rounded-[var(--radius-panel)] glass-shadow ${
          tableScrolling ? "glass-scroll-active" : ""
        } glass-blur-table`}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-[var(--border-default)] flex-shrink-0">
          {/* Breadcrumbs — versão completa (sm+) */}
          <nav className="hidden sm:flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
            {breadcrumbs.map((crumb, idx) => (
              <span key={idx} className="flex items-center gap-1 flex-shrink-0">
                {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />}
                <button
                  onClick={() => navigateBreadcrumb(idx)}
                  className={`text-mac-body hover:text-teal-500 transition-colors duration-fast ${
                    idx === breadcrumbs.length - 1
                      ? "text-[var(--text-primary)] font-medium"
                      : "text-[var(--text-secondary)]"
                  }`}
                >
                  {idx === 0 ? <Home className="w-4 h-4" /> : crumb.name}
                </button>
              </span>
            ))}
          </nav>

          {/* Breadcrumbs — versão truncada (mobile): Início, "…" (seletor com as pastas ocultas, em ordem) e a pasta atual */}
          <nav className="flex sm:hidden items-center gap-1 flex-1 min-w-0">
            <button onClick={() => navigateBreadcrumb(0)} className="flex-shrink-0 text-[var(--text-secondary)] hover:text-teal-500 transition-colors duration-fast">
              <Home className="w-4 h-4" />
            </button>
            {breadcrumbs.length > 2 && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)] flex-shrink-0" />
                <div className="relative" ref={crumbMenuRef}>
                  <button
                    onClick={() => setCrumbMenuOpen((v) => !v)}
                    className="flex-shrink-0 text-mac-body text-[var(--text-secondary)] hover:text-teal-500 transition-colors duration-fast"
                  >
                    …
                  </button>
                  {crumbMenuOpen && (
                    <div className="absolute top-full left-0 mt-1 w-56 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50">
                      {breadcrumbs.slice(1, -1).map((crumb, i) => (
                        <button
                          key={crumb.id}
                          onClick={() => { navigateBreadcrumb(i + 1); setCrumbMenuOpen(false); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-left text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                        >
                          <FolderOpen className="w-3.5 h-3.5 text-teal-500 flex-shrink-0" />
                          <span className="truncate">{crumb.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
            {breadcrumbs.length > 1 && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)] flex-shrink-0" />
                <span className="text-mac-body font-medium text-[var(--text-primary)] truncate">
                  {breadcrumbs[breadcrumbs.length - 1].name}
                </span>
              </>
            )}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setSelectionMode((v) => !v)}
              title={selectionMode ? "Sair do modo de seleção" : "Selecionar vários"}
              className={`hidden sm:flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-fast ${
                selectionMode ? "text-teal-500 bg-teal-500/10" : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              <ListChecks className="w-4 h-4" />
            </button>
            <button
              onClick={toggleDensity}
              title={density === "comfortable" ? "Densidade compacta" : "Densidade confortável"}
              className="hidden sm:flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
            >
              {density === "comfortable" ? <Rows3 className="w-4 h-4" /> : <Rows4 className="w-4 h-4" />}
            </button>
            <button
              onClick={() => setView(viewMode === "list" ? "grid" : "list")}
              title={viewMode === "list" ? "Ver em grade" : "Ver em lista"}
              className="hidden sm:flex h-8 w-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
            >
              {viewMode === "list" ? <LayoutGrid className="w-4 h-4" /> : <List className="w-4 h-4" />}
            </button>
            <Button variant="secondary" size="sm" className="hidden sm:flex" onClick={() => setShowNewFolder(true)}>
              <FolderPlus className="w-3.5 h-3.5" />
              Nova pasta
            </Button>

            {/* Mobile: Nova pasta / seleção / densidade colapsam num menu "..." pra sobrar espaço pro breadcrumb */}
            <div className="relative sm:hidden" ref={toolbarMenuRef}>
              <button
                onClick={() => setToolbarMenuOpen((v) => !v)}
                title="Mais ações"
                aria-label="Mais ações"
                className="h-8 w-8 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {toolbarMenuOpen && (
                <div className="absolute top-full right-0 mt-1 w-52 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50">
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setSelectionMode((v) => !v); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                  >
                    <ListChecks className="w-4 h-4" />
                    {selectionMode ? "Sair da seleção" : "Selecionar vários"}
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setShowNewFolder(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                  >
                    <FolderPlus className="w-4 h-4" />
                    Nova pasta
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); toggleDensity(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                  >
                    {density === "comfortable" ? <Rows3 className="w-4 h-4" /> : <Rows4 className="w-4 h-4" />}
                    {density === "comfortable" ? "Densidade compacta" : "Densidade confortável"}
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setView(viewMode === "list" ? "grid" : "list"); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                  >
                    {viewMode === "list" ? <LayoutGrid className="w-4 h-4" /> : <List className="w-4 h-4" />}
                    {viewMode === "list" ? "Ver em grade" : "Ver em lista"}
                  </button>
                </div>
              )}
            </div>

            <Button size="sm" onClick={() => setShowUpload(true)}>
              <Upload className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Upload</span>
            </Button>
          </div>
        </div>

        {/* File list — pb extra no mobile e no desktop (lg+): essa página cancela o
            padding vertical do AppShell (-my-6), então precisa da própria folga pra não
            ficar atrás da barra inferior mobile nem do Dock flutuante desktop */}
        <div
          ref={scrollBodyRef}
          className="flex-1 overflow-y-auto pb-20 md:pb-0 lg:pb-24 relative"
          onScroll={handleTableScroll}
          onMouseDown={handleBodyMouseDown}
        >
          {loading ? (
            <div className="p-6 space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-11 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <EmptyState
                title="Pasta vazia"
                description="Faça upload de documentos ou crie subpastas."
                icon={<FolderOpen className="w-6 h-6" />}
                action={
                  <Button size="sm" onClick={() => setShowUpload(true)}>
                    <Upload className="w-3.5 h-3.5" />
                    Upload
                  </Button>
                }
              />
            </div>
          ) : viewMode === "grid" ? (
            <div className="p-4 grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1">
              {items.map((item) => {
                if (item.kind === "folder") {
                  const f = item.data;
                  const isDropTarget = dragOverFolderId === f.id;
                  return (
                    <div
                      key={`folder-${f.id}`}
                      className={`group relative flex flex-col items-center gap-1.5 py-3 px-2 rounded-[var(--radius-control)] cursor-pointer transition-colors duration-fast hover:bg-[var(--bg-hover)] ${
                        isDropTarget ? "bg-teal-500/10 outline outline-2 outline-teal-400 -outline-offset-2" : ""
                      }`}
                      onClick={() => setFocusedId(f.id)}
                      onDoubleClick={() => openFolder(f)}
                      onDragOver={(e) => {
                        if (!dragDocIds) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverFolderId !== f.id) {
                          setDragOverFolderId(f.id);
                          clearDragHoverTimer();
                          dragHoverTimerRef.current = setTimeout(() => {
                            openFolder(f);
                            setDragOverFolderId(null);
                            dragHoverTimerRef.current = null;
                          }, 1200);
                        }
                      }}
                      onDragLeave={() => {
                        setDragOverFolderId((prev) => (prev === f.id ? null : prev));
                        clearDragHoverTimer();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        clearDragHoverTimer();
                        if (dragDocIds) moveDocuments(dragDocIds, f.id, f.name);
                        setDragDocIds(null);
                        setDragOverFolderId(null);
                      }}
                    >
                      <div className="absolute top-1 right-1 hidden group-hover:flex items-center gap-0.5 z-10">
                        <button
                          onClick={(e) => { e.stopPropagation(); setSharingFolder(f); }}
                          className="p-1 rounded-full text-[var(--text-tertiary)] hover:text-teal-500 hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                          title="Compartilhar pasta"
                        >
                          <Share2 className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteFolder(f); }}
                          className="p-1 rounded-full text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors duration-fast"
                          title="Excluir pasta"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <FolderOpen className="w-10 h-10 text-teal-500 flex-shrink-0" />
                      {renaming?.kind === "folder" && renaming.id === f.id ? (
                        <input
                          ref={renameInputRef}
                          type="text"
                          value={renaming.value}
                          onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") confirmRename();
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={confirmRename}
                          className="w-full h-6 px-1 text-mac-caption text-center bg-[var(--bg-page)] border border-teal-500 rounded-[4px] text-[var(--text-primary)] focus:outline-none"
                        />
                      ) : (
                        <span className="text-mac-caption text-[var(--text-primary)] text-center leading-tight w-full line-clamp-2">{f.name}</span>
                      )}
                    </div>
                  );
                }

                const d = item.data;
                const isSelected = selected.has(d.id);
                const isDragging = dragDocIds?.includes(d.id) ?? false;
                const s = getFileStyle(d.name);
                const Icon = s.icon;
                return (
                  <div
                    key={`doc-${d.id}`}
                    ref={(el) => { if (el) rowRefs.current.set(d.id, el); else rowRefs.current.delete(d.id); }}
                    className={`group relative flex flex-col items-center gap-1.5 py-3 px-2 rounded-[var(--radius-control)] cursor-pointer transition-colors duration-fast hover:bg-[var(--bg-hover)] ${
                      isSelected ? "bg-teal-50 dark:bg-teal-900/20" : ""
                    } ${isDragging ? "opacity-40" : ""}`}
                    onClick={() => { setFocusedId(d.id); setDetailDoc(d); }}
                    draggable
                    onDragStart={(e) => {
                      const ids = selected.has(d.id) && selected.size > 1 ? [...selected] : [d.id];
                      setDragDocIds(ids);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("application/x-docke-document-ids", ids.join(","));
                      e.dataTransfer.setData("text/plain", ids.join(","));

                      const ghost = document.createElement("div");
                      ghost.textContent = ids.length > 1 ? `${ids.length} arquivos` : d.name;
                      ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;padding:6px 14px;background:#0d9488;color:#fff;border-radius:999px;font-size:13px;font-weight:500;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.35);font-family:inherit;";
                      document.body.appendChild(ghost);
                      e.dataTransfer.setDragImage(ghost, 14, 14);
                      setTimeout(() => document.body.removeChild(ghost), 0);
                    }}
                    onDragEnd={() => { setDragDocIds(null); setDragOverFolderId(null); }}
                  >
                    {selectionMode && (
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(d.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-1 left-1 accent-teal-500 w-4 h-4 z-10"
                      />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setDetailDoc(d); }}
                      className="absolute top-1 right-1 hidden group-hover:flex p-1 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast z-10"
                    >
                      <MoreHorizontal className="w-3 h-3" />
                    </button>
                    <div className={`w-10 h-10 rounded-[6px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-5 h-5 ${s.iconColor}`} />
                    </div>
                    <span className="text-mac-caption text-[var(--text-primary)] text-center leading-tight w-full line-clamp-2">{d.name}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            // overflow-x-auto: com colunas redimensionáveis (table-fixed) a soma das
            // larguras pode passar do viewport no mobile — rola em vez de cortar/quebrar.
            <div className="overflow-x-auto">
            <table className={`w-full table-fixed ${density === "compact" ? "[&_td]:!py-1" : ""}`}>
              <colgroup>
                {selectionMode && <col style={{ width: 40 }} />}
                <col style={{ width: colWidths.name }} />
                <col style={{ width: colWidths.size }} />
                <col style={{ width: colWidths.ocr }} />
                <col style={{ width: colWidths.created }} />
                <col style={{ width: 40 }} />
              </colgroup>
              <thead className="sticky top-0 bg-[var(--glass-panel-bg)] backdrop-blur-xl border-b border-[var(--border-default)]">
                <tr>
                  {selectionMode && (
                    <th className="w-10 px-4 py-2 text-left">
                      <input
                        type="checkbox"
                        checked={selected.size === documents.length && documents.length > 0}
                        onChange={selectAll}
                        className="accent-teal-500 w-4 h-4"
                      />
                    </th>
                  )}
                  <SortableHeader
                    label="Nome" sortKey="name" sort={sort} onSort={toggleSort}
                    onResizeStart={(e) => startColResize("name", e)}
                    onResizeReset={() => resetColWidth("name")}
                  />
                  <SortableHeader
                    label="Tamanho" sortKey="size" sort={sort} onSort={toggleSort}
                    onResizeStart={(e) => startColResize("size", e)}
                    onResizeReset={() => resetColWidth("size")}
                  />
                  <th className="relative px-3 py-2 text-mac-caption font-semibold uppercase tracking-wide text-[var(--text-tertiary)] text-left">
                    OCR
                    <div
                      onMouseDown={(e) => startColResize("ocr", e)}
                      onDoubleClick={() => resetColWidth("ocr")}
                      className="absolute top-0 right-0 h-full w-2 cursor-col-resize select-none hover:bg-teal-400/40 active:bg-teal-400/60"
                    />
                  </th>
                  <SortableHeader
                    label="Criado em" sortKey="created_at" sort={sort} onSort={toggleSort}
                    onResizeStart={(e) => startColResize("created", e)}
                    onResizeReset={() => resetColWidth("created")}
                  />
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  if (item.kind === "folder") {
                    const f = item.data;
                    const isDropTarget = dragOverFolderId === f.id;
                    return (
                      <tr
                        key={`folder-${f.id}`}
                        className={`border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors duration-fast group ${
                          isDropTarget ? "bg-teal-500/10 outline outline-2 outline-teal-400 -outline-offset-2" : ""
                        }`}
                        onClick={() => setFocusedId(f.id)}
                        onDoubleClick={() => openFolder(f)}
                        onDragOver={(e) => {
                          if (!dragDocIds) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = "move";
                          if (dragOverFolderId !== f.id) {
                            setDragOverFolderId(f.id);
                            clearDragHoverTimer();
                            // Spring-loaded: mantendo o arquivo sobre a pasta por 1.2s, abre ela
                            // automaticamente — o estado de arraste (dragDocIds) sobrevive à
                            // navegação, então dá pra soltar dentro da pasta recém-aberta.
                            dragHoverTimerRef.current = setTimeout(() => {
                              openFolder(f);
                              setDragOverFolderId(null);
                              dragHoverTimerRef.current = null;
                            }, 1200);
                          }
                        }}
                        onDragLeave={() => {
                          setDragOverFolderId((prev) => (prev === f.id ? null : prev));
                          clearDragHoverTimer();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          clearDragHoverTimer();
                          if (dragDocIds) moveDocuments(dragDocIds, f.id, f.name);
                          setDragDocIds(null);
                          setDragOverFolderId(null);
                        }}
                      >
                        {selectionMode && <td className="px-4 py-2.5" />}
                        <td className="px-3 py-2.5">
                          {renaming?.kind === "folder" && renaming.id === f.id ? (
                            <input
                              ref={renameInputRef}
                              type="text"
                              value={renaming.value}
                              onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") confirmRename();
                                if (e.key === "Escape") setRenaming(null);
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onBlur={confirmRename}
                              className="w-full max-w-[280px] h-7 px-2 text-mac-body bg-[var(--bg-page)] border border-teal-500 rounded-[6px] text-[var(--text-primary)] focus:outline-none"
                            />
                          ) : (
                            <button
                              onClick={() => openFolder(f)}
                              className="flex items-center gap-2 text-mac-body text-[var(--text-primary)] hover:text-teal-500 transition-colors duration-fast"
                            >
                              <FolderOpen className="w-4 h-4 text-teal-500 flex-shrink-0" />
                              {f.name}
                            </button>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-mac-caption text-[var(--text-tertiary)]">—</td>
                        <td className="px-3 py-2.5" />
                        <td className="px-3 py-2.5 text-mac-caption text-[var(--text-tertiary)]">—</td>
                        <td className="px-2 py-2.5 flex items-center gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setSharingFolder(f); }}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-[var(--text-tertiary)] hover:text-teal-500 hover:bg-[var(--bg-hover)] transition-all duration-fast"
                            title="Compartilhar pasta"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteFolder(f); }}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-fast"
                            title="Excluir pasta"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  const d = item.data;
                  const isSelected = selected.has(d.id);
                  const isRenaming = renaming?.kind === "document" && renaming.id === d.id;
                  const isDragging = dragDocIds?.includes(d.id) ?? false;
                  return (
                    <tr
                      key={`doc-${d.id}`}
                      ref={(el) => { if (el) rowRefs.current.set(d.id, el); else rowRefs.current.delete(d.id); }}
                      className={`border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors duration-fast group cursor-pointer ${
                        isSelected ? "bg-teal-50 dark:bg-teal-900/20" : ""
                      } ${isDragging ? "opacity-40" : ""}`}
                      onClick={() => { setFocusedId(d.id); setDetailDoc(d); }}
                      draggable={!isRenaming}
                      onDragStart={(e) => {
                        const ids = selected.has(d.id) && selected.size > 1 ? [...selected] : [d.id];
                        setDragDocIds(ids);
                        e.dataTransfer.effectAllowed = "move";
                        // Tipo MIME custom pra sinalizar (ao FolderTree da sidebar,
                        // que tem seu próprio drag interno de pasta-pra-pasta) que
                        // isso é um drag de documento vindo de fora, não de pasta.
                        e.dataTransfer.setData("application/x-docke-document-ids", ids.join(","));
                        e.dataTransfer.setData("text/plain", ids.join(","));

                        // Imagem fantasma customizada (pill "N arquivos") no lugar do
                        // preview padrão do navegador — padrão Finder/Explorer/Drive.
                        const ghost = document.createElement("div");
                        ghost.textContent = ids.length > 1 ? `${ids.length} arquivos` : d.name;
                        ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;padding:6px 14px;background:#0d9488;color:#fff;border-radius:999px;font-size:13px;font-weight:500;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.35);font-family:inherit;";
                        document.body.appendChild(ghost);
                        e.dataTransfer.setDragImage(ghost, 14, 14);
                        setTimeout(() => document.body.removeChild(ghost), 0);
                      }}
                      onDragEnd={() => { setDragDocIds(null); setDragOverFolderId(null); }}
                    >
                      {selectionMode && (
                        <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(d.id)}
                            className="accent-teal-500 w-4 h-4"
                          />
                        </td>
                      )}
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          {(() => { const s = getFileStyle(d.name); const Icon = s.icon; return (
                            <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                              <Icon className={`w-3.5 h-3.5 ${s.iconColor}`} />
                            </div>
                          ); })()}
                          {isRenaming ? (
                            <div className="flex items-center gap-0.5 flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
                              <input
                                ref={renameInputRef}
                                type="text"
                                value={renaming.value}
                                onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") confirmRename();
                                  if (e.key === "Escape") setRenaming(null);
                                }}
                                onBlur={confirmRename}
                                className="h-7 px-2 text-mac-body bg-[var(--bg-page)] border border-teal-500 rounded-[6px] text-[var(--text-primary)] focus:outline-none flex-1 min-w-0"
                              />
                              <span className="text-mac-body text-[var(--text-tertiary)] flex-shrink-0">{splitExt(d.name)[1]}</span>
                            </div>
                          ) : (
                            <TruncatedFileName name={d.name} className="text-mac-body text-[var(--text-primary)]" />
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-mac-caption text-[var(--text-tertiary)]">{fmtSize(d.size_bytes)}</td>
                      <td className="px-3 py-2.5"><OcrIcon status={d.ocr_status} /></td>
                      <td className="px-3 py-2.5 text-mac-caption text-[var(--text-tertiary)]">{fmtDate(d.created_at)}</td>
                      <td className="px-2 py-2.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); setDetailDoc(d); }}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] transition-all duration-fast"
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
          {dragBox && (
            <div
              className="absolute border border-teal-500 bg-teal-500/10 pointer-events-none z-20"
              style={{
                left: Math.min(dragBox.x1, dragBox.x2),
                top: Math.min(dragBox.y1, dragBox.y2),
                width: Math.abs(dragBox.x2 - dragBox.x1),
                height: Math.abs(dragBox.y2 - dragBox.y1),
              }}
            />
          )}
        </div>
      </div>

      {/* Detail Drawer */}
      {detailDoc && (
        <DetailDrawer
          doc={detailDoc}
          onClose={() => setDetailDoc(null)}
          onPreview={() => setPreviewDoc(detailDoc)}
          onFavorite={() => {}}
          onDelete={() => { deleteDocuments([detailDoc.id]); setDetailDoc(null); }}
          onChanged={load}
        />
      )}

      {/* Modals */}
      {showUpload && current && (
        <UploadModal
          folderId={currentFolderId}
          companyId={current.id}
          onClose={() => setShowUpload(false)}
          onDone={load}
        />
      )}
      {showNewFolder && current && (
        <CreateFolderModal
          parentId={currentFolderId}
          companyId={current.id}
          onClose={() => setShowNewFolder(false)}
          onDone={() => { load(); setFolderTreeVersion((v) => v + 1); }}
        />
      )}
      {confirmDeleteFolder && (
        <ConfirmModal
          title={`Excluir pasta "${confirmDeleteFolder.name}"?`}
          description="Todo o conteúdo desta pasta será movido para a lixeira. Esta ação pode ser desfeita a partir da lixeira."
          confirmLabel="Excluir pasta"
          danger
          loading={deletingFolder}
          onConfirm={() => deleteFolder(confirmDeleteFolder)}
          onClose={() => setConfirmDeleteFolder(null)}
        />
      )}
      {sharingFolder && (
        <ShareModal resourceType="folder" resourceId={sharingFolder.id} name={sharingFolder.name} onClose={() => setSharingFolder(null)} />
      )}
      {previewDoc && (
        <PreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {/* Barra de ações em lote — flutuante, o caso mais puro de "vidro sobre conteúdo" */}
      <div
        className={`glass-panel glass-blur-pill fixed bottom-[76px] md:bottom-7 lg:bottom-[100px] left-1/2 flex items-center gap-1.5 rounded-[50px] pl-[18px] pr-1.5 py-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.55)] z-30 transition-[opacity,transform] duration-normal ${
          selected.size > 0 ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        style={{ transform: selected.size > 0 ? "translateX(-50%)" : "translateX(-50%) translateY(12px)" }}
      >
        <span className="text-mac-body text-[var(--text-primary)] mr-1.5 pl-2.5">
          <b className="text-[var(--teal-bright)] font-semibold">{selected.size}</b> selecionado{selected.size !== 1 ? "s" : ""}
        </span>
        <button
          onClick={deleteSelected}
          className="flex items-center gap-1.5 h-8 px-3.5 rounded-full text-mac-body text-red-400 bg-white/[0.07] hover:bg-red-500/[0.16] transition-colors duration-fast"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Excluir
        </button>
      </div>
    </div>
  );
}
