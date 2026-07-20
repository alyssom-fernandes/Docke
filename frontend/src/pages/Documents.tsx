import { Fragment, useEffect, useRef, useState, useCallback, type ElementType } from "react";
import { useSearchParams } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { relativeDate, fullDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import {
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Upload,
  Trash2,
  Anchor,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
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
  Pencil,
  Info,
  Search,
  Copy,
} from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { useNavigation } from "@/lib/NavigationContext";
import Button from "@/components/ui/Button";
import Badge from "@/components/ui/Badge";
import Checkbox from "@/components/ui/Checkbox";
import Tooltip from "@/components/ui/Tooltip";
import Dropdown from "@/components/ui/Dropdown";
import EmptyState from "@/components/shared/EmptyState";
import TruncatedFileName from "@/components/ui/TruncatedFileName";
import ConfirmModal from "@/components/ui/ConfirmModal";
import PreviewModal from "@/components/documents/PreviewModal";
import VersionsPanel from "@/components/documents/VersionsPanel";
import ShareModal from "@/components/documents/ShareModal";
import CopyStructureModal from "@/components/documents/CopyStructureModal";
import FolderTree from "@/components/documents/FolderTree";
import Portal from "@/components/ui/Portal";

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

// Metadados personalizados (ADENDO-08) — campo resolvido pra pasta atual
// (já com herança/override aplicados pelo backend) e valor preenchido por documento.
export type CustomFieldType = "texto" | "cpf" | "cnpj" | "data" | "competencia" | "numero" | "selecao";

export interface ResolvedField {
  custom_field_id: string;
  required: boolean;
  display_order: number;
  column_width: number | null;
  label: string;
  field_key: string;
  type: CustomFieldType;
  format_config: Record<string, unknown>;
}

interface DocFieldValueRow {
  document_id: string;
  custom_field_id: string;
  value_text: string;
  value_date: string | null;
  value_number: number | null;
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

// Coluna "Tipo" (Kind) — todo Finder/Explorer mostra o tipo por extenso ao
// lado do nome; nós só tínhamos o ícone colorido, que sozinho não é óbvio
// pra quem não conhece o mapeamento de cores (ADENDO-09 §13).
const KIND_LABELS: Record<string, string> = {
  pdf: "Documento PDF",
  xlsx: "Planilha Excel",
  xls: "Planilha Excel",
  csv: "Planilha CSV",
  docx: "Documento Word",
  doc: "Documento Word",
  xml: "Documento XML",
  jpg: "Imagem JPEG",
  jpeg: "Imagem JPEG",
  png: "Imagem PNG",
  gif: "Imagem GIF",
  txt: "Documento de texto",
};
function kindLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return KIND_LABELS[ext] ?? (ext ? `Arquivo ${ext.toUpperCase()}` : "Documento");
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
    <Tooltip label={label}>
      <span aria-label={label} className="inline-flex">
        <Icon className={`w-4 h-4 ${className}`} />
      </span>
    </Tooltip>
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

const DEFAULT_COL_WIDTHS = { name: 320, kind: 150, size: 100, ocr: 70, created: 110 };

function SortableHeader({ label, sortKey, sort, onSort, className = "", align = "left", onResizeStart, onResizeReset }: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (key: SortKey) => void;
  className?: string;
  /** Colunas numéricas (Tamanho) alinham à direita, igual convenção Finder/Explorer */
  align?: "left" | "right";
  /** Início do drag-to-resize (mousedown na borda direita) — Explorer/Excel pattern */
  onResizeStart?: (e: React.MouseEvent) => void;
  /** Duplo-clique na borda reseta pro tamanho padrão (autofit simplificado) */
  onResizeReset?: () => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th className={`relative px-3 py-2 text-mac-caption font-normal text-[var(--text-secondary)] text-left ${className}`}>
      <button
        onClick={() => onSort(sortKey)}
        className={`group/sort flex items-center gap-1 w-full hover:text-[var(--text-primary)] transition-colors duration-fast ${active ? "text-[var(--text-primary)] font-medium" : ""} ${align === "right" ? "justify-end" : "justify-between"}`}
      >
        {align === "right" && (active ? (
          sort.dir === "asc" ? <ChevronUp className="w-3 h-3 flex-shrink-0" /> : <ChevronDown className="w-3 h-3 flex-shrink-0" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 flex-shrink-0 opacity-0 group-hover/sort:opacity-40 transition-opacity duration-fast" />
        ))}
        <span className="truncate">{label}</span>
        {align === "left" && (active ? (
          sort.dir === "asc" ? <ChevronUp className="w-3 h-3 flex-shrink-0" /> : <ChevronDown className="w-3 h-3 flex-shrink-0" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 flex-shrink-0 opacity-0 group-hover/sort:opacity-40 transition-opacity duration-fast" />
        ))}
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
    <Portal>
    <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={uploadContainerRef} className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[480px]">
        <div className="px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Upload de documentos</h2>
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
          <div className="mx-5 mb-1 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-[var(--radius-control)] text-mac-caption text-amber-800 dark:text-amber-300">
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
    </Portal>
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
    <Portal>
    <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={folderContainerRef} className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[360px]">
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
            className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
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
    </Portal>
  );
}

// ─── Detail Drawer ────────────────────────────────────────────────────────────

// Metadados personalizados (ADENDO-08 M-G): campos resolvidos pra pasta do
// documento, com formulário dinâmico por tipo. Some da tela se a pasta não
// tem nenhum campo aplicado — não polui Detalhes pra quem não usa a feature.
function MetadataSection({ doc, companyId, onChanged }: { doc: Document; companyId: string; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [fields, setFields] = useState<ResolvedField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!doc.folder_id) { setFields([]); setLoading(false); return; }
    setLoading(true);
    Promise.all([
      api.get<ResolvedField[]>("/folder-fields/resolved", { params: { company_id: companyId, folder_id: doc.folder_id } }),
      api.get<DocFieldValueRow[]>(`/documents/${doc.id}/field-values`),
    ]).then(([fRes, vRes]) => {
      setFields(Array.isArray(fRes.data) ? [...fRes.data].sort((a, b) => a.display_order - b.display_order) : []);
      const vmap: Record<string, string> = {};
      for (const row of Array.isArray(vRes.data) ? vRes.data : []) vmap[row.custom_field_id] = row.value_text;
      setValues(vmap);
    }).catch(() => { setFields([]); setValues({}); }).finally(() => setLoading(false));
  }, [doc.id, doc.folder_id, companyId]);

  if (loading || fields.length === 0) return null;

  async function save() {
    setSaving(true);
    try {
      const body = fields
        .filter((f) => (values[f.custom_field_id] ?? "").trim())
        .map((f) => ({ custom_field_id: f.custom_field_id, value: values[f.custom_field_id].trim() }));
      await api.put(`/documents/${doc.id}/field-values`, body, { params: { company_id: companyId } });
      success("Metadados salvos.");
      // Sem isso a coluna de metadado na tabela ficava com o valor antigo até
      // recarregar a página inteira — o fetch em lote de fieldValues só refaz
      // quando a referência de `documents` muda (ver efeito na Documents()).
      onChanged();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Erro ao salvar metadados.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-2 border-t border-[var(--border-default)] space-y-3">
      <p className="text-mac-body font-semibold text-[var(--text-secondary)]">Metadados</p>
      {fields.map((f) => (
        <div key={f.custom_field_id}>
          <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1">
            {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
          {f.type === "selecao" ? (
            <Dropdown
              value={values[f.custom_field_id] ?? ""}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.custom_field_id]: v }))}
              placeholder="—"
              options={((f.format_config?.options as string[]) ?? []).map((o) => ({ value: o, label: o }))}
            />
          ) : (
            <input
              type="text"
              value={values[f.custom_field_id] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.custom_field_id]: e.target.value }))}
              placeholder={
                f.type === "cpf" ? "000.000.000-00" :
                f.type === "cnpj" ? "00.000.000/0000-00" :
                f.type === "data" ? "dd/mm/aaaa" :
                f.type === "competencia" ? "mm/aaaa" :
                f.type === "numero" ? "0" : ""
              }
              className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          )}
        </div>
      ))}
      <Button size="sm" loading={saving} onClick={save} className="w-full">Salvar metadados</Button>
    </div>
  );
}

function DetailDrawer({ doc, companyId, onClose, onFavorite, onPreview, onDelete, onChanged }: { doc: Document; companyId: string; onClose: () => void; onFavorite: () => void; onPreview: () => void; onDelete: () => void; onChanged: () => void }) {
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
    <Portal>
    <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[420px] max-h-[85vh] overflow-y-auto">
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
              <Icon className={`w-5 h-5 ${s.iconColor} ${s.fillColor}`} />
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

        <MetadataSection doc={doc} companyId={companyId} onChanged={onChanged} />

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
    </Portal>
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

  // Histórico de navegação (voltar/avançar) — Finder/Explorer sempre têm esses
  // botões na ponta esquerda da barra de ferramentas; sem eles a tela não lê
  // como um navegador de arquivos de verdade. Independente dos breadcrumbs
  // (que só refletem o caminho atual, não o histórico de onde já se esteve).
  const [navHistory, setNavHistory] = useState<
    Array<{ folderId: string | null; breadcrumbs: Array<{ id: string | null; name: string }> }>
  >([{ folderId: currentFolderId, breadcrumbs }]);
  const [navIndex, setNavIndex] = useState(0);
  const skipHistoryPushRef = useRef(false);
  useEffect(() => {
    if (skipHistoryPushRef.current) { skipHistoryPushRef.current = false; return; }
    setNavHistory((prev) => [...prev.slice(0, navIndex + 1), { folderId: currentFolderId, breadcrumbs }]);
    setNavIndex((i) => i + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId]);
  function goBack() {
    if (navIndex <= 0) return;
    const target = navHistory[navIndex - 1];
    skipHistoryPushRef.current = true;
    setNavIndex((i) => i - 1);
    setCurrentFolderId(target.folderId);
    setBreadcrumbs(target.breadcrumbs);
    setDetailDoc(null);
    setFocusedId(null);
  }
  function goForward() {
    if (navIndex >= navHistory.length - 1) return;
    const target = navHistory[navIndex + 1];
    skipHistoryPushRef.current = true;
    setNavIndex((i) => i + 1);
    setCurrentFolderId(target.folderId);
    setBreadcrumbs(target.breadcrumbs);
    setDetailDoc(null);
    setFocusedId(null);
  }
  const canGoBack = navIndex > 0;
  const canGoForward = navIndex < navHistory.length - 1;

  // Seção "Ancorados" na sidebar — todo Finder de verdade agrupa a árvore de
  // pastas sob rótulos de seção ("Favorites", "Locations"); usamos a mesma
  // convenção com os itens que o usuário já ancorou, dando acesso rápido
  // cross-pasta como o Finder faz com seus atalhos de Favoritos.
  interface SidebarFavorite {
    id: string;
    item_type: "document" | "folder";
    document_id: string | null;
    folder_id: string | null;
    document_folder_id: string | null;
    item_name: string;
  }
  const [sidebarFavorites, setSidebarFavorites] = useState<SidebarFavorite[]>([]);
  const loadSidebarFavorites = useCallback(() => {
    if (!current) return;
    api.get<SidebarFavorite[]>("/favorites", { params: { company_id: current.id } })
      .then((r) => setSidebarFavorites(Array.isArray(r.data) ? r.data : []))
      .catch(() => setSidebarFavorites([]));
  }, [current?.id]);
  useEffect(() => { loadSidebarFavorites(); }, [loadSidebarFavorites]);
  function openSidebarFavorite(fav: SidebarFavorite) {
    if (fav.item_type === "folder" && fav.folder_id) {
      jumpToFolder(fav.folder_id);
    } else if (fav.document_id) {
      setSearchParams({ folder_id: fav.document_folder_id ?? "", doc: fav.document_id });
    }
  }

  const [loading, setLoading] = useState(true);
  // Seções da sidebar recolhíveis (Ancorados/Locais) — o Finder real deixa
  // cada grupo com um chevron de disclosure independente, a sidebar do Docke
  // até agora era estática (sem essa possibilidade).
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState<Set<string>>(new Set());
  function toggleSidebarSection(key: string) {
    setCollapsedSidebarSections((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailDoc, setDetailDoc] = useState<Document | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<Folder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
  const [copyingFolder, setCopyingFolder] = useState<Folder | null>(null);
  // Menu de contexto (clique direito) — padrão Finder/Explorer: menu customizado
  // como interação primária, o botão "..." continua existindo como alternativa
  // pra quem não sabe do clique direito (§13.4 do ADENDO-09).
  const [contextMenu, setContextMenu] = useState<
    { x: number; y: number; kind: "document"; data: Document } | { x: number; y: number; kind: "folder"; data: Folder } | null
  >(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  function openContextMenu(e: React.MouseEvent, kind: "document" | "folder", data: Document | Folder) {
    e.preventDefault();
    e.stopPropagation();
    setFocusedId(data.id);
    const menuWidth = 200;
    const menuHeight = 190;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 8);
    setContextMenu({ x, y, kind, data } as typeof contextMenu);
  }
  useEffect(() => {
    if (!contextMenu) return;
    // Fecha só em mousedown FORA do menu — sem o containment check, qualquer
    // clique num item (Renomear, Excluir, etc.) fechava o menu no mousedown,
    // antes do click do próprio item disparar, engolindo a ação inteira.
    function close(e: Event) {
      if (contextMenuRef.current && e.target instanceof Node && contextMenuRef.current.contains(e.target)) return;
      setContextMenu(null);
    }
    function closeOnEscape(e: KeyboardEvent) { if (e.key === "Escape") setContextMenu(null); }
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("blur", close);
    };
  }, [contextMenu]);
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

  // Expansão inline de pastas (triângulo de disclosure) — o recurso mais
  // característico do Finder/Explorer em visão de lista: ver o conteúdo de
  // uma subpasta sem perder o contexto da pasta atual. Escopo deliberadamente
  // simples: itens aninhados são só navegáveis (clique abre), não participam
  // da seleção múltipla/drag/rubber-band da pasta atual — evita reintroduzir
  // ambiguidade em toda a lógica de `selected` que assume ids de um único nível.
  const [expandedFolders, setExpandedFolders] = useState<Record<string, { folders: Folder[]; documents: Document[] } | "loading">>({});
  useEffect(() => { setExpandedFolders({}); }, [currentFolderId]);
  async function toggleExpandFolder(e: React.MouseEvent, folderId: string) {
    e.stopPropagation();
    if (expandedFolders[folderId]) {
      setExpandedFolders((prev) => { const next = { ...prev }; delete next[folderId]; return next; });
      return;
    }
    if (!current) return;
    setExpandedFolders((prev) => ({ ...prev, [folderId]: "loading" }));
    try {
      const [fRes, dRes] = await Promise.all([
        api.get<Folder[]>("/folders", { params: { company_id: current.id, parent_id: folderId } }),
        api.get<Document[]>("/documents", { params: { company_id: current.id, folder_id: folderId } }),
      ]);
      setExpandedFolders((prev) => ({
        ...prev,
        [folderId]: {
          folders: Array.isArray(fRes.data) ? [...fRes.data].sort((a, b) => a.name.localeCompare(b.name)) : [],
          documents: Array.isArray(dRes.data) ? [...dRes.data].sort((a, b) => a.name.localeCompare(b.name)) : [],
        },
      }));
    } catch {
      setExpandedFolders((prev) => { const next = { ...prev }; delete next[folderId]; return next; });
      showError("Não foi possível expandir a pasta.");
    }
  }

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

  // Typeahead — digitar letras pula pro primeiro item cujo nome começa com elas,
  // exatamente como Finder/Explorer em qualquer lista. Buffer acumula por 800ms
  // (janela padrão do gesto) e então reseta, permitindo digitar várias letras
  // em sequência pra refinar o alvo (ex: "ho" pula pra "Holerite" em vez de "Home").
  const typeaheadBufferRef = useRef("");
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Atalhos globais: Space abre preview do item focado, F2 inicia renomeação inline —
  // desativados quando o usuário está digitando em outro campo ou há modal aberto.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      const modalOpen = !!(detailDoc || previewDoc || showUpload || showNewFolder || confirmDeleteFolder || sharingFolder || copyingFolder);
      if (typing || modalOpen) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(documents.map((d) => d.id)));
        return;
      }

      // Typeahead: uma única letra/dígito sem modificador, fora dos atalhos acima.
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        typeaheadBufferRef.current += e.key.toLowerCase();
        if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
        typeaheadTimerRef.current = setTimeout(() => { typeaheadBufferRef.current = ""; }, 800);

        const query = typeaheadBufferRef.current;
        const sortedFoldersLocal = [...folders].sort((a, b) => a.name.localeCompare(b.name));
        const sortedDocsLocal = [...documents].sort((a, b) => a.name.localeCompare(b.name));
        const folderMatch = sortedFoldersLocal.find((f) => f.name.toLowerCase().startsWith(query));
        const docMatch = sortedDocsLocal.find((d) => d.name.toLowerCase().startsWith(query));
        const match = folderMatch ?? docMatch;
        if (match) {
          e.preventDefault();
          setFocusedId(match.id);
          if ("size_bytes" in match) {
            setSelected(new Set([match.id]));
            rowRefs.current.get(match.id)?.scrollIntoView({ block: "nearest" });
          }
        }
        return;
      }

      if (!focusedId) return;

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
  }, [focusedId, documents, folders, detailDoc, previewDoc, showUpload, showNewFolder, confirmDeleteFolder, sharingFolder, copyingFolder]);

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

  // Filtro rápido por nome, escopado à pasta atual — todo navegador de arquivos
  // de verdade (Finder, Explorer) tem um campo de busca sempre visível na própria
  // barra de ferramentas, distinto da busca global do app (ADENDO-09 §13).
  const [filterQuery, setFilterQuery] = useState("");
  useEffect(() => { setFilterQuery(""); }, [currentFolderId]);

  // Checkboxes ficam ocultos por padrão (poluem a tabela pra quem só navega);
  // o botão "Selecionar" na toolbar liga o modo de seleção em massa.
  const [selectionMode, setSelectionMode] = useState(false);
  // Sair do modo de seleção precisa limpar `selected` — sem isso a barra
  // flutuante "N selecionado(s) / Excluir" continuava ativa e clicável (e a
  // linha ficava destacada) mesmo sem checkboxes visíveis na tabela.
  useEffect(() => {
    if (!selectionMode) setSelected(new Set());
  }, [selectionMode]);
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

  // Metadados personalizados (ADENDO-08 M-H): colunas extras na tabela, resolvidas
  // pra pasta atual (herança já aplicada pelo backend). Raiz não tem pasta real —
  // sem folder_id não há onde os campos "penderem", então não busca lá.
  const [resolvedFields, setResolvedFields] = useState<ResolvedField[]>([]);
  useEffect(() => {
    if (!current || !currentFolderId) { setResolvedFields([]); return; }
    api.get<ResolvedField[]>("/folder-fields/resolved", { params: { company_id: current.id, folder_id: currentFolderId } })
      .then((r) => setResolvedFields(Array.isArray(r.data) ? [...r.data].sort((a, b) => a.display_order - b.display_order) : []))
      .catch(() => setResolvedFields([]));
  }, [current?.id, currentFolderId]);

  // documentId -> custom_field_id -> value_text
  const [fieldValues, setFieldValues] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    if (!resolvedFields.length || !documents.length) { setFieldValues({}); return; }
    const ids = documents.map((d) => d.id).join(",");
    api.get<DocFieldValueRow[]>("/documents/field-values", { params: { document_ids: ids } })
      .then((r) => {
        const map: Record<string, Record<string, string>> = {};
        for (const row of Array.isArray(r.data) ? r.data : []) {
          (map[row.document_id] ??= {})[row.custom_field_id] = row.value_text;
        }
        setFieldValues(map);
      })
      .catch(() => setFieldValues({}));
  }, [resolvedFields.length, documents]);

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
    if (folder.id === currentFolderId) return;
    setCurrentFolderId(folder.id);
    setBreadcrumbs((prev) =>
      prev[prev.length - 1]?.id === folder.id ? prev : [...prev, { id: folder.id, name: folder.name }]
    );
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

  // Filtro rápido aplicado por cima da ordenação — não mexe na seleção nem
  // na ordenação salva, só restringe o que é exibido/alcançável por clique.
  const filterQ = filterQuery.trim().toLowerCase();
  const visibleFolders = filterQ ? sortedFolders.filter((f) => f.name.toLowerCase().includes(filterQ)) : sortedFolders;
  const visibleDocuments = filterQ ? sortedDocuments.filter((d) => d.name.toLowerCase().includes(filterQ)) : sortedDocuments;

  // Pastas sempre no topo (convenção de gerenciador de arquivos); só os documentos respeitam a ordenação escolhida
  const items: Item[] = [
    ...visibleFolders.map((f): Item => ({ kind: "folder", data: f })),
    ...visibleDocuments.map((d): Item => ({ kind: "document", data: d })),
  ];

  // Clique em documento — Shift estende o intervalo a partir do último item
  // focado, Ctrl/Cmd alterna a seleção individual, clique simples troca a
  // seleção pra só esse item (padrão Finder/Explorer, "inviolável" — consenso
  // de 5 fontes independentes no ADENDO-09 §13.2).
  function selectDocClick(e: React.MouseEvent, id: string) {
    // Toque longo (handleTouchStart) já tratou a seleção pro mobile — o
    // "click" sintético que o navegador dispara logo depois do touchend não
    // deve sobrescrever com seleção de item único.
    if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
    const ids = visibleDocuments.map((d) => d.id);
    if (e.shiftKey && focusedId && ids.includes(focusedId)) {
      const i1 = ids.indexOf(focusedId);
      const i2 = ids.indexOf(id);
      const [from, to] = i1 < i2 ? [i1, i2] : [i2, i1];
      setSelected(new Set(ids.slice(from, to + 1)));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      setFocusedId(id);
      return;
    }
    if (selected.size === 1 && selected.has(id)) {
      setSelected(new Set());
      setFocusedId(null);
      return;
    }
    setSelected(new Set([id]));
    setFocusedId(id);
  }

  // Toque longo entra no modo de seleção e marca o item — padrão universal
  // de touch em gerenciadores de arquivo (checkbox sempre visível polui a
  // interface no mobile, consenso do ADENDO-09 §13.2).
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  function handleTouchStart(e: React.TouchEvent, id: string) {
    const touch = e.touches[0];
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      setSelectionMode(true);
      toggleSelect(id);
      navigator.vibrate?.(10);
    }, 500);
  }
  function handleTouchMove(e: React.TouchEvent) {
    if (!touchStartPosRef.current || !longPressTimerRef.current) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }
  function handleTouchEnd() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  return (
    // h-full sozinho só devolve 100% da CONTENT-BOX do pai (já sem o py-6),
    // então -my-6 empurra o topo pra cima mas a altura não cresce pra
    // compensar — sobra um vão morto de 48px (2×24px) antes do rodapé,
    // como se a calça estivesse curta. calc(100% + 3rem) soma de volta
    // exatamente o padding vertical cancelado, preenchendo o espaço todo.
    // Sidebar e tabela numa janela única de vidro (sem gap entre elas, só
    // uma linha divisória) — igual ao Finder real, que vive num único frame
    // de janela. Antes eram dois glass-panel flutuando lado a lado com
    // gap-4, lendo como "duas caixas" em vez de uma janela coesa (mesmo
    // ajuste feito em Settings/SettingsLayout.tsx).
    <div
      className={`flex h-[calc(100%+3rem)] -mt-6 py-2 glass-panel glass-highlight-line rounded-[var(--radius-panel)] glass-shadow overflow-hidden ${
        tableScrolling ? "glass-scroll-active" : ""
      } glass-blur-table`}
    >
      {/* Sidebar de pastas — desktop only (lg+) */}
      <aside className="hidden lg:flex flex-col w-[220px] flex-shrink-0 border-r border-[var(--border-default)]">
        <div className="px-3 py-3 border-b border-[var(--border-default)] flex-shrink-0">
          <h2 className="text-mac-body font-semibold text-[var(--text-secondary)]">Pastas</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {/* Seção "Ancorados" — mesmo agrupamento por rótulo em caixa alta que
              o Finder usa pra "Favorites": atalho direto pra itens ancorados,
              cruzando pastas, sem precisar navegar até eles (ADENDO-09 §13). */}
          {sidebarFavorites.length > 0 && (
            <>
              <button
                onClick={() => toggleSidebarSection("ancorados")}
                className="w-full flex items-center gap-1 px-2.5 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors duration-fast"
              >
                <ChevronDown className={`w-2.5 h-2.5 flex-shrink-0 transition-transform duration-fast ${collapsedSidebarSections.has("ancorados") ? "-rotate-90" : ""}`} />
                Ancorados
              </button>
              {!collapsedSidebarSections.has("ancorados") &&
                sidebarFavorites.slice(0, 6).map((fav) => (
                  <button
                    key={fav.id}
                    onClick={() => openSidebarFavorite(fav)}
                    className="w-full flex items-center gap-1.5 h-8 pl-3 pr-2 text-mac-body rounded-[6px] transition-colors duration-fast text-left text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                  >
                    {fav.item_type === "folder" ? (
                      <Folder className="w-4 h-4 text-teal-500 flex-shrink-0" />
                    ) : (
                      (() => { const s = getFileStyle(fav.item_name); const Icon = s.icon; return <Icon className={`w-4 h-4 flex-shrink-0 ${s.iconColor} ${s.fillColor}`} />; })()
                    )}
                    <span className="truncate">{fav.item_name}</span>
                  </button>
                ))}
            </>
          )}

          {/* Seções separadas só por respiro vertical, sem linha divisória —
              é assim que o Finder separa Favorites/Locations/Tags na sidebar.
              Cada seção agora tem seu próprio chevron de disclosure, igual à
              referência real do Finder (docs/pdf/figma_extracted/Sidebars.pdf). */}
          <button
            onClick={() => toggleSidebarSection("locais")}
            className={`w-full flex items-center gap-1 px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors duration-fast ${sidebarFavorites.length > 0 ? "pt-3" : "pt-1.5"}`}
          >
            <ChevronDown className={`w-2.5 h-2.5 flex-shrink-0 transition-transform duration-fast ${collapsedSidebarSections.has("locais") ? "-rotate-90" : ""}`} />
            Locais
          </button>
          {!collapsedSidebarSections.has("locais") && (
            <>
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
            </>
          )}
        </div>
      </aside>

      {/* Main area — o vidro/blur (ADR-017: blur raso, sem re-render no scroll)
          agora vive no wrapper externo, compartilhado com a sidebar. */}
      <div ref={tableWrapRef} className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-[var(--border-default)] flex-shrink-0">
          {/* Voltar/avançar — todo navegador de arquivos de verdade (Finder,
              Explorer) tem esse par de botões na ponta esquerda da barra de
              ferramentas; histórico independente do breadcrumb (que só
              reflete o caminho atual). */}
          <div className="hidden sm:flex items-center gap-0.5 flex-shrink-0">
            <Tooltip label="Voltar">
              <button
                onClick={goBack}
                disabled={!canGoBack}
                className="h-7 w-7 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast disabled:opacity-30 disabled:pointer-events-none"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </Tooltip>
            <Tooltip label="Avançar">
              <button
                onClick={goForward}
                disabled={!canGoForward}
                className="h-7 w-7 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast disabled:opacity-30 disabled:pointer-events-none"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>

          {/* Título da janela (sm+) — o Finder real só mostra o nome da pasta
              atual na toolbar (nunca uma trilha clicável: "Use a path control
              in the window body, not the window frame", HIG). A trilha
              navegável completa mora na barra de caminho no rodapé, abaixo. */}
          <div className="hidden sm:flex items-center flex-1 min-w-0">
            <span className="text-mac-body font-semibold text-[var(--text-primary)] truncate">
              {breadcrumbs[breadcrumbs.length - 1].name}
            </span>
          </div>

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
                    <div className="popover-tail-left absolute top-full left-0 mt-1 w-56 glass-panel glass-blur-strong rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50">
                      {breadcrumbs.slice(1, -1).map((crumb, i) => (
                        <button
                          key={crumb.id}
                          onClick={() => { navigateBreadcrumb(i + 1); setCrumbMenuOpen(false); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-left text-[var(--text-primary)] hover:bg-teal-500 hover:text-white [&:hover_svg]:text-white transition-colors duration-fast"
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
            {/* Filtro rápido — Finder/Explorer sempre têm um campo de busca na
                própria toolbar, distinto da busca global do app (ADENDO-09 §13). */}
            <div className="hidden md:flex items-center relative">
              <Search className="absolute left-2.5 w-3.5 h-3.5 text-[var(--text-placeholder)] pointer-events-none" />
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filtrar nesta pasta"
                className="h-7 w-[150px] focus:w-[210px] pl-7 pr-2 text-mac-caption bg-black/[0.03] dark:bg-white/[0.04] border border-transparent rounded-full text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:bg-[var(--bg-card)] focus:border-teal-500/50 transition-all duration-fast"
              />
            </div>
            {/* Controle segmentado — mesmo padrão do agrupador de visualização no
                Finder (um único "pill" com divisórias), em vez de 3 ícones soltos. */}
            <div className="hidden sm:flex items-center gap-0.5 p-0.5 rounded-full bg-black/[0.03] dark:bg-white/[0.04]">
              <button
                onClick={() => setSelectionMode((v) => !v)}
                title={selectionMode ? "Sair do modo de seleção" : "Selecionar vários"}
                className={`h-7 w-7 flex items-center justify-center rounded-full transition-colors duration-fast ${
                  selectionMode ? "bg-[var(--bg-card)] text-teal-500 shadow-sm" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <ListChecks className="w-4 h-4" />
              </button>
              <button
                onClick={toggleDensity}
                title={density === "comfortable" ? "Densidade compacta" : "Densidade confortável"}
                className="h-7 w-7 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors duration-fast"
              >
                {density === "comfortable" ? <Rows3 className="w-4 h-4" /> : <Rows4 className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setView(viewMode === "list" ? "grid" : "list")}
                title={viewMode === "list" ? "Ver em grade" : "Ver em lista"}
                className="h-7 w-7 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors duration-fast"
              >
                {viewMode === "list" ? <LayoutGrid className="w-4 h-4" /> : <List className="w-4 h-4" />}
              </button>
            </div>
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
                <div className="popover-tail-right absolute top-full right-0 mt-1 w-52 glass-panel glass-blur-strong rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50">
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setSelectionMode((v) => !v); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white transition-colors duration-fast"
                  >
                    <ListChecks className="w-4 h-4" />
                    {selectionMode ? "Sair da seleção" : "Selecionar vários"}
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setShowNewFolder(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white transition-colors duration-fast"
                  >
                    <FolderPlus className="w-4 h-4" />
                    Nova pasta
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); toggleDensity(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white transition-colors duration-fast"
                  >
                    {density === "comfortable" ? <Rows3 className="w-4 h-4" /> : <Rows4 className="w-4 h-4" />}
                    {density === "comfortable" ? "Densidade compacta" : "Densidade confortável"}
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setView(viewMode === "list" ? "grid" : "list"); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white transition-colors duration-fast"
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
              {filterQ ? (
                <EmptyState
                  title="Nenhum resultado"
                  description={`Nada corresponde a "${filterQuery.trim()}" nesta pasta.`}
                  icon={<Search className="w-6 h-6" />}
                />
              ) : (
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
              )}
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
                      onContextMenu={(e) => openContextMenu(e, "folder", f)}
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
                      <div className="absolute top-1 right-1 flex sm:hidden sm:group-hover:flex items-center gap-0.5 z-10">
                        <button
                          onClick={(e) => { e.stopPropagation(); setSharingFolder(f); }}
                          className="p-1 rounded-full text-[var(--text-tertiary)] hover:text-teal-500 hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                          title="Compartilhar pasta"
                        >
                          <Share2 className="w-3 h-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteFolder(f); }}
                          className="p-1 rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                          title="Excluir pasta"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <Folder className="w-10 h-10 text-teal-500 fill-teal-500/20 flex-shrink-0" />
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
                const isRenamingDoc = renaming?.kind === "document" && renaming.id === d.id;
                const s = getFileStyle(d.name);
                const Icon = s.icon;
                return (
                  <div
                    key={`doc-${d.id}`}
                    ref={(el) => { if (el) rowRefs.current.set(d.id, el); else rowRefs.current.delete(d.id); }}
                    className={`group relative flex flex-col items-center gap-1.5 py-3 px-2 rounded-[var(--radius-control)] cursor-pointer transition-colors duration-fast ${
                      isSelected ? "bg-teal-500" : "hover:bg-[var(--bg-hover)]"
                    } ${isDragging ? "opacity-40" : ""}`}
                    onClick={(e) => selectDocClick(e, d.id)}
                    onDoubleClick={() => setDetailDoc(d)}
                    onContextMenu={(e) => openContextMenu(e, "document", d)}
                    onTouchStart={(e) => handleTouchStart(e, d.id)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    draggable={!isRenamingDoc}
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
                      <Checkbox
                        checked={isSelected}
                        onChange={() => toggleSelect(d.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute top-1 left-1 z-10"
                      />
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); setDetailDoc(d); }}
                      className="absolute top-1 right-1 flex sm:hidden sm:group-hover:flex p-1 rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast z-10"
                    >
                      <MoreHorizontal className="w-3 h-3" />
                    </button>
                    <div className={`w-10 h-10 rounded-[6px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-5 h-5 ${s.iconColor} ${s.fillColor}`} />
                    </div>
                    {isRenamingDoc ? (
                      <div className="flex items-center gap-0.5 w-full justify-center" onClick={(e) => e.stopPropagation()}>
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
                          className="w-full min-w-0 h-6 px-1 text-mac-caption text-center bg-[var(--bg-page)] border border-teal-500 rounded-[4px] text-[var(--text-primary)] focus:outline-none"
                        />
                        <span className="text-mac-caption text-[var(--text-tertiary)] flex-shrink-0">{splitExt(d.name)[1]}</span>
                      </div>
                    ) : (
                      <span className={`text-mac-caption text-center leading-tight w-full line-clamp-2 ${isSelected ? "text-white" : "text-[var(--text-primary)]"}`}>{d.name}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            // overflow-x-auto: com colunas redimensionáveis (table-fixed) a soma das
            // larguras pode passar do viewport no mobile — rola em vez de cortar/quebrar.
            <div className="overflow-x-auto">
            <table className={`w-full table-auto sm:table-fixed select-none ${density === "compact" ? "[&_td]:!py-1" : "[&_td]:!py-1.5"}`}>
              <colgroup>
                {selectionMode && <col style={{ width: 40 }} />}
                <col style={{ width: colWidths.name }} />
                <col className="hidden sm:table-column" style={{ width: colWidths.created }} />
                <col className="hidden sm:table-column" style={{ width: colWidths.size }} />
                <col className="hidden sm:table-column" style={{ width: colWidths.ocr }} />
                <col className="hidden md:table-column" style={{ width: colWidths.kind }} />
                {resolvedFields.map((f) => (
                  <col key={f.custom_field_id} className="hidden sm:table-column" style={{ width: f.column_width ?? 130 }} />
                ))}
                {/* 76px — precisa caber os DOIS botões de ação da linha de
                    pasta (Compartilhar + Excluir) lado a lado, não só o
                    único "..." da linha de documento. Com 40px o table-fixed
                    ainda respeita o min-content dos botões e estoura a
                    largura da tabela, criando scroll horizontal indevido
                    mesmo sobrando espaço lateral. */}
                <col style={{ width: 76 }} />
              </colgroup>
              <thead className="sticky top-0 bg-[var(--glass-panel-bg)] backdrop-blur-xl border-b border-[var(--border-default)]">
                <tr>
                  {selectionMode && (
                    <th className="w-10 px-4 py-2 text-left">
                      <Checkbox
                        checked={selected.size === documents.length && documents.length > 0}
                        onChange={selectAll}
                      />
                    </th>
                  )}
                  <SortableHeader
                    label="Nome" sortKey="name" sort={sort} onSort={toggleSort}
                    onResizeStart={(e) => startColResize("name", e)}
                    onResizeReset={() => resetColWidth("name")}
                  />
                  {/* Ordem das colunas espelha o Finder: Nome, Modificado, Tamanho, Tipo —
                      OCR é a única coluna sem equivalente, encaixada entre Tamanho e Tipo. */}
                  <SortableHeader
                    label="Criado em" sortKey="created_at" sort={sort} onSort={toggleSort}
                    className="hidden sm:table-cell"
                    onResizeStart={(e) => startColResize("created", e)}
                    onResizeReset={() => resetColWidth("created")}
                  />
                  <SortableHeader
                    label="Tamanho" sortKey="size" sort={sort} onSort={toggleSort}
                    className="hidden sm:table-cell"
                    align="right"
                    onResizeStart={(e) => startColResize("size", e)}
                    onResizeReset={() => resetColWidth("size")}
                  />
                  <th className="relative px-3 py-2 text-mac-caption font-normal text-[var(--text-secondary)] text-left hidden sm:table-cell">
                    OCR
                    <div
                      onMouseDown={(e) => startColResize("ocr", e)}
                      onDoubleClick={() => resetColWidth("ocr")}
                      className="absolute top-0 right-0 h-full w-2 cursor-col-resize select-none hover:bg-teal-400/40 active:bg-teal-400/60"
                    />
                  </th>
                  <th className="relative px-3 py-2 text-mac-caption font-normal text-[var(--text-secondary)] text-left hidden md:table-cell">
                    Tipo
                    <div
                      onMouseDown={(e) => startColResize("kind", e)}
                      onDoubleClick={() => resetColWidth("kind")}
                      className="absolute top-0 right-0 h-full w-2 cursor-col-resize select-none hover:bg-teal-400/40 active:bg-teal-400/60"
                    />
                  </th>
                  {resolvedFields.map((f) => (
                    <th key={f.custom_field_id} className="px-3 py-2 text-mac-caption font-normal text-[var(--text-secondary)] text-left truncate hidden sm:table-cell">
                      {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
                    </th>
                  ))}
                  <th className="w-[76px]" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  if (item.kind === "folder") {
                    const f = item.data;
                    const isDropTarget = dragOverFolderId === f.id;
                    const expanded = expandedFolders[f.id];
                    const nestedColSpan = (selectionMode ? 1 : 0) + 6 + resolvedFields.length;
                    return (
                      <Fragment key={`folder-${f.id}`}>
                      <tr
                        className={`border-b border-[var(--border-default)] odd:bg-black/[0.04] dark:odd:bg-white/[0.035] hover:bg-[var(--bg-hover)] transition-colors duration-fast group ${
                          isDropTarget ? "bg-teal-500/10 outline outline-2 outline-teal-400 -outline-offset-2" : ""
                        }`}
                        onClick={() => setFocusedId(f.id)}
                        onDoubleClick={() => openFolder(f)}
                        onContextMenu={(e) => openContextMenu(e, "folder", f)}
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
                        {selectionMode && <td className="px-4 py-2" />}
                        <td className="px-3 py-2">
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
                            <div className="flex items-center gap-1">
                              {/* Triângulo de disclosure — expande a subpasta inline sem
                                  navegar pra dentro dela, igual Finder/Explorer em lista. */}
                              <button
                                onClick={(e) => toggleExpandFolder(e, f.id)}
                                className="p-0.5 -ml-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] flex-shrink-0"
                                title={expanded ? "Recolher" : "Expandir"}
                              >
                                <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-fast ${expanded ? "rotate-90" : ""}`} />
                              </button>
                              <button
                                onClick={() => openFolder(f)}
                                className="flex items-center gap-2 text-mac-body text-[var(--text-primary)] hover:text-teal-500 transition-colors duration-fast min-w-0"
                              >
                                <Folder className="w-4 h-4 text-teal-500 fill-teal-500/20 flex-shrink-0" />
                                <span className="truncate">{f.name}</span>
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] hidden sm:table-cell">—</td>
                        <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] text-right hidden sm:table-cell">—</td>
                        <td className="px-3 py-2 hidden sm:table-cell" />
                        <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] hidden md:table-cell">Pasta</td>
                        {resolvedFields.map((rf) => (
                          <td key={rf.custom_field_id} className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] hidden sm:table-cell">—</td>
                        ))}
                        <td className="px-2 py-2 flex items-center gap-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setSharingFolder(f); }}
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-full text-[var(--text-tertiary)] hover:text-teal-500 hover:bg-[var(--bg-hover)] transition-all duration-fast"
                            title="Compartilhar pasta"
                          >
                            <Share2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteFolder(f); }}
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-fast"
                            title="Excluir pasta"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                      {expanded === "loading" && (
                        <tr className="border-b border-[var(--border-default)]">
                          <td colSpan={nestedColSpan} className="px-3 py-2 pl-10 text-mac-caption text-[var(--text-tertiary)]">Carregando…</td>
                        </tr>
                      )}
                      {expanded && expanded !== "loading" && expanded.folders.length === 0 && expanded.documents.length === 0 && (
                        <tr className="border-b border-[var(--border-default)]">
                          <td colSpan={nestedColSpan} className="px-3 py-2 pl-10 text-mac-caption text-[var(--text-placeholder)] italic">Pasta vazia</td>
                        </tr>
                      )}
                      {expanded && expanded !== "loading" && expanded.folders.map((nf) => (
                        <tr
                          key={`nested-folder-${nf.id}`}
                          className="border-b border-[var(--border-default)] odd:bg-black/[0.04] dark:odd:bg-white/[0.035] hover:bg-[var(--bg-hover)] transition-colors duration-fast cursor-pointer"
                          onClick={() => openFolder(nf)}
                        >
                          {selectionMode && <td className="px-4 py-2" />}
                          <td className="px-3 py-2 pl-10">
                            <div className="flex items-center gap-2 text-mac-body text-[var(--text-secondary)]">
                              <Folder className="w-3.5 h-3.5 text-teal-500/70 fill-teal-500/15 flex-shrink-0" />
                              <span className="truncate">{nf.name}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] hidden sm:table-cell">—</td>
                          <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] text-right hidden sm:table-cell">—</td>
                          <td className="px-3 py-2 hidden sm:table-cell" />
                          <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] hidden md:table-cell">Pasta</td>
                          {resolvedFields.map((rf) => <td key={rf.custom_field_id} className="hidden sm:table-cell" />)}
                          <td />
                        </tr>
                      ))}
                      {expanded && expanded !== "loading" && expanded.documents.map((nd) => {
                        const ns = getFileStyle(nd.name);
                        const NIcon = ns.icon;
                        return (
                          <tr
                            key={`nested-doc-${nd.id}`}
                            className="border-b border-[var(--border-default)] odd:bg-black/[0.04] dark:odd:bg-white/[0.035] hover:bg-[var(--bg-hover)] transition-colors duration-fast cursor-pointer"
                            onClick={() => setDetailDoc(nd)}
                          >
                            {selectionMode && <td className="px-4 py-2" />}
                            <td className="px-3 py-2 pl-10">
                              <div className="flex items-center gap-2 text-mac-body text-[var(--text-secondary)] min-w-0">
                                <NIcon className={`w-3.5 h-3.5 flex-shrink-0 ${ns.iconColor} ${ns.fillColor} opacity-70`} />
                                <span className="truncate">{nd.name}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] hidden sm:table-cell">{fmtDate(nd.created_at)}</td>
                            <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] text-right hidden sm:table-cell">{fmtSize(nd.size_bytes)}</td>
                            <td className="px-3 py-2 hidden sm:table-cell"><OcrIcon status={nd.ocr_status} /></td>
                            <td className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)] hidden md:table-cell">{kindLabel(nd.name)}</td>
                            {resolvedFields.map((rf) => <td key={rf.custom_field_id} className="hidden sm:table-cell" />)}
                            <td />
                          </tr>
                        );
                      })}
                      </Fragment>
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
                      className={`border-b border-[var(--border-default)] transition-colors duration-fast group cursor-pointer ${
                        isSelected ? "bg-teal-500" : "odd:bg-black/[0.04] dark:odd:bg-white/[0.035] hover:bg-[var(--bg-hover)]"
                      } ${isDragging ? "opacity-40" : ""}`}
                      onClick={(e) => selectDocClick(e, d.id)}
                      onDoubleClick={() => setDetailDoc(d)}
                      onContextMenu={(e) => openContextMenu(e, "document", d)}
                      onTouchStart={(e) => handleTouchStart(e, d.id)}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleTouchEnd}
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
                        <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={isSelected} onChange={() => toggleSelect(d.id)} />
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {(() => { const s = getFileStyle(d.name); const Icon = s.icon; return (
                            <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                              <Icon className={`w-3.5 h-3.5 ${s.iconColor} ${s.fillColor}`} />
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
                                className="h-7 px-2 text-mac-body bg-[var(--bg-card)] border border-teal-500 rounded-[6px] text-[var(--text-primary)] focus:outline-none flex-1 min-w-0"
                              />
                              <span className="text-mac-body text-[var(--text-tertiary)] flex-shrink-0">{splitExt(d.name)[1]}</span>
                            </div>
                          ) : (
                            <TruncatedFileName
                              name={d.name}
                              className={`text-mac-body ${isSelected ? "text-white" : "text-[var(--text-primary)]"}`}
                              inverted={isSelected}
                            />
                          )}
                        </div>
                      </td>
                      <td className={`px-3 py-2 text-mac-caption hidden sm:table-cell ${isSelected ? "text-white/80" : "text-[var(--text-tertiary)]"}`}>{fmtDate(d.created_at)}</td>
                      <td className={`px-3 py-2 text-mac-caption text-right hidden sm:table-cell ${isSelected ? "text-white/80" : "text-[var(--text-tertiary)]"}`}>{fmtSize(d.size_bytes)}</td>
                      <td className="px-3 py-2 hidden sm:table-cell"><OcrIcon status={d.ocr_status} /></td>
                      <td className={`px-3 py-2 text-mac-caption hidden md:table-cell ${isSelected ? "text-white/80" : "text-[var(--text-tertiary)]"}`}>{kindLabel(d.name)}</td>
                      {resolvedFields.map((rf) => {
                        const value = fieldValues[d.id]?.[rf.custom_field_id];
                        return (
                          <td key={rf.custom_field_id} className="px-3 py-2 text-mac-caption truncate hidden sm:table-cell">
                            {value ? (
                              <span className={isSelected ? "text-white/90" : "text-[var(--text-secondary)]"}>{value}</span>
                            ) : rf.required ? (
                              <span className={isSelected ? "text-white" : "text-amber-600 dark:text-amber-400"} title="Campo obrigatório sem preenchimento">Pendente</span>
                            ) : (
                              <span className={isSelected ? "text-white/60" : "text-[var(--text-placeholder)]"}>—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); setDetailDoc(d); }}
                          className={`opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-full transition-all duration-fast ${
                            isSelected ? "text-white hover:bg-white/20" : "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)]"
                          }`}
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

        {/* Barra de caminho + status — uma linha só no rodapé do corpo da
            janela (nunca na toolbar, HIG "Path controls"): a cadeia clicável
            de ancestrais à esquerda, contagem de itens/seleção à direita.
            Duas faixas empilhadas (caminho e status separados) ficavam
            redundantes, principalmente na raiz onde o caminho é só o ícone
            de Início sozinho em cima da contagem. */}
        <div className="hidden sm:flex items-center justify-between gap-3 px-4 sm:px-6 h-8 border-t border-[var(--border-default)] flex-shrink-0 text-mac-caption text-[var(--text-tertiary)]">
          <nav className="flex items-center gap-1 min-w-0 overflow-x-auto">
            {breadcrumbs.map((crumb, idx) => (
              <span key={idx} className="flex items-center gap-1 flex-shrink-0">
                {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />}
                <button
                  onClick={() => navigateBreadcrumb(idx)}
                  className={`text-mac-caption hover:text-teal-500 transition-colors duration-fast ${
                    idx === breadcrumbs.length - 1
                      ? "text-[var(--text-primary)] font-medium"
                      : "text-[var(--text-secondary)]"
                  }`}
                >
                  {idx === 0 ? <Home className="w-3.5 h-3.5" /> : crumb.name}
                </button>
              </span>
            ))}
          </nav>
          <span className="flex-shrink-0">
            {selected.size > 0 ? (
              <span className="text-teal-500 font-medium">{selected.size} selecionado{selected.size !== 1 ? "s" : ""}</span>
            ) : sortedFolders.length === 0 && sortedDocuments.length === 0 ? (
              "Pasta vazia"
            ) : (
              <>
                {[
                  sortedFolders.length > 0 ? `${sortedFolders.length} pasta${sortedFolders.length !== 1 ? "s" : ""}` : null,
                  sortedDocuments.length > 0 ? `${sortedDocuments.length} documento${sortedDocuments.length !== 1 ? "s" : ""}` : null,
                ].filter(Boolean).join(", ")}
                {filterQ && ` · ${items.length} exibido${items.length !== 1 ? "s" : ""}`}
              </>
            )}
          </span>
        </div>
      </div>

      {/* Detail Drawer */}
      {detailDoc && current && (
        <DetailDrawer
          doc={detailDoc}
          companyId={current.id}
          onClose={() => setDetailDoc(null)}
          onPreview={() => setPreviewDoc(detailDoc)}
          onFavorite={loadSidebarFavorites}
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
      {copyingFolder && current && (
        <CopyStructureModal
          sourceFolderId={copyingFolder.id}
          sourceFolderName={copyingFolder.name}
          sourceCompanyId={current.id}
          onClose={() => setCopyingFolder(null)}
          onDone={() => setFolderTreeVersion((v) => v + 1)}
        />
      )}
      {previewDoc && (
        <PreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {/* Menu de contexto (clique direito) — interação primária, o botão "..."
          continua existindo como alternativa (§13.4 do ADENDO-09). */}
      {contextMenu && (
        <Portal>
          <div
            ref={contextMenuRef}
            className="glass-panel glass-blur-strong fixed rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50 w-[200px]"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {contextMenu.kind === "document" ? (
              <>
                <button
                  onClick={() => { setPreviewDoc(contextMenu.data); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white hover:[&_svg]:text-white transition-colors duration-fast text-left"
                >
                  <Eye className="w-4 h-4 text-[var(--text-tertiary)]" /> Abrir
                </button>
                <button
                  onClick={() => { setDetailDoc(contextMenu.data); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white hover:[&_svg]:text-white transition-colors duration-fast text-left"
                >
                  <Info className="w-4 h-4 text-[var(--text-tertiary)]" /> Ver detalhes
                </button>
                <button
                  onClick={() => { startRename("document", contextMenu.data.id, contextMenu.data.name); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white hover:[&_svg]:text-white transition-colors duration-fast text-left"
                >
                  <Pencil className="w-4 h-4 text-[var(--text-tertiary)]" /> Renomear
                </button>
                <div className="my-1 border-t border-[var(--border-default)]" />
                <button
                  onClick={() => { deleteDocuments([contextMenu.data.id]); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors duration-fast text-left"
                >
                  <Trash2 className="w-4 h-4" /> Excluir
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => { openFolder(contextMenu.data); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white hover:[&_svg]:text-white transition-colors duration-fast text-left"
                >
                  <FolderOpen className="w-4 h-4 text-[var(--text-tertiary)]" /> Abrir
                </button>
                <button
                  onClick={() => { startRename("folder", contextMenu.data.id, contextMenu.data.name); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white hover:[&_svg]:text-white transition-colors duration-fast text-left"
                >
                  <Pencil className="w-4 h-4 text-[var(--text-tertiary)]" /> Renomear
                </button>
                <button
                  onClick={() => { setSharingFolder(contextMenu.data); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white hover:[&_svg]:text-white transition-colors duration-fast text-left"
                >
                  <Share2 className="w-4 h-4 text-[var(--text-tertiary)]" /> Compartilhar
                </button>
                <button
                  onClick={() => { setCopyingFolder(contextMenu.data); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-[var(--text-primary)] hover:bg-teal-500 hover:text-white hover:[&_svg]:text-white transition-colors duration-fast text-left"
                >
                  <Copy className="w-4 h-4 text-[var(--text-tertiary)]" /> Copiar estrutura para...
                </button>
                <div className="my-1 border-t border-[var(--border-default)]" />
                <button
                  onClick={() => { setConfirmDeleteFolder(contextMenu.data); setContextMenu(null); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-mac-body text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors duration-fast text-left"
                >
                  <Trash2 className="w-4 h-4" /> Excluir
                </button>
              </>
            )}
          </div>
        </Portal>
      )}

      {/* Barra de ações em lote — flutuante, o caso mais puro de "vidro sobre conteúdo" */}
      <div
        className={`glass-panel glass-blur-pill fixed bottom-[76px] md:bottom-7 lg:bottom-[100px] left-1/2 flex items-center gap-1.5 rounded-[50px] pl-[18px] pr-1.5 py-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.55)] z-30 transition-[opacity,transform] duration-normal ${
          selected.size > 0 ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        }`}
        style={{ transform: selected.size > 0 ? "translateX(-50%)" : "translateX(-50%) translateY(12px)" }}
      >
        <span className="text-mac-body text-[var(--text-primary)] mr-1.5 pl-2.5 whitespace-nowrap">
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
