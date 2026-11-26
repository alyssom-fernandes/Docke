import { Fragment, useEffect, useRef, useState, useCallback, useId, type ElementType, type ReactNode } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { relativeDate, fullDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import {
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
  GitBranch,
  Shield,
  Tags,
  Archive,
  Lock,
  Check,
  FolderInput,
  Link2,
  RefreshCw,
  AlertTriangle,
  FolderUp,
} from "lucide-react";
import api from "@/lib/api";
import { useTaskCenter } from "@/lib/TaskContext";
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
import ActivityFeed from "@/components/shared/ActivityFeed";
import ShareModal from "@/components/documents/ShareModal";
import CopyStructureModal from "@/components/documents/CopyStructureModal";
import FolderTree from "@/components/documents/FolderTree";
import Portal from "@/components/ui/Portal";
import Dialog from "@/components/ui/Dialog";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import FolderPickerDialog, { type PickedFolder } from "@/components/documents/FolderPickerDialog";
import { pushUndo, takeUndo, isUndoShortcut } from "@/lib/undo";
import { maskValue, validateValue, PLACEHOLDER, INPUT_MODE, type FieldType } from "@/components/documents/fieldMasks";
import { SkeletonTableRow, SkeletonGridItem } from "@/components/shared/Skeleton";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";

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
  updated_at?: string;
  uploaded_by_name?: string | null;
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
  default_value: string | null;
  condition_field_id: string | null;
  condition_value: string | null;
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
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

const fmtDate = relativeDate;
const fmtDateFull = fullDate;

// Caracteres proibidos em nomes de arquivo/pasta (compatibilidade Windows/macOS)
const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/;

const ALLOWED_EXT = ["pdf", "xlsx", "xls", "csv", "docx", "doc", "xml", "jpg", "jpeg", "png", "gif", "txt"];
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const plural = (n: number, um: string, varios: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;

/** Mensagem que orienta, em vez do erro cru (achado A4-59). */
function friendlyError(e: any, fallback: string): string {
  const detail = e?.response?.data?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (e?.response?.status === 413) return "O arquivo passa de 200 MB. Divida ou comprima antes de enviar.";
  if (!e?.response) return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  return fallback;
}

/** Envia o arquivo direto ao armazenamento com progresso (fetch não informa). */
function putWithProgress(url: string, body: Blob, contentType: string | null, onProgress: (pct: number) => void): Promise<number> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100)); };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => resolve(0);
    xhr.ontimeout = () => resolve(0);
    xhr.send(body);
  });
}

// Separa nome-base e extensão pra manter a extensão fixa durante renomeação inline
function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

// Coluna "Tipo" (Kind) — todo Finder/Explorer mostra o tipo por extenso ao
// lado do nome; nós só tínhamos o ícone colorido, que sozinho não é óbvio
// pra quem não conhece o mapeamento de cores (ADENDO-09 §13).
// Rótulos curtos ("PDF", "Word") em vez de "Documento PDF"/"Documento Word" —
// o nome completo ocupava espaço desnecessário na coluna Tipo, sem agregar
// nada que o ícone colorido ao lado já não comunique.
const KIND_LABELS: Record<string, string> = {
  pdf: "PDF",
  xlsx: "Excel",
  xls: "Excel",
  csv: "CSV",
  docx: "Word",
  doc: "Word",
  xml: "XML",
  jpg: "JPEG",
  jpeg: "JPEG",
  png: "PNG",
  gif: "GIF",
  txt: "Texto",
};
function kindLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return KIND_LABELS[ext] ?? (ext ? ext.toUpperCase() : "Documento");
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

// Situação da leitura do texto (OCR), com rótulo que diz o que significa (A4-19).
function OcrIcon({ status, inverted = false }: { status: Document["ocr_status"]; inverted?: boolean }) {
  const map: Record<Document["ocr_status"], { Icon: ElementType; className: string; label: string }> = {
    pending: { Icon: Clock, className: "text-(--text-tertiary)", label: "Na fila para ler o texto" },
    processing: { Icon: Loader2, className: "text-(--text-warning) animate-spin motion-reduce:animate-none", label: "Lendo o texto…" },
    done: { Icon: CheckCircle2, className: "text-(--text-success)", label: "Texto pronto: aparece na busca pelo conteúdo" },
    failed: { Icon: AlertCircle, className: "text-(--text-danger)", label: "Não foi possível ler o texto. Abra os detalhes para tentar de novo" },
    skipped: { Icon: MinusCircle, className: "text-(--text-tertiary)", label: "Sem texto para ler" },
  };
  const { Icon, className, label } = map[status] ?? map.pending;
  return (
    <Tooltip label={label}>
      <span role="img" aria-label={label} className="inline-flex">
        <Icon className={`w-4 h-4 ${inverted ? "text-white" : className}`} aria-hidden />
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
    <th className={`relative px-3 py-2 text-mac-caption font-normal text-(--text-secondary) text-left ${className}`}>
      <button
        onClick={() => onSort(sortKey)}
        className={`group/sort flex items-center gap-1 w-full hover:text-(--text-primary) transition-colors duration-fast ${active ? "text-(--text-primary) font-medium" : ""} ${align === "right" ? "justify-end" : "justify-between"}`}
      >
        {align === "right" && (active ? (
          sort.dir === "asc" ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-0 group-hover/sort:opacity-40 transition-opacity duration-fast" />
        ))}
        <span className="truncate">{label}</span>
        {align === "left" && (active ? (
          sort.dir === "asc" ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />
        ) : (
          <ChevronsUpDown className="w-3 h-3 shrink-0 opacity-0 group-hover/sort:opacity-40 transition-opacity duration-fast" />
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

// Acompanha o OCR de um lote recém-enviado por polling, atualizando cada
// tarefa no Task Center até todas saírem de pending/processing (ou até um
// teto de tentativas, pra não ficar girando pra sempre se algo travar).
function pollOcrStatus(items: { documentId: string; taskId: string; fileName: string }[], updateTask: ReturnType<typeof useTaskCenter>["updateTask"]) {
  const MAX_ATTEMPTS = 20; // ~60s a 3s por tentativa
  let attempts = 0;
  const pending = new Map(items.map((i) => [i.documentId, i]));

  const tick = async () => {
    if (pending.size === 0 || attempts >= MAX_ATTEMPTS) {
      // o que sobrar sem resolução (timeout) fica marcado como concluído sem
      // mais detalhes — o ícone de OCR na tabela é a fonte de verdade real.
      for (const { taskId, fileName } of pending.values()) updateTask(taskId, { status: "done", label: fileName });
      return;
    }
    attempts++;
    try {
      const { data } = await api.get<{ id: string; ocr_status: string }[]>("/documents/ocr-status", {
        params: { document_ids: Array.from(pending.keys()).join(",") },
      });
      for (const row of data) {
        const item = pending.get(row.id);
        if (!item) continue;
        if (row.ocr_status === "done") {
          updateTask(item.taskId, { status: "done", label: `${item.fileName} · disponível na busca` });
          pending.delete(row.id);
        } else if (row.ocr_status === "failed") {
          updateTask(item.taskId, { status: "failed", error: `${item.fileName}: falha ao extrair texto (OCR).` });
          pending.delete(row.id);
        } else {
          updateTask(item.taskId, { label: `${item.fileName} · extraindo texto…` });
        }
      }
    } catch {
      // erro de rede na sondagem não derruba a tarefa — só tenta de novo no próximo tick
    }
    if (pending.size > 0) setTimeout(tick, 3000);
  };
  setTimeout(tick, 3000);
}

function UploadModal({ folderId, folderName, companyId, onClose, onDone }: { folderId: string | null; folderName: string; companyId: string; onClose: () => void; onDone: () => void }) {
  const { success, warning } = useToast();
  const { addTask, updateTask, registerRetry } = useTaskCenter();
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [rejected, setRejected] = useState<{ name: string; reason: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [dragOver, setDragOver] = useState(false);
  const [dest, setDest] = useState<{ id: string | null; name: string }>({ id: folderId, name: folderName });
  const [picking, setPicking] = useState(false);
  const folderInputRef = useRef<HTMLInputElement>(null);

  // Escolher uma pasta inteira pelo botão (antes só arrastando — achado A4-52).
  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  // Valida antes de enviar (achado A4-53): extensão, tamanho, vazio e repetido.
  function addFiles(items: PendingFile[]) {
    const ok: PendingFile[] = [];
    const bad: { name: string; reason: string }[] = [];
    const seen = new Set(pending.map((p) => `${p.relativePath}/${p.file.name}`.toLowerCase()));
    for (const it of items) {
      const label = it.relativePath ? `${it.relativePath}/${it.file.name}` : it.file.name;
      const ext = it.file.name.split(".").pop()?.toLowerCase() ?? "";
      if (it.file.name.startsWith(".") || ext === "ds_store" || it.file.name === "Thumbs.db") continue;
      if (!ALLOWED_EXT.includes(ext)) bad.push({ name: label, reason: "tipo não aceito" });
      else if (it.file.size === 0) bad.push({ name: label, reason: "arquivo vazio" });
      else if (it.file.size > MAX_UPLOAD_BYTES) bad.push({ name: label, reason: "passa de 200 MB" });
      else if (seen.has(label.toLowerCase())) continue;
      else { seen.add(label.toLowerCase()); ok.push(it); }
    }
    setPending((prev) => [...prev, ...ok]);
    if (bad.length) setRejected((prev) => [...prev, ...bad]);
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const items = e.dataTransfer.items;
    if (!items || !items.length) return;
    const collected: PendingFile[] = [];
    const entries = Array.from(items).map((it) => (it as any).webkitGetAsEntry?.()).filter(Boolean);
    for (const entry of entries) await walkEntry(entry, "", collected);
    addFiles(collected);
  }

  // Subpasta do arquivo → id, reaproveitando a pasta que já existe com o mesmo
  // nome (antes, reenviar uma pasta criava outra árvore com os mesmos nomes).
  async function resolveFolderId(path: string, cache: Map<string, string>): Promise<string> {
    if (!path) return cache.get("")!;
    if (cache.has(path)) return cache.get(path)!;
    let parentPath = "";
    let parentId = cache.get("")!;
    for (const seg of path.split("/")) {
      const currentPath = parentPath ? `${parentPath}/${seg}` : seg;
      if (!cache.has(currentPath)) {
        const { data: children } = await api.get<Folder[]>("/folders", { params: { company_id: companyId, parent_id: parentId } });
        let found = children.find((c) => c.name.toLowerCase() === seg.trim().toLowerCase());
        if (!found) {
          try {
            const { data } = await api.post("/folders", { name: seg, company_id: companyId, parent_id: parentId });
            found = data;
          } catch (err: any) {
            if (err?.response?.status !== 409) throw err;
            const { data: again } = await api.get<Folder[]>("/folders", { params: { company_id: companyId, parent_id: parentId } });
            found = again.find((c) => c.name.toLowerCase() === seg.trim().toLowerCase());
            if (!found) throw err;
          }
        }
        cache.set(currentPath, found!.id);
      }
      parentId = cache.get(currentPath)!;
      parentPath = currentPath;
    }
    return parentId;
  }

  // Fase 11.1: acima disso, upload em partes (multipart) em vez de um PUT
  // único — mesmo threshold do backend (documents.py::_MULTIPART_THRESHOLD).
  const MULTIPART_THRESHOLD = 20 * 1024 * 1024;

  async function uploadFileMultipart(
    file: File, targetFolderId: string, onProgress: (label: string, progress: number) => void,
  ): Promise<string> {
    const { data: created } = await api.post("/documents/multipart/create", {
      folder_id: targetFolderId,
      company_id: companyId,
      name: file.name,
      size_bytes: file.size,
      content_type: file.type || "application/octet-stream",
    });
    const { document_id: documentId, upload_id: uploadId, part_size: partSize, total_parts: totalParts } = created;
    try {
      const parts: { part_number: number; etag: string }[] = [];
      for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
        const start = (partNumber - 1) * partSize;
        const chunk = file.slice(start, start + partSize);
        const { data: partUrlData } = await api.post(`/documents/multipart/${documentId}/part-url`, { upload_id: uploadId, part_number: partNumber });
        const putResp = await fetch(partUrlData.upload_url, { method: "PUT", body: chunk }).catch(() => null);
        if (!putResp || !putResp.ok) throw new Error("A conexão caiu durante o envio. Tente de novo.");
        const etag = putResp.headers.get("ETag");
        if (!etag) throw new Error("O armazenamento não confirmou uma parte do arquivo. Tente de novo; se continuar, avise o administrador.");
        parts.push({ part_number: partNumber, etag });
        onProgress(`${file.name}`, Math.round((partNumber / totalParts) * 100));
      }
      await api.post(`/documents/multipart/${documentId}/complete`, { upload_id: uploadId, parts });
      return documentId;
    } catch (err) {
      try { await api.post(`/documents/multipart/${documentId}/abort`, { upload_id: uploadId }); } catch { /* ignore */ }
      throw err;
    }
  }

  async function attemptUploadOne(
    file: File, relativePath: string, targetFolderId: string, taskId: string, displayName: string,
  ): Promise<{ ok: true; documentId: string; taskId: string; fileName: string } | { ok: false; reason: string }> {
    updateTask(taskId, { status: "running", phase: "uploading", error: undefined, progress: 0, label: displayName });
    try {
      let documentId: string;
      if (file.size >= MULTIPART_THRESHOLD) {
        documentId = await uploadFileMultipart(file, targetFolderId, (label, p) => updateTask(taskId, { label, progress: p }));
      } else {
        const { data } = await api.post("/documents/upload-url", {
          folder_id: targetFolderId,
          company_id: companyId,
          name: file.name,
          size_bytes: file.size,
          content_type: file.type || "application/octet-stream",
        });
        // Mesmo tipo da assinatura da URL (o Chrome chama XML de text/xml e a
        // URL vem assinada com application/xml — achado X2-03).
        const status = await putWithProgress(data.upload_url, file, data.content_type ?? (file.type || "application/octet-stream"),
          (p) => updateTask(taskId, { progress: p }));
        if (status < 200 || status >= 300) {
          api.post(`/documents/${data.document_id}/abort-upload`).catch(() => {});
          throw new Error(status === 0
            ? "A conexão caiu durante o envio. Confira a internet e tente de novo."
            : `O armazenamento recusou o arquivo (código ${status}). Tente de novo; se continuar, avise o administrador.`);
        }
        await api.post(`/documents/${data.document_id}/confirm`);
        documentId = data.document_id;
      }
      updateTask(taskId, { label: `${displayName} · lendo o texto…`, phase: "processing", progress: undefined });
      pollOcrStatus([{ documentId, taskId, fileName: displayName }], updateTask);
      return { ok: true, documentId, taskId, fileName: displayName };
    } catch (fileErr: any) {
      const reason = fileErr?.response ? friendlyError(fileErr, "Não foi possível enviar.") : (fileErr?.message ?? "Não foi possível enviar.");
      updateTask(taskId, { status: "failed", error: reason });
      registerRetry(taskId, () => { attemptUploadOne(file, relativePath, targetFolderId, taskId, displayName); });
      return { ok: false, reason };
    }
  }

  async function upload() {
    if (!pending.length) return;
    if (!dest.id) { setPicking(true); return; }
    setUploading(true);
    setProgress({ done: 0, total: pending.length, failed: 0 });
    const folderCache = new Map<string, string>([["", dest.id]]);
    const failures: { name: string; reason: string }[] = [];
    let okCount = 0;
    // Três envios ao mesmo tempo (antes, um arquivo e uma parte por vez — A4-55).
    const queue = [...pending];
    async function worker() {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const displayName = item.relativePath ? `${item.relativePath}/${item.file.name}` : item.file.name;
        const taskId = addTask({ kind: "upload", label: displayName, status: "running", phase: "uploading" });
        let result: Awaited<ReturnType<typeof attemptUploadOne>>;
        try {
          const target = await resolveFolderId(item.relativePath, folderCache);
          result = await attemptUploadOne(item.file, item.relativePath, target, taskId, displayName);
        } catch (err: any) {
          const reason = friendlyError(err, "Não foi possível criar a subpasta.");
          updateTask(taskId, { status: "failed", error: reason });
          result = { ok: false, reason };
        }
        if (result.ok) okCount++;
        else failures.push({ name: displayName, reason: result.reason });
        setProgress((p) => ({ ...p, done: p.done + 1, failed: failures.length }));
      }
    }
    try {
      await Promise.all([worker(), worker(), worker()]);
      if (okCount > 0) success(`${plural(okCount, "arquivo enviado", "arquivos enviados")} para "${dest.name}".`);
      if (failures.length > 0) {
        warning(`${plural(failures.length, "arquivo não foi enviado", "arquivos não foram enviados")}. Na Central de tarefas dá para ver o motivo e tentar de novo.`);
      }
      onDone();
      if (failures.length === 0) onClose();
      else setPending((prev) => prev.filter((p) => failures.some((f) => f.name === (p.relativePath ? `${p.relativePath}/${p.file.name}` : p.file.name))));
    } finally {
      setUploading(false);
    }
  }

  const totalBytes = pending.reduce((acc, p) => acc + p.file.size, 0);

  return (
    <>
    <Dialog
      onClose={onClose}
      title="Enviar documentos"
      description={
        <span className="flex flex-wrap items-center gap-x-1.5">
          Para:
          <span className="inline-flex items-center gap-1 font-medium text-(--text-primary)">
            <Folder className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" aria-hidden />
            {dest.id ? dest.name : "escolha uma pasta"}
          </span>
          <button type="button" onClick={() => setPicking(true)} disabled={uploading}
            className="text-(--text-accent) font-medium underline-offset-2 hover:underline disabled:opacity-50 min-h-6 pointer-coarse:min-h-11">
            {dest.id ? "Trocar" : "Escolher"}
          </button>
        </span>
      }
      size="md"
      busy={uploading}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={uploading}>Cancelar</Button>
          <Button loading={uploading} onClick={upload} disabled={!pending.length}>
            {uploading ? `Enviando ${Math.min(progress.done + 1, progress.total)} de ${progress.total}…` : pending.length ? `Enviar ${plural(pending.length, "arquivo", "arquivos")}` : "Enviar"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <label
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          className={`block border-2 border-dashed rounded-(--radius-control) px-5 py-7 text-center cursor-pointer transition-colors duration-fast focus-within:ring-[3px] focus-within:ring-(--focus-ring) ${
            dragOver ? "border-teal-500 bg-teal-500/8" : "border-(--border-control) hover:border-teal-500"
          }`}
        >
          <Upload className="w-7 h-7 text-teal-600 dark:text-teal-400 mx-auto mb-2" aria-hidden />
          <p className="text-mac-body text-(--text-primary)">Arraste arquivos ou pastas para cá, ou clique para escolher</p>
          <p className="text-mac-caption text-(--text-secondary) mt-1">PDF, Word, Excel, CSV, XML (NF-e), TXT, JPG, PNG e GIF · até 200 MB cada · a pasta arrastada vem com as subpastas</p>
          <input
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => { addFiles(Array.from(e.target.files ?? []).map((file) => ({ file, relativePath: "" }))); e.target.value = ""; }}
            accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.xml,.jpg,.jpeg,.png,.gif,.txt"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => folderInputRef.current?.click()} disabled={uploading}>
            <FolderUp className="w-3.5 h-3.5" aria-hidden /> Escolher uma pasta inteira
          </Button>
          <input
            ref={folderInputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []).map((file) => {
                const rel = (file as any).webkitRelativePath as string | undefined;
                return { file, relativePath: rel ? rel.split("/").slice(0, -1).join("/") : "" };
              }));
              e.target.value = "";
            }}
          />
        </div>
        {pending.length > 0 && (
          <div>
            <p className="mb-1.5 text-mac-caption text-(--text-secondary)" aria-live="polite">
              {plural(pending.length, "arquivo", "arquivos")} · {fmtSize(totalBytes)}
              {uploading && progress.failed > 0 && ` · ${plural(progress.failed, "falha", "falhas")}`}
            </p>
            <ul className="max-h-44 overflow-y-auto rounded-(--radius-control) border border-(--border-default) divide-y divide-(--border-default)">
              {pending.map((p, i) => {
                const st = getFileStyle(p.file.name);
                const Icon = st.icon;
                const label = p.relativePath ? `${p.relativePath}/${p.file.name}` : p.file.name;
                return (
                  <li key={`${label}-${i}`} className="flex items-center gap-2 px-2.5 h-9 pointer-coarse:h-11 text-mac-caption text-(--text-secondary)">
                    <Icon className={`w-3.5 h-3.5 shrink-0 ${st.iconColor} ${st.fillColor}`} aria-hidden />
                    <span className="flex-1 truncate text-(--text-primary)" title={label}>{label}</span>
                    <span className="shrink-0 tabular-nums">{fmtSize(p.file.size)}</span>
                    <button type="button" onClick={() => setPending((prev) => prev.filter((_, j) => j !== i))} disabled={uploading}
                      aria-label={`Tirar ${label} da lista`}
                      className="w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 -mr-1 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) disabled:opacity-40">
                      <X className="w-3.5 h-3.5" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {rejected.length > 0 && (
          <div role="status" className="rounded-(--radius-control) border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-mac-caption text-(--text-primary)">
            <p className="font-medium">{plural(rejected.length, "arquivo ficou de fora", "arquivos ficaram de fora")}:</p>
            <ul className="mt-1 max-h-20 overflow-y-auto space-y-0.5 text-(--text-secondary)">
              {rejected.map((r, i) => <li key={i} className="truncate">{r.name} — {r.reason}</li>)}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
    {picking && (
      <FolderPickerDialog
        companyId={companyId}
        title="Enviar para qual pasta?"
        confirmLabel="Usar esta pasta"
        initialId={dest.id}
        onPick={(f) => { setDest({ id: f.id, name: f.name }); setPicking(false); }}
        onClose={() => setPicking(false)}
      />
    )}
    </>
  );
}

// ─── Create Folder Modal ──────────────────────────────────────────────────────

function CreateFolderModal({ parentId, parentName, siblings, companyId, onClose, onDone }: {
  parentId: string | null; parentName: string; siblings: string[]; companyId: string; onClose: () => void; onDone: (folder: Folder) => void;
}) {
  const { success } = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Mesma regra do backend (achado A4-40): avisa enquanto digita.
  const trimmed = name.trim().replace(/\s+/g, " ");
  const localError =
    trimmed && FORBIDDEN_NAME_CHARS.test(trimmed) ? 'O nome não pode ter \\ / : * ? " < > |.'
    : trimmed.endsWith(".") ? "O nome não pode terminar com ponto."
    : trimmed && siblings.some((n) => n.toLowerCase() === trimmed.toLowerCase()) ? `Já existe uma pasta "${trimmed}" aqui.`
    : "";

  async function create() {
    if (!trimmed || localError) return;
    setSaving(true);
    setError("");
    try {
      const { data } = await api.post("/folders", { name: trimmed, company_id: companyId, parent_id: parentId });
      success(`Pasta "${data.name}" criada.`);
      onDone(data);
      onClose();
    } catch (e: any) {
      setError(friendlyError(e, "Não foi possível criar a pasta."));
    } finally {
      setSaving(false);
    }
  }

  const shown = error || localError;
  return (
    <Dialog
      onClose={onClose}
      title="Nova pasta"
      description={<>Em <strong className="font-medium text-(--text-primary)">{parentName}</strong></>}
      size="sm"
      busy={saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button loading={saving} onClick={create} disabled={!trimmed || !!localError}>Criar pasta</Button>
        </>
      }
    >
      <label htmlFor="nova-pasta-nome" className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Nome</label>
      <input
        id="nova-pasta-nome"
        type="text"
        value={name}
        maxLength={150}
        onChange={(e) => { setName(e.target.value); setError(""); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }}
        placeholder="Ex.: Notas fiscais 2026"
        aria-invalid={shown ? true : undefined}
        aria-describedby={shown ? "nova-pasta-erro" : undefined}
        className="w-full h-9 pointer-coarse:h-11 px-3 text-mac-body pointer-coarse:text-[16px] bg-(--bg-card) border border-(--border-control) rounded-(--radius-control) text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
      />
      {shown && <p id="nova-pasta-erro" role="alert" className="mt-1.5 text-mac-caption text-(--text-danger)">{shown}</p>}
    </Dialog>
  );
}

// ─── Detail Drawer ────────────────────────────────────────────────────────────

// Metadados personalizados (ADENDO-08 M-G): formulário por tipo, com máscara,
// validação no próprio campo e salvamento automático anunciado (A5-11, A5-15).
type FieldSaveStatus = "idle" | "saving" | "saved" | "error";

function FieldStatusIndicator({ status, message }: { status: FieldSaveStatus; message?: string }) {
  if (status === "idle") return null;
  if (status === "saving") return <span className="text-mac-caption text-(--text-secondary)">salvando…</span>;
  if (status === "error") return <span className="text-mac-caption text-(--text-danger)">{message ?? "não salvou"}</span>;
  return <span className="reveal text-mac-caption text-(--text-success)">salvo</span>;
}

/** Acordeão acessível com altura animada (A5-05, A5-07, A5-22). */
function Disclosure({ icon, title, summary, children, defaultOpen = false, onOpen }: {
  icon: ReactNode; title: string; summary?: string; children: ReactNode; defaultOpen?: boolean; onOpen?: () => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className="border-t border-(--border-default) pt-2">
      <h3>
        <button
          aria-expanded={open}
          aria-controls={`${id}-painel`}
          onClick={() => { const next = !open; setOpen(next); if (next) onOpen?.(); }}
          className="w-full flex items-center justify-between gap-2 min-h-9 pointer-coarse:min-h-11 rounded-[6px] text-mac-body text-(--text-primary) hover:text-(--text-accent)"
        >
          <span className="flex items-center gap-2">{icon}{title}{summary && <span className="text-mac-caption text-(--text-secondary) font-normal">{summary}</span>}</span>
          <ChevronDown className={`w-4 h-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      </h3>
      <div id={`${id}-painel`} className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`} inert={!open}>
        <div className="overflow-hidden"><div className="pt-2 pb-1">{children}</div></div>
      </div>
    </div>
  );
}

function MetadataSection({ doc, companyId, canEdit, onSaved }: { doc: Document; companyId: string; canEdit: boolean; onSaved: (fieldId: string, value: string) => void }) {
  const [fields, setFields] = useState<ResolvedField[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedFieldIds, setSavedFieldIds] = useState<Set<string>>(new Set());
  const [fieldStatus, setFieldStatus] = useState<Record<string, FieldSaveStatus>>({});
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const debounceRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const uid = useId();

  const load = useCallback(() => {
    if (!doc.folder_id) { setFields([]); return; }
    setFields(null);
    setFailed(false);
    Promise.all([
      api.get<ResolvedField[]>("/folder-fields/resolved", { params: { company_id: companyId, folder_id: doc.folder_id } }),
      api.get<DocFieldValueRow[]>(`/documents/${doc.id}/field-values`),
    ]).then(([fRes, vRes]) => {
      const fetched = Array.isArray(fRes.data) ? [...fRes.data].sort((a, b) => a.display_order - b.display_order) : [];
      const vmap: Record<string, string> = {};
      const saved = new Set<string>();
      for (const row of Array.isArray(vRes.data) ? vRes.data : []) { vmap[row.custom_field_id] = row.value_text; saved.add(row.custom_field_id); }
      for (const f of fetched) if (!saved.has(f.custom_field_id) && f.default_value) vmap[f.custom_field_id] = f.default_value;
      setFields(fetched); setValues(vmap); setSavedFieldIds(saved); setFieldStatus({}); setFieldError({});
    }).catch(() => { setFailed(true); setFields([]); });
  }, [doc.id, doc.folder_id, companyId]);
  useEffect(load, [load]);
  useEffect(() => () => { Object.values(debounceRefs.current).forEach(clearTimeout); }, []);

  async function saveField(f: ResolvedField, rawValue: string) {
    const trimmed = rawValue.trim();
    const invalid = validateValue(f.type as FieldType, trimmed);
    if (invalid) { setFieldError((s) => ({ ...s, [f.custom_field_id]: invalid })); setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "idle" })); return; }
    setFieldError((s) => { const n = { ...s }; delete n[f.custom_field_id]; return n; });
    if (!trimmed) { setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "idle" })); return; }
    setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "saving" }));
    try {
      await api.put(`/documents/${doc.id}/field-values`, [{ custom_field_id: f.custom_field_id, value: trimmed }], { params: { company_id: companyId } });
      setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "saved" }));
      setSavedFieldIds((s) => new Set(s).add(f.custom_field_id));
      onSaved(f.custom_field_id, trimmed);
      window.setTimeout(() => setFieldStatus((s) => (s[f.custom_field_id] === "saved" ? { ...s, [f.custom_field_id]: "idle" } : s)), 2500);
    } catch (e: any) {
      setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "error" }));
      setFieldError((s) => ({ ...s, [f.custom_field_id]: e?.response?.data?.detail ?? "Não salvou. Confira o valor e tente de novo." }));
    }
  }

  if (fields === null) {
    return <div className="border-t border-(--border-default) pt-3 space-y-2" aria-label="Carregando metadados">{[0, 1].map((i) => <div key={i} className="h-9 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>;
  }
  if (failed) {
    return <p role="alert" className="border-t border-(--border-default) pt-3 text-mac-body text-(--text-secondary)">Não carregou os metadados. <button onClick={load} className="font-medium text-(--text-accent) underline underline-offset-2">Tentar de novo</button></p>;
  }
  const visible = fields.filter((f) => !f.condition_field_id || (values[f.condition_field_id] ?? "") === (f.condition_value ?? ""));
  if (visible.length === 0) return null;

  return (
    <section aria-labelledby={`${uid}-meta`} className="border-t border-(--border-default) pt-3 space-y-3">
      <h3 id={`${uid}-meta`} className="text-mac-body font-semibold text-(--text-primary)">Metadados</h3>
      {visible.map((f) => {
        const fid = `${uid}-${f.custom_field_id}`;
        const err = fieldError[f.custom_field_id];
        const status = fieldStatus[f.custom_field_id] ?? "idle";
        const brokeInheritance = f.default_value != null && savedFieldIds.has(f.custom_field_id) && values[f.custom_field_id] !== f.default_value;
        const fromDefault = f.default_value != null && !savedFieldIds.has(f.custom_field_id) && values[f.custom_field_id] === f.default_value;
        return (
          <div key={f.custom_field_id}>
            <div className="flex items-center justify-between gap-2 mb-1">
              <label htmlFor={fid} className="text-mac-caption font-medium text-(--text-secondary) flex items-center gap-1">
                {f.label}{f.required && <span className="text-(--text-danger)" aria-label="obrigatório">*</span>}
                {brokeInheritance && <span className="text-(--text-warning) inline-flex" title={`Diferente do padrão da pasta ("${f.default_value}")`}><GitBranch className="w-3 h-3" aria-hidden /><span className="sr-only">diferente do padrão da pasta</span></span>}
                {fromDefault && <span className="text-(--text-secondary) font-normal">· padrão da pasta</span>}
              </label>
              <span aria-live="polite"><FieldStatusIndicator status={status} message={status === "error" ? "não salvou" : undefined} /></span>
            </div>
            {f.type === "selecao" ? (
              <Dropdown
                id={fid}
                value={values[f.custom_field_id] ?? ""}
                onChange={(v) => { setValues((s) => ({ ...s, [f.custom_field_id]: v })); saveField(f, v); }}
                placeholder="Escolha"
                disabled={!canEdit}
                ariaLabel={f.label}
                options={((f.format_config?.options as string[]) ?? []).map((o) => ({ value: o, label: o }))}
              />
            ) : (
              <input
                id={fid}
                type="text"
                inputMode={INPUT_MODE[f.type as FieldType]}
                value={values[f.custom_field_id] ?? ""}
                readOnly={!canEdit}
                aria-invalid={err ? true : undefined}
                aria-describedby={err ? `${fid}-erro` : undefined}
                aria-required={f.required || undefined}
                onChange={(e) => {
                  const v = maskValue(f.type as FieldType, e.target.value);
                  setValues((s) => ({ ...s, [f.custom_field_id]: v }));
                  setFieldStatus((s) => ({ ...s, [f.custom_field_id]: "idle" }));
                  if (debounceRefs.current[f.custom_field_id]) clearTimeout(debounceRefs.current[f.custom_field_id]);
                  debounceRefs.current[f.custom_field_id] = setTimeout(() => saveField(f, v), 900);
                }}
                onBlur={(e) => {
                  if (debounceRefs.current[f.custom_field_id]) clearTimeout(debounceRefs.current[f.custom_field_id]);
                  saveField(f, e.target.value);
                }}
                placeholder={PLACEHOLDER[f.type as FieldType]}
                className={`w-full h-9 pointer-coarse:h-11 px-3 text-mac-body pointer-coarse:text-[16px] bg-(--bg-card) border rounded-(--radius-control) text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring) read-only:bg-(--bg-hover) ${err ? "border-red-500" : "border-(--border-control)"}`}
              />
            )}
            {err && <p id={`${fid}-erro`} className="mt-1 text-mac-caption text-(--text-danger)">{err}</p>}
          </div>
        );
      })}
    </section>
  );
}

interface RetentionCandidate {
  policy_id: string; policy_name: string; locked: boolean; is_indeterminate: boolean;
  expires_at: string | null; company_wide: boolean; eligible: boolean; is_winner: boolean;
}

const brDate = (iso: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("pt-BR") : "—");

function DocumentRetentionSection({ docId }: { docId: string }) {
  const [info, setInfo] = useState<{ policy_name: string | null; expires_at: string | null; is_indeterminate: boolean | null; locked: boolean; under_hold: boolean } | null | "erro">(null);
  const [candidates, setCandidates] = useState<RetentionCandidate[] | null>(null);
  const [showCalc, setShowCalc] = useState(false);
  const load = () => { setInfo(null); api.get(`/documents/${docId}/retention`).then((r) => setInfo(r.data)).catch(() => setInfo("erro")); };
  useEffect(() => { if (showCalc) api.get<{ candidates: RetentionCandidate[] }>(`/documents/${docId}/retention/explain`).then((r) => setCandidates(r.data.candidates)).catch(() => setCandidates([])); }, [showCalc, docId]);
  return (
    <Disclosure icon={<Archive className="w-4 h-4" aria-hidden />} title="Retenção" onOpen={load}>
      {info === null ? (
        <div className="h-10 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" />
      ) : info === "erro" ? (
        <p role="alert" className="text-mac-caption text-(--text-secondary)">Não foi possível conferir a retenção agora. Não descarte o documento sem conferir. <button onClick={load} className="font-medium text-(--text-accent) underline underline-offset-2">Tentar de novo</button></p>
      ) : (
        <div className="text-mac-caption text-(--text-secondary) space-y-1.5">
          {info.under_hold && <p className="flex items-center gap-1.5 text-(--text-warning) font-medium"><Lock className="w-3.5 h-3.5" aria-hidden /> Sob retenção legal (legal hold): não pode ser excluído.</p>}
          {!info.policy_name ? (
            <p>Nenhuma política de retenção se aplica a este documento.</p>
          ) : (
            <>
              <p>Política: <span className="font-medium text-(--text-primary)">{info.policy_name}</span>{info.locked && <span className="ml-1">(obrigatória)</span>}</p>
              <p>{info.is_indeterminate ? "Guarda por prazo indeterminado." : `Pode ser descartado a partir de ${brDate(info.expires_at)}.`}</p>
              <button onClick={() => setShowCalc((v) => !v)} aria-expanded={showCalc} className="font-medium text-(--text-accent) underline-offset-2 hover:underline min-h-6 pointer-coarse:min-h-11">
                {showCalc ? "Ocultar como foi calculado" : "Ver como foi calculado"}
              </button>
              {showCalc && (
                <ul className="space-y-1 pt-1">
                  {candidates === null ? <li className="h-8 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" /> : candidates.length === 0 ? (
                    <li>Nenhuma política atribuída à empresa ou às pastas deste documento.</li>
                  ) : candidates.map((c) => (
                    <li key={c.policy_id} className="flex items-start gap-1.5">
                      {c.is_winner ? <Check className="w-3.5 h-3.5 text-(--text-success) shrink-0 mt-0.5" aria-hidden /> : <span className="w-3.5 shrink-0" />}
                      <span className={c.is_winner ? "text-(--text-primary)" : ""}>
                        {c.policy_name}{c.locked ? " (obrigatória)" : ""} — {c.is_indeterminate ? "indeterminado" : brDate(c.expires_at)} · {c.company_wide ? "empresa toda" : "pasta"}
                        {c.is_winner ? <strong className="ml-1 text-(--text-success)">vale esta</strong> : !c.eligible ? " · perde para a obrigatória" : " · prazo menor"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </Disclosure>
  );
}

function DetailDrawer({ doc, companyId, variant = "modal", path, canEdit, onClose, onFavorite, onPreview, onMenu, onChanged, onFieldSaved }: {
  doc: Document; companyId: string; variant?: "modal" | "panel"; path: string; canEdit: boolean;
  onClose: () => void; onFavorite: () => void; onPreview: () => void; onMenu: (el: HTMLElement) => void; onChanged: () => void;
  onFieldSaved: (docId: string, fieldId: string, value: string) => void;
}) {
  const { success, error: showError } = useToast();
  const [favorited, setFavorited] = useState(doc.favorited ?? false);
  const [sharing, setSharing] = useState(false);
  const [shareCount, setShareCount] = useState(doc.active_share_count ?? 0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => { setFavorited(doc.favorited ?? false); setShareCount(doc.active_share_count ?? 0); }, [doc.id, doc.favorited, doc.active_share_count]);

  async function toggleFavorite() {
    const goingTo = !favorited;
    setFavorited(goingTo);
    try {
      if (goingTo) { await api.post("/favorites", { document_id: doc.id }); success(`"${doc.name}" ancorado.`); }
      else {
        const list = await api.get<{ id: string; document_id: string | null }[]>("/favorites");
        const id = list.data.find((f) => f.document_id === doc.id)?.id;
        if (id) await api.delete(`/favorites/${id}`);
      }
      onFavorite();
    } catch (e: any) {
      if (goingTo && e?.response?.status === 409) return;
      setFavorited(!goingTo);
      showError(goingTo ? "Não foi possível ancorar. Tente de novo." : "Não foi possível desancorar. Tente de novo.");
    }
  }

  async function download() {
    try {
      const r = await api.get(`/documents/${doc.id}/download-url`);
      const a = document.createElement("a");
      a.href = r.data.download_url;
      a.download = doc.name;
      a.click();
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível baixar."));
    }
  }

  const s = getFileStyle(doc.name);
  const FileIcon = s.icon;
  const action = "flex flex-col items-center justify-center gap-1 h-14 pointer-coarse:h-16 rounded-(--radius-control) text-mac-caption text-(--text-primary) hover:bg-(--bg-hover) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)";

  const body = (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className={`w-11 h-11 rounded-(--radius-control) flex items-center justify-center shrink-0 ${s.bgColor}`}>
          <FileIcon className={`w-5 h-5 ${s.iconColor} ${s.fillColor}`} aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="text-mac-body font-semibold text-(--text-primary) break-words focus:outline-hidden">{doc.name}</h2>
          <p className="text-mac-caption text-(--text-secondary) mt-0.5 break-words">{path}</p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-1" role="group" aria-label="Ações do documento">
        <button onClick={onPreview} className={`${action} text-(--text-accent) font-medium`}><Eye className="w-4 h-4" aria-hidden />Abrir</button>
        <button onClick={download} className={action}><Download className="w-4 h-4" aria-hidden />Baixar</button>
        <button onClick={toggleFavorite} aria-pressed={favorited} className={action}><Anchor className={`w-4 h-4 ${favorited ? "fill-current text-(--text-accent)" : ""}`} aria-hidden />{favorited ? "Ancorado" : "Ancorar"}</button>
        <button onClick={(e) => onMenu(e.currentTarget)} aria-haspopup="menu" className={action}><MoreHorizontal className="w-4 h-4" aria-hidden />Mais</button>
      </div>
      {canEdit && (
        <button onClick={() => setSharing(true)} className="w-full flex items-center justify-center gap-2 h-9 pointer-coarse:h-11 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover)">
          <Share2 className="w-4 h-4" aria-hidden />{shareCount > 0 ? `Compartilhado em ${shareCount} ${shareCount === 1 ? "link" : "links"}` : "Compartilhar por link"}
        </button>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-mac-caption">
        <dt className="text-(--text-secondary)">Tipo</dt><dd className="text-(--text-primary) text-right">{kindLabel(doc.name)}</dd>
        <dt className="text-(--text-secondary)">Tamanho</dt><dd className="text-(--text-primary) text-right tabular-nums">{fmtSize(doc.size_bytes)}</dd>
        <dt className="text-(--text-secondary)">Enviado</dt><dd className="text-(--text-primary) text-right">{fmtDateFull(doc.created_at)}{doc.uploaded_by_name ? ` por ${doc.uploaded_by_name}` : ""}</dd>
        {doc.updated_at && <><dt className="text-(--text-secondary)">Modificado</dt><dd className="text-(--text-primary) text-right">{fmtDateFull(doc.updated_at)}</dd></>}
        <dt className="text-(--text-secondary)">Texto</dt><dd className="text-right">{ocrBadge(doc.ocr_status)}</dd>
      </dl>
      {doc.ocr_status === "failed" && canEdit && (
        <button onClick={() => api.post(`/documents/${doc.id}/retry-ocr`).then(() => { success("O texto vai ser lido de novo."); onChanged(); }).catch((e) => showError(friendlyError(e, "Não foi possível pôr na fila.")))}
          className="w-full h-9 pointer-coarse:h-11 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover)">
          Ler o texto de novo
        </button>
      )}

      <MetadataSection doc={doc} companyId={companyId} canEdit={canEdit} onSaved={(fid, v) => onFieldSaved(doc.id, fid, v)} />
      <VersionsPanel documentId={doc.id} documentName={doc.name} onChanged={onChanged} />
      <DocumentRetentionSection docId={doc.id} />
      <Disclosure icon={<Clock className="w-4 h-4" aria-hidden />} title="Atividade">
        <ActivityFeed companyId={companyId} itemId={doc.id} pageSize={20} groupByDay={false} emptyDescription="Nenhuma atividade registrada neste documento ainda." />
      </Disclosure>
    </div>
  );

  const shareModal = sharing && (
    <ShareModal resourceType="document" resourceId={doc.id} name={doc.name} onClose={() => setSharing(false)} onChanged={setShareCount} />
  );

  if (variant === "panel") {
    // Painel lateral persistente (não modal), entra deslizando (A5-05).
    return (
      <aside aria-label={`Detalhes de ${doc.name}`} className="panel-in hidden lg:flex flex-col w-[340px] shrink-0 border-l border-(--border-default) overflow-hidden">
        <div className="flex items-center justify-between px-5 h-12 border-b border-(--border-default) shrink-0">
          <p className="text-mac-body font-semibold text-(--text-secondary)">Detalhes</p>
          <button onClick={onClose} aria-label="Fechar detalhes" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)">
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{body}</div>
        {shareModal}
      </aside>
    );
  }

  return (
    <>
      <Dialog onClose={onClose} title={`Detalhes de ${doc.name}`} hideTitle size="md">{body}</Dialog>
      {shareModal}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

const NAV_KEY = "documents";

// Fase 8.2: edição de metadados em lote — abre a partir da barra de seleção
// múltipla. Cada campo mostra "(varies)" quando os documentos selecionados
// têm valores diferentes; deixar o campo assim (sem digitar nada) preserva
// o valor de cada documento — só os campos que a pessoa realmente editar
// são enviados, um PUT por documento reaproveitando o mesmo endpoint do
// formulário individual (sem endpoint novo, sem migration).
function BulkMetadataModal({
  documentIds, fields, fieldValues, companyId, onClose, onSaved,
}: {
  documentIds: string[]; fields: ResolvedField[]; fieldValues: Record<string, Record<string, string>>;
  companyId: string; onClose: () => void; onSaved: () => void;
}) {
  const { success, error: showError } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function fieldSummary(fieldId: string): { varies: boolean; common: string } {
    const values = documentIds.map((id) => fieldValues[id]?.[fieldId] ?? "");
    const distinct = new Set(values.filter((v) => v !== ""));
    if (distinct.size === 0) return { varies: false, common: "" };
    if (distinct.size === 1) return { varies: false, common: [...distinct][0] };
    return { varies: true, common: "" };
  }

  async function save() {
    const changedFieldIds = Object.keys(edited);
    if (changedFieldIds.length === 0) { onClose(); return; }
    setSaving(true);
    const body = changedFieldIds.map((fieldId) => ({ custom_field_id: fieldId, value: edited[fieldId] }));
    let failCount = 0;
    for (const docId of documentIds) {
      try {
        await api.put(`/documents/${docId}/field-values`, body, { params: { company_id: companyId } });
      } catch {
        failCount++;
      }
    }
    setSaving(false);
    if (failCount === 0) {
      success(`Metadados atualizados em ${documentIds.length} documento${documentIds.length > 1 ? "s" : ""}.`);
    } else {
      showError(`${failCount} de ${documentIds.length} documentos não foram atualizados — confira o formato dos valores.`);
    }
    onSaved();
    onClose();
  }

  return (
    <Portal>
      <div className="fixed inset-0 bg-(--overlay-scrim) flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div ref={containerRef} className="glass-dialog glass-blur-strong rounded-(--radius-dialog) shadow-modal modal-card w-full max-w-[440px] max-h-[80vh] flex flex-col">
          <div className="flex items-center justify-between px-5 py-3 border-b border-(--border-default) shrink-0">
            <h2 className="text-mac-body font-semibold text-(--text-primary)">
              Editar metadados de {documentIds.length} documento{documentIds.length > 1 ? "s" : ""}
            </h2>
            <button onClick={onClose} className="p-1 rounded-[6px] text-(--text-secondary) hover:bg-(--bg-hover)">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-5 space-y-4 overflow-y-auto">
            {fields.length === 0 ? (
              <p className="text-mac-caption text-(--text-tertiary)">Nenhum campo de metadado aplicado nesta pasta.</p>
            ) : (
              fields.map((f) => {
                const { varies, common } = fieldSummary(f.custom_field_id);
                const value = edited[f.custom_field_id] ?? "";
                return (
                  <div key={f.custom_field_id}>
                    <label className="block text-mac-caption font-medium text-(--text-secondary) mb-1.5">{f.label}</label>
                    {f.type === "selecao" ? (
                      <Dropdown
                        value={value}
                        onChange={(v) => setEdited((e) => ({ ...e, [f.custom_field_id]: v }))}
                        placeholder={varies ? "(varies)" : common || "—"}
                        options={((f.format_config?.options as string[]) ?? []).map((o) => ({ value: o, label: o }))}
                      />
                    ) : (
                      <input
                        type="text"
                        value={value}
                        onChange={(e) => setEdited((prev) => ({ ...prev, [f.custom_field_id]: e.target.value }))}
                        placeholder={varies ? "(varies)" : common || "—"}
                        className="w-full h-9 px-3 text-mac-body bg-(--bg-card) border border-(--border-default) rounded-(--radius-control) text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-teal-500/70"
                      />
                    )}
                  </div>
                );
              })
            )}
            {fields.length > 0 && (
              <p className="text-mac-caption2 text-(--text-tertiary)">
                Campos deixados como "(varies)" ou vazios não são alterados — só os que você preencher aqui são aplicados a todos os documentos selecionados.
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-(--border-default) shrink-0">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
            <Button size="sm" loading={saving} onClick={save} disabled={fields.length === 0}>Aplicar</Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default function Documents() {
  usePageTitle("Documentos");
  const { current } = useCompany();
  const { toast, dismiss: dismissToast, success, error: showError } = useToast();
  const nav = useNavigation();
  // Fase 8.1: painel lateral persistente só cabe em telas largas (mesmo
  // breakpoint `lg` já usado pra sidebar de pastas) — no mobile o modal
  // centralizado continua sendo o único jeito de ver detalhes.
  const isDesktop = useMediaQuery("(min-width: 1024px)");

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
  // Regra dos 200ms: só mostra skeleton se a carga passar de 200ms, e uma vez
  // visível fica pelo menos 500ms — evita o "flicker" em resposta de cache quente.
  const showSkeleton = useDelayedLoading(loading);
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
  const [showBulkMetadata, setShowBulkMetadata] = useState(false);
  const [detailDoc, setDetailDoc] = useState<Document | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<Folder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
  const [sharingDoc, setSharingDoc] = useState<Document | null>(null);
  const [showTreeDrawer, setShowTreeDrawer] = useState(false);
  const [copyingFolder, setCopyingFolder] = useState<Folder | null>(null);
  // Menu de contexto (clique direito, toque longo ou botão "…") no primitivo
  // Menu acessível (achados A4-31..A4-35): teclado, leitor de tela, atalhos.
  type MenuTarget =
    | { anchor: { x: number; y: number } | HTMLElement; kind: "document"; data: Document }
    | { anchor: { x: number; y: number } | HTMLElement; kind: "folder"; data: Folder };
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  function openContextMenu(e: React.MouseEvent, kind: "document" | "folder", data: Document | Folder) {
    e.preventDefault();
    e.stopPropagation();
    setFocusedId(data.id);
    if (kind === "document" && !selected.has(data.id)) setSelected(new Set([data.id]));
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, kind, data } as MenuTarget);
  }
  function openMenuAt(el: HTMLElement, kind: "document" | "folder", data: Document | Folder) {
    setFocusedId(data.id);
    if (kind === "document" && !selected.has(data.id)) setSelected(new Set([data.id]));
    setMenu({ anchor: el, kind, data } as MenuTarget);
  }
  // "Mover para…" (documentos ou pasta) — achados A4-36 e X1-08.
  const [picker, setPicker] = useState<{ kind: "documents"; ids: string[] } | { kind: "folder"; folder: Folder } | null>(null);
  // Erro de carga nunca vira "Pasta vazia" (achado A4-01).
  const [loadError, setLoadError] = useState<string | null>(null);
  // Paginação (achado A4-12): 200 por vez, o resto ao rolar.
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [folderDeleteSummary, setFolderDeleteSummary] = useState<{ subfolders: number; documents: number } | null>(null);
  const canWrite = current?.permission_level === "admin" || current?.permission_level === "operador" || current?.permission_level === "supremo";
  const canAdmin = current?.permission_level === "admin" || current?.permission_level === "supremo";
  function menuItems(t: MenuTarget): MenuItem[] {
    if (t.kind === "document") {
      const d = t.data;
      const ids = selected.has(d.id) && selected.size > 1 ? [...selected] : [d.id];
      const multi = ids.length > 1;
      const list: MenuItem[] = [];
      if (!multi) {
        list.push({ label: "Abrir", icon: <Eye />, shortcut: "Espaço", onSelect: () => setPreviewDoc(d) });
        list.push({ label: "Detalhes", icon: <Info />, onSelect: () => setDetailDoc(d) });
      }
      list.push({ label: multi ? `Baixar ${ids.length} em ZIP` : "Baixar", icon: <Download />, separatorBefore: !multi, onSelect: () => downloadDocuments(ids) });
      if (!multi) {
        list.push({ label: "Copiar link", icon: <Link2 />, onSelect: () => copyLink(d) });
        list.push({ label: "Compartilhar…", icon: <Share2 />, disabled: !canWrite, onSelect: () => setSharingDoc(d) });
      }
      list.push({ label: multi ? "Ancorar todos" : d.favorited ? "Já está ancorado" : "Ancorar", icon: <Anchor />, disabled: !multi && !!d.favorited, onSelect: () => anchorDocuments(ids) });
      if (canWrite) {
        list.push({ label: "Mover para…", icon: <FolderInput />, separatorBefore: true, onSelect: () => setPicker({ kind: "documents", ids }) });
        if (!multi) list.push({ label: "Renomear", icon: <Pencil />, shortcut: "F2", onSelect: () => startRename("document", d.id, d.name) });
        list.push({ label: multi ? `Excluir ${ids.length}` : "Excluir", icon: <Trash2 />, shortcut: "Del", danger: true, separatorBefore: true, onSelect: () => deleteDocuments(ids) });
      }
      return list;
    }
    const f = t.data;
    const list: MenuItem[] = [{ label: "Abrir", icon: <FolderOpen />, shortcut: "Enter", onSelect: () => openFolder(f) }];
    list.push({ label: "Compartilhar…", icon: <Share2 />, disabled: !canWrite, onSelect: () => setSharingFolder(f) });
    if (canAdmin) {
      list.push({ label: "Mover para…", icon: <FolderInput />, separatorBefore: true, onSelect: () => setPicker({ kind: "folder", folder: f }) });
      list.push({ label: "Renomear", icon: <Pencil />, shortcut: "F2", onSelect: () => startRename("folder", f.id, f.name) });
      list.push({ label: "Copiar estrutura para…", icon: <Copy />, onSelect: () => setCopyingFolder(f) });
      list.push({ label: "Permissões desta pasta", icon: <Shield />, separatorBefore: true, onSelect: () => navigate(`/settings/users?folder=${f.id}`) });
      list.push({ label: "Metadados desta pasta", icon: <Tags />, onSelect: () => navigate(`/settings/metadata?tab=tree&folder=${f.id}`) });
      list.push({ label: "Retenção desta pasta", icon: <Archive />, onSelect: () => navigate(`/settings/retention?folder=${f.id}`) });
      list.push({ label: "Excluir pasta", icon: <Trash2 />, shortcut: "Del", danger: true, separatorBefore: true, onSelect: () => askDeleteFolder(f) });
    }
    return list;
  }

  // Carregar mais ao chegar ao fim da lista.
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) loadMore(); }, { rootMargin: "400px" });
    obs.observe(el);
    return () => obs.disconnect();
  });

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

  async function runUndo(id?: string) {
    const entry = takeUndo(id);
    if (!entry) { toast({ type: "info", message: "Não há nada para desfazer." }); return; }
    try {
      await entry.undo();
      toast({ type: "success", message: `Desfeito: ${entry.label}.` });
    } catch (e: any) {
      showError(friendlyError(e, `Não foi possível desfazer: ${entry.label}.`));
    }
    load();
    setFolderTreeVersion((v) => v + 1);
  }

  /** Aviso com "Desfazer" ligado à mesma entrada do Ctrl+Z. */
  function toastWithUndo(message: string, label: string, undo: () => Promise<void>) {
    const entry = pushUndo(label, undo);
    toast({ type: "success", message, action: { label: "Desfazer", onClick: () => runUndo(entry.id) } });
  }

  // Renomear grava na hora (antes esperava 5 s e se perdia ao recarregar — A4-45).
  async function confirmRename() {
    if (!renaming) return;
    const { kind, id, value } = renaming;
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed) { setRenaming(null); return; }
    if (FORBIDDEN_NAME_CHARS.test(trimmed)) {
      showError('O nome não pode ter \\ / : * ? " < > |.');
      return;
    }
    const oldName = kind === "folder" ? folders.find((f) => f.id === id)?.name : documents.find((d) => d.id === id)?.name;
    if (!oldName) { setRenaming(null); return; }
    const ext = kind === "document" ? splitExt(oldName)[1] : "";
    const newName = `${trimmed}${ext}`;
    if (newName === oldName) { setRenaming(null); return; }
    const siblings = kind === "folder"
      ? folders.filter((f) => f.id !== id).map((f) => f.name.toLowerCase())
      : documents.filter((d) => d.id !== id).map((d) => d.name.toLowerCase());
    if (siblings.includes(newName.toLowerCase())) {
      showError(`Já existe ${kind === "folder" ? "uma pasta" : "um documento"} "${newName}" aqui.`);
      return;
    }
    setRenaming(null);
    const apply = (name: string) => {
      if (kind === "folder") setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name } : f)));
      else setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, name } : d)));
    };
    const save = (name: string) => (kind === "folder" ? api.patch(`/folders/${id}/rename`, { name }) : api.patch(`/documents/${id}`, { name }));
    apply(newName);
    try {
      await save(newName);
      if (kind === "folder") setFolderTreeVersion((v) => v + 1);
      toastWithUndo(`Renomeado para "${newName}".`, `renomear "${oldName}"`, async () => { await save(oldName); });
    } catch (e: any) {
      apply(oldName);
      showError(friendlyError(e, "Não foi possível renomear."));
    }
  }

    // Typeahead — digitar letras pula pro primeiro item cujo nome começa com elas,
  // exatamente como Finder/Explorer em qualquer lista. Buffer acumula por 800ms
  // (janela padrão do gesto) e então reseta, permitindo digitar várias letras
  // em sequência pra refinar o alvo (ex: "ho" pula pra "Holerite" em vez de "Home").
  const typeaheadBufferRef = useRef("");
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Teclado da lista e da grade (achados A4-13, A4-22, A4-25, A4-61):
  // setas e Home/End movem o foco (Shift estende a seleção), Enter abre,
  // Espaço pré-visualiza, F2 renomeia, Delete/⌘⌫ exclui, Esc limpa a seleção,
  // ⌘A seleciona o que está visível, ⌘Z desfaz e ⌘⇧N cria pasta.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
      const modalOpen = !!(previewDoc || showUpload || showNewFolder || confirmDeleteFolder || sharingFolder || copyingFolder || picker || menu || showBulkMetadata)
        || !!document.querySelector('[role="dialog"][aria-modal="true"]');
      if (typing || modalOpen) return;
      if (target.closest('aside, [role="tree"], header, nav, [data-dock]')) return;

      const mod = e.metaKey || e.ctrlKey;
      if (isUndoShortcut(e)) { e.preventDefault(); runUndo(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); if (currentFolderId !== undefined && canWrite) setShowNewFolder(true); return; }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(visibleDocuments.map((d) => d.id)));
        return;
      }
      if (e.key === "Escape" && selected.size) { setSelected(new Set()); return; }

      const order = items.map((it) => it.data.id);
      const idx = focusedId ? order.indexOf(focusedId) : -1;
      const moveTo = (next: number) => {
        if (!order.length) return;
        const clamped = Math.max(0, Math.min(order.length - 1, next));
        const id = order[clamped];
        e.preventDefault();
        setFocusedId(id);
        const isDoc = items[clamped].kind === "document";
        if (e.shiftKey && isDoc) {
          const anchor = idx >= 0 ? idx : clamped;
          const [a, b] = anchor < clamped ? [anchor, clamped] : [clamped, anchor];
          setSelected(new Set(items.slice(a, b + 1).filter((it) => it.kind === "document").map((it) => it.data.id)));
        } else if (!mod) {
          setSelected(isDoc ? new Set([id]) : new Set());
        }
        // O painel de detalhes acompanha o item em foco (como a pré-visualização do Finder).
        if (isDoc && detailDoc && isDesktop) {
          const d = documents.find((x) => x.id === id);
          if (d) setDetailDoc(d);
        }
        const el = rowRefs.current.get(id);
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: "nearest" });
      };
      const cols = viewMode === "grid" ? Math.max(1, Math.round((scrollBodyRef.current?.clientWidth ?? 600) / 118)) : 1;
      if (e.key === "ArrowDown") return moveTo(idx < 0 ? 0 : idx + cols);
      if (e.key === "ArrowUp") return moveTo(idx < 0 ? 0 : idx - cols);
      if (viewMode === "grid" && e.key === "ArrowRight") return moveTo(idx + 1);
      if (viewMode === "grid" && e.key === "ArrowLeft") return moveTo(idx - 1);
      if (e.key === "Home") return moveTo(0);
      if (e.key === "End") return moveTo(order.length - 1);

      // Typeahead: uma única letra/dígito sem modificador.
      if (e.key.length === 1 && e.key !== " " && !mod && !e.altKey) {
        typeaheadBufferRef.current += e.key.toLowerCase();
        if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
        typeaheadTimerRef.current = setTimeout(() => { typeaheadBufferRef.current = ""; }, 800);
        const query = typeaheadBufferRef.current;
        const hit = items.findIndex((it) => it.data.name.toLowerCase().startsWith(query));
        if (hit >= 0) moveTo(hit);
        return;
      }

      if (!focusedId) return;
      const doc = documents.find((d) => d.id === focusedId);
      const folder = folders.find((f) => f.id === focusedId);
      // Menu de ações pelo teclado: tecla Menu ou Shift+F10 (padrão do sistema).
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        const el = rowRefs.current.get(focusedId);
        if (el && doc) { e.preventDefault(); openMenuAt(el, "document", doc); }
        else if (el && folder) { e.preventDefault(); openMenuAt(el, "folder", folder); }
        return;
      }
      if (e.code === "Space" && doc) { e.preventDefault(); setPreviewDoc(doc); }
      else if (e.key === "Enter") {
        e.preventDefault();
        if (folder) openFolder(folder);
        else if (doc) setPreviewDoc(doc);
      } else if (e.key === "F2" && canWrite) {
        e.preventDefault();
        if (doc) startRename("document", doc.id, doc.name);
        else if (folder && canAdmin) startRename("folder", folder.id, folder.name);
      } else if ((e.key === "Delete" || (mod && e.key === "Backspace")) && canWrite) {
        e.preventDefault();
        if (selected.size) deleteDocuments([...selected]);
        else if (doc) deleteDocuments([doc.id]);
        else if (folder && canAdmin) askDeleteFolder(folder);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  });

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
        if (rowBottom >= top && rowTop <= bottom && rowRight >= left && rowLeft <= right && documents.some((d) => d.id === id)) hitIds.push(id);
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

  const PAGE = 200;
  // Com mais de uma página, o filtro e a ordenação vão para o servidor.
  const [serverQuery, setServerQuery] = useState("");
  const load = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());

    const foldersParams: Record<string, string> = { company_id: current.id };
    if (currentFolderId) foldersParams.parent_id = currentFolderId;
    try {
      const [fRes, dRes] = await Promise.all([
        api.get<Folder[]>("/folders", { params: foldersParams }),
        currentFolderId
          ? api.get<Document[]>("/documents", {
              params: { company_id: current.id, folder_id: currentFolderId, limit: PAGE, offset: 0, sort: sort.key, dir: sort.dir, q: serverQuery || undefined },
            })
          : Promise.resolve({ data: [] as Document[], headers: {} as Record<string, string> }),
      ]);
      const docs = Array.isArray(dRes.data) ? dRes.data : [];
      setFolders(Array.isArray(fRes.data) ? fRes.data : []);
      setDocuments(docs);
      setTotal(Number((dRes.headers as Record<string, string>)?.["x-total-count"] ?? docs.length) || docs.length);
    } catch (e: any) {
      setFolders([]);
      setDocuments([]);
      setTotal(0);
      setLoadError(friendlyError(e, "Não foi possível abrir esta pasta agora."));
    } finally {
      setLoading(false);
    }
  }, [current?.id, currentFolderId, sort.key, sort.dir, serverQuery]);

  async function loadMore() {
    if (!current || !currentFolderId || loadingMore || documents.length >= total) return;
    setLoadingMore(true);
    try {
      const r = await api.get<Document[]>("/documents", {
        params: { company_id: current.id, folder_id: currentFolderId, limit: PAGE, offset: documents.length, sort: sort.key, dir: sort.dir, q: serverQuery || undefined },
      });
      setDocuments((prev) => {
        const ids = new Set(prev.map((d) => d.id));
        return [...prev, ...r.data.filter((d) => !ids.has(d.id))];
      });
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível carregar mais documentos."));
    } finally {
      setLoadingMore(false);
    }
  }

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
    api.post<DocFieldValueRow[]>("/documents/field-values/query", { document_ids: documents.slice(0, 1000).map((d) => d.id) })
      .then((r) => {
        const map: Record<string, Record<string, string>> = {};
        for (const row of Array.isArray(r.data) ? r.data : []) {
          (map[row.document_id] ??= {})[row.custom_field_id] = row.value_text;
        }
        setFieldValues(map);
      })
      .catch(() => setFieldValues({}));
  }, [resolvedFields.length, documents]);

  const navigate = useNavigate();

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
        setSearchParams({ pasta: linkedFolderId }, { replace: true });
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

  // A pasta aberta fica no endereço (?pasta=): recarregar, voltar e copiar o
  // link levam à mesma pasta (achado A4-02).
  const pastaParam = searchParams.get("pasta");
  useEffect(() => {
    if (!current || searchParams.get("folder_id")) return;
    if (pastaParam && pastaParam !== currentFolderId) jumpToFolder(pastaParam);
    else if (!pastaParam && currentFolderId) setSearchParams({ pasta: currentFolderId }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id, pastaParam]);
  useEffect(() => {
    if (searchParams.get("folder_id")) return;
    if ((currentFolderId ?? null) !== (pastaParam ?? null)) {
      setSearchParams(currentFolderId ? { pasta: currentFolderId } : {}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFolderId]);

  // Filtro no servidor quando a pasta tem mais documentos do que os carregados.
  useEffect(() => {
    const q = filterQuery.trim();
    if (total <= PAGE && !serverQuery) return;
    const t = window.setTimeout(() => setServerQuery(q), 250);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery]);
  useEffect(() => { setServerQuery(""); }, [currentFolderId]);

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
    // Só o que está visível (filtro aplicado) — antes o ⌘A pegava os ocultos (A4-25).
    const allIds = visibleDocuments.map((d) => d.id);
    setSelected(selected.size === allIds.length ? new Set() : new Set(allIds));
  }

  // Excluir grava na hora e empilha a restauração (achados A4-26, A4-61).
  async function deleteDocuments(ids: string[]) {
    if (!ids.length) return;
    const backup = documents.filter((d) => ids.includes(d.id));
    setDocuments((prev) => prev.filter((d) => !ids.includes(d.id)));
    setTotal((t) => Math.max(0, t - ids.length));
    setSelected(new Set());
    if (detailDoc && ids.includes(detailDoc.id)) setDetailDoc(null);
    const deleted: string[] = [];
    const blocked: { name: string }[] = [];
    try {
      for (const part of chunks(ids, 1000)) {
        const r = await api.post("/documents/bulk-delete", { document_ids: part });
        deleted.push(...(r.data.document_ids ?? []));
        blocked.push(...(r.data.blocked ?? []));
      }
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível excluir."));
    }
    const kept = backup.filter((d) => !deleted.includes(d.id));
    if (kept.length) {
      setDocuments((prev) => [...prev, ...kept]);
      setTotal((t) => t + kept.length);
    }
    if (blocked.length) {
      showError(`${plural(blocked.length, "documento ficou", "documentos ficaram")} na pasta por legal hold ou retenção obrigatória: ${blocked.slice(0, 3).map((b) => b.name).join(", ")}${blocked.length > 3 ? "…" : ""}.`);
    }
    if (deleted.length) {
      toastWithUndo(
        `${plural(deleted.length, "documento foi", "documentos foram")} para a lixeira.`,
        `exclusão de ${plural(deleted.length, "documento", "documentos")}`,
        async () => { for (const part of chunks(deleted, 1000)) await api.post("/documents/bulk-restore", { document_ids: part }); },
      );
    }
  }

  function deleteSelected() {
    deleteDocuments([...selected]);
  }

  async function moveDocuments(ids: string[], targetFolderId: string, targetFolderName: string) {
    if (!ids.length || targetFolderId === currentFolderId) return;
    const source = currentFolderId;
    const backup = documents.filter((d) => ids.includes(d.id));
    setDocuments((prev) => prev.filter((d) => !ids.includes(d.id)));
    setTotal((t) => Math.max(0, t - ids.length));
    setSelected(new Set());
    if (detailDoc && ids.includes(detailDoc.id)) setDetailDoc(null);
    try {
      for (const part of chunks(ids, 1000)) await api.post("/documents/bulk-move", { document_ids: part, target_folder_id: targetFolderId });
      toastWithUndo(
        `${plural(ids.length, "documento movido", "documentos movidos")} para "${targetFolderName}".`,
        `mover ${plural(ids.length, "documento", "documentos")}`,
        async () => { if (source) for (const part of chunks(ids, 1000)) await api.post("/documents/bulk-move", { document_ids: part, target_folder_id: source }); },
      );
    } catch (e: any) {
      setDocuments((prev) => [...prev, ...backup]);
      setTotal((t) => t + backup.length);
      showError(friendlyError(e, "Não foi possível mover."));
    }
  }

  async function moveFolder(folder: Folder, target: PickedFolder) {
    const oldParent = folder.parent_id;
    try {
      await api.patch(`/folders/${folder.id}/move`, { parent_id: target.id });
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      setFolderTreeVersion((v) => v + 1);
      toastWithUndo(`Pasta "${folder.name}" movida para "${target.name}".`, `mover a pasta "${folder.name}"`, async () => {
        await api.patch(`/folders/${folder.id}/move`, { parent_id: oldParent });
      });
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível mover a pasta."));
    }
  }

  // Pasta movida arrastando na árvore: recarrega e oferece Desfazer.
  function onTreeMove(folderId: string, _newParent: string | null, oldParent: string | null, name: string) {
    if (breadcrumbs.some((b) => b.id === folderId)) jumpToFolder(currentFolderId ?? folderId);
    else load();
    toastWithUndo(`Pasta "${name}" movida.`, `mover a pasta "${name}"`, async () => {
      await api.patch(`/folders/${folderId}/move`, { parent_id: oldParent });
    });
  }

  // Confirmação de excluir pasta diz o volume (achado A4-43).
  function askDeleteFolder(folder: Folder) {
    setFolderDeleteSummary(null);
    setConfirmDeleteFolder(folder);
    api.get(`/folders/${folder.id}/summary`).then((r) => setFolderDeleteSummary(r.data)).catch(() => {});
  }

  async function deleteFolder(folder: Folder) {
    setDeletingFolder(true);
    try {
      await api.delete(`/folders/${folder.id}`);
      setConfirmDeleteFolder(null);
      setFolders((prev) => prev.filter((f) => f.id !== folder.id));
      setFolderTreeVersion((v) => v + 1);
      toastWithUndo(`Pasta "${folder.name}" foi para a lixeira.`, `excluir a pasta "${folder.name}"`, async () => {
        await api.post(`/trash/${folder.id}/restore`, null, { params: { item_type: "folder" } });
      });
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível excluir a pasta."));
    } finally {
      setDeletingFolder(false);
    }
  }

  async function downloadDocuments(ids: string[]) {
    if (ids.length === 1) {
      try {
        const r = await api.get(`/documents/${ids[0]}/download-url`);
        const a = document.createElement("a");
        a.href = r.data.download_url;
        a.download = r.data.name ?? "";
        a.click();
      } catch (e: any) {
        showError(friendlyError(e, "Não foi possível baixar."));
      }
      return;
    }
    if (ids.length > 200) { showError("Baixe até 200 documentos por vez. Para tudo, use Ajustes → Organização → Exportar tudo."); return; }
    const t = toast({ type: "info", message: `Preparando o ZIP com ${plural(ids.length, "documento", "documentos")}…`, duration: 60000 });
    try {
      const r = await api.post("/documents/bulk-download", { document_ids: ids }, { responseType: "blob" });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = `docke-${(breadcrumbs[breadcrumbs.length - 1]?.name ?? "documentos").replace(/[\\/:*?"<>|]/g, "_")}.zip`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível montar o ZIP."));
    } finally {
      dismissToast(t);
    }
  }

  async function anchorDocuments(ids: string[]) {
    let ok = 0;
    for (const id of ids) {
      try { await api.post("/favorites", { document_id: id }); ok++; } catch (e: any) { if (e?.response?.status === 409) ok++; }
    }
    setDocuments((prev) => prev.map((d) => (ids.includes(d.id) ? { ...d, favorited: true } : d)));
    loadSidebarFavorites();
    success(`${plural(ok, "documento ancorado", "documentos ancorados")}.`);
  }

  function copyLink(doc: Document) {
    const url = `${window.location.origin}/documents?folder_id=${doc.folder_id ?? currentFolderId}&doc=${doc.id}`;
    navigator.clipboard?.writeText(url).then(
      () => success("Link copiado. Quem tiver acesso à pasta abre direto no documento."),
      () => showError("Não foi possível copiar o link."),
    );
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
      if (isDesktop) setDetailDoc(null);
      return;
    }
    setSelected(new Set([id]));
    setFocusedId(id);
    // Fase 8.1: clique simples já abre o painel lateral persistente no
    // desktop — sem esse gatilho o painel "nunca modal" das 11 rodadas não
    // teria como aparecer sem um segundo clique/duplo-clique. No mobile não
    // mexe em nada (só "..." e duplo-toque continuam abrindo o modal).
    if (isDesktop) {
      const doc = documents.find((d) => d.id === id);
      if (doc) setDetailDoc(doc);
    }
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
      className={`flex h-[calc(100%+3rem)] -mt-6 py-2 glass-panel glass-highlight-line rounded-(--radius-panel) glass-shadow overflow-hidden ${
        tableScrolling ? "glass-scroll-active" : ""
      } glass-blur-table`}
    >
      {/* Sidebar de pastas — desktop only (lg+) */}
      <aside className="hidden lg:flex flex-col w-[220px] shrink-0 border-r border-(--border-default)">
        <div className="px-3 py-3 border-b border-(--border-default) shrink-0">
          <h2 className="text-mac-body font-semibold text-(--text-secondary)">Pastas</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {/* Seção "Ancorados" — mesmo agrupamento por rótulo em caixa alta que
              o Finder usa pra "Favorites": atalho direto pra itens ancorados,
              cruzando pastas, sem precisar navegar até eles (ADENDO-09 §13). */}
          {sidebarFavorites.length > 0 && (
            <>
              <button
                onClick={() => toggleSidebarSection("ancorados")}
                className="w-full flex items-center gap-1 px-2.5 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-(--text-tertiary) hover:text-(--text-secondary) transition-colors duration-fast"
              >
                <ChevronDown className={`w-2.5 h-2.5 shrink-0 transition-transform duration-fast ${collapsedSidebarSections.has("ancorados") ? "-rotate-90" : ""}`} />
                Ancorados
              </button>
              {!collapsedSidebarSections.has("ancorados") &&
                sidebarFavorites.slice(0, 6).map((fav) => (
                  <button
                    key={fav.id}
                    onClick={() => openSidebarFavorite(fav)}
                    className="w-full flex items-center gap-1.5 h-8 pl-3 pr-2 text-mac-body rounded-[6px] transition-colors duration-fast text-left text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)"
                  >
                    {fav.item_type === "folder" ? (
                      <Folder className="w-4 h-4 text-teal-500 shrink-0" />
                    ) : (
                      (() => { const s = getFileStyle(fav.item_name); const Icon = s.icon; return <Icon className={`w-4 h-4 shrink-0 ${s.iconColor} ${s.fillColor}`} />; })()
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
            className={`w-full flex items-center gap-1 px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-(--text-tertiary) hover:text-(--text-secondary) transition-colors duration-fast ${sidebarFavorites.length > 0 ? "pt-3" : "pt-1.5"}`}
          >
            <ChevronDown className={`w-2.5 h-2.5 shrink-0 transition-transform duration-fast ${collapsedSidebarSections.has("locais") ? "-rotate-90" : ""}`} />
            Locais
          </button>
          {!collapsedSidebarSections.has("locais") && (
            <>
              <button
                onClick={navigateHome}
                className={`w-full flex items-center gap-1.5 h-8 pl-3 pr-2 text-mac-body rounded-[6px] transition-colors duration-fast text-left ${
                  currentFolderId === null
                    ? "bg-teal-500/10 text-teal-500 font-medium"
                    : "text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)"
                }`}
              >
                <Home className="w-4 h-4 shrink-0" />
                Início
              </button>
              {current && (
                <FolderTree
                  version={folderTreeVersion}
                  companyId={current.id}
                  activeFolderId={currentFolderId}
                  onSelect={(f) => jumpToFolder(f.id)}
                  onDropDocuments={(folderId, documentIds, folderName) => {
                    moveDocuments(documentIds, folderId, folderName);
                    setDragDocIds(null);
                  }}
                  onMove={onTreeMove}
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
        <div className="flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-(--border-default) shrink-0">
          {/* Voltar/avançar — todo navegador de arquivos de verdade (Finder,
              Explorer) tem esse par de botões na ponta esquerda da barra de
              ferramentas; histórico independente do breadcrumb (que só
              reflete o caminho atual). */}
          <div className="hidden sm:flex items-center gap-0.5 shrink-0">
            <Tooltip label="Voltar">
              <button
                onClick={goBack}
                disabled={!canGoBack}
                className="h-7 w-7 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) transition-colors duration-fast disabled:opacity-30 disabled:pointer-events-none"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </Tooltip>
            <Tooltip label="Avançar">
              <button
                onClick={goForward}
                disabled={!canGoForward}
                className="h-7 w-7 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) transition-colors duration-fast disabled:opacity-30 disabled:pointer-events-none"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>

          {/* Título da janela (sm+) — o Finder real só mostra o nome da pasta
              atual na toolbar (nunca uma trilha clicável: "Use a path control
              in the window body, not the window frame", HIG). A trilha
              navegável completa mora na barra de caminho no rodapé, abaixo. */}
          <div className="hidden sm:flex items-center gap-2 flex-1 min-w-0">
            {/* Tablet (768–1023 px): a árvore abre num painel (achados A4-04, A4-11). */}
            <button
              onClick={() => setShowTreeDrawer(true)}
              className="lg:hidden flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full border border-(--border-control) text-mac-body text-(--text-primary) hover:bg-(--bg-hover) shrink-0"
            >
              <Folder className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400" aria-hidden /> Pastas
            </button>
            <h1 className="text-mac-body font-semibold text-(--text-primary) truncate">
              {breadcrumbs[breadcrumbs.length - 1].name}
            </h1>
          </div>

          {/* Breadcrumbs — versão truncada (mobile): Início, "…" (seletor com as pastas ocultas, em ordem) e a pasta atual */}
          <nav className="flex sm:hidden items-center gap-1 flex-1 min-w-0">
            <button onClick={() => navigateBreadcrumb(0)} className="shrink-0 text-(--text-secondary) hover:text-teal-500 transition-colors duration-fast">
              <Home className="w-4 h-4" />
            </button>
            {breadcrumbs.length > 2 && (
              <>
                <ChevronRight className="w-3.5 h-3.5 text-(--text-tertiary) shrink-0" />
                <div className="relative" ref={crumbMenuRef}>
                  <button
                    onClick={() => setCrumbMenuOpen((v) => !v)}
                    className="shrink-0 text-mac-body text-(--text-secondary) hover:text-teal-500 transition-colors duration-fast"
                  >
                    …
                  </button>
                  {crumbMenuOpen && (
                    <div className="popover-tail-left absolute top-full left-0 mt-1 w-56 glass-panel glass-blur-strong rounded-(--radius-popover) shadow-dropdown py-1 z-50">
                      {breadcrumbs.slice(1, -1).map((crumb, i) => (
                        <button
                          key={crumb.id}
                          onClick={() => { navigateBreadcrumb(i + 1); setCrumbMenuOpen(false); }}
                          className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-left text-(--text-primary) hover:bg-teal-500 hover:text-white [&:hover_svg]:text-white transition-colors duration-fast"
                        >
                          <FolderOpen className="w-3.5 h-3.5 text-teal-500 shrink-0" />
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
                <ChevronRight className="w-3.5 h-3.5 text-(--text-tertiary) shrink-0" />
                <span className="text-mac-body font-medium text-(--text-primary) truncate">
                  {breadcrumbs[breadcrumbs.length - 1].name}
                </span>
              </>
            )}
          </nav>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Filtro rápido — Finder/Explorer sempre têm um campo de busca na
                própria toolbar, distinto da busca global do app (ADENDO-09 §13). */}
            <div className="hidden md:flex items-center relative">
              <Search className="absolute left-2.5 w-3.5 h-3.5 text-(--text-placeholder) pointer-events-none" />
              <input
                type="text"
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                placeholder="Filtrar nesta pasta"
                className="h-7 w-[150px] focus:w-[210px] pl-7 pr-2 text-mac-caption bg-black/3 dark:bg-white/4 border border-transparent rounded-full text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:bg-(--bg-card) focus:border-teal-500/50 transition-all duration-fast"
              />
            </div>
            {/* Controle segmentado — mesmo padrão do agrupador de visualização no
                Finder (um único "pill" com divisórias), em vez de 3 ícones soltos. */}
            <div className="hidden sm:flex items-center gap-0.5 p-0.5 rounded-full bg-black/3 dark:bg-white/4">
              <button
                onClick={() => setSelectionMode((v) => !v)}
                title={selectionMode ? "Sair do modo de seleção" : "Selecionar vários"}
                aria-label="Selecionar vários"
                aria-pressed={selectionMode}
                className={`h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 flex items-center justify-center rounded-full transition-colors duration-fast ${
                  selectionMode ? "bg-(--bg-card) text-teal-500 shadow-xs" : "text-(--text-secondary) hover:text-(--text-primary)"
                }`}
              >
                <ListChecks className="w-4 h-4" />
              </button>
              <button
                onClick={toggleDensity}
                title={density === "comfortable" ? "Densidade compacta" : "Densidade confortável"}
                aria-label="Linhas compactas"
                aria-pressed={density === "compact"}
                className="h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary) transition-colors duration-fast"
              >
                {density === "comfortable" ? <Rows3 className="w-4 h-4" /> : <Rows4 className="w-4 h-4" />}
              </button>
              <button
                onClick={() => setView(viewMode === "list" ? "grid" : "list")}
                title={viewMode === "list" ? "Ver em grade" : "Ver em lista"}
                aria-label="Ver em grade"
                aria-pressed={viewMode === "grid"}
                className="h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary) transition-colors duration-fast"
              >
                {viewMode === "list" ? <LayoutGrid className="w-4 h-4" /> : <List className="w-4 h-4" />}
              </button>
            </div>
            <Button variant="secondary" size="sm" className="hidden sm:flex" onClick={() => setShowNewFolder(true)} disabled={!canWrite} title="Nova pasta (Ctrl+Shift+N)">
              <FolderPlus className="w-3.5 h-3.5" />
              Nova pasta
            </Button>

            {/* Mobile: Nova pasta / seleção / densidade colapsam num menu "..." pra sobrar espaço pro breadcrumb */}
            <div className="relative sm:hidden" ref={toolbarMenuRef}>
              <button
                onClick={() => setToolbarMenuOpen((v) => !v)}
                title="Mais ações"
                aria-label="Mais ações"
                className="h-8 w-8 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) transition-colors duration-fast"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {toolbarMenuOpen && (
                <div className="popover-tail-right absolute top-full right-0 mt-1 w-52 glass-panel glass-blur-strong rounded-(--radius-popover) shadow-dropdown py-1 z-50">
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setSelectionMode((v) => !v); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-(--text-primary) hover:bg-teal-500 hover:text-white transition-colors duration-fast"
                  >
                    <ListChecks className="w-4 h-4" />
                    {selectionMode ? "Sair da seleção" : "Selecionar vários"}
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setShowNewFolder(true); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-(--text-primary) hover:bg-teal-500 hover:text-white transition-colors duration-fast"
                  >
                    <FolderPlus className="w-4 h-4" />
                    Nova pasta
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); toggleDensity(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-(--text-primary) hover:bg-teal-500 hover:text-white transition-colors duration-fast"
                  >
                    {density === "comfortable" ? <Rows3 className="w-4 h-4" /> : <Rows4 className="w-4 h-4" />}
                    {density === "comfortable" ? "Densidade compacta" : "Densidade confortável"}
                  </button>
                  <button
                    onClick={() => { setToolbarMenuOpen(false); setView(viewMode === "list" ? "grid" : "list"); }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-mac-body text-(--text-primary) hover:bg-teal-500 hover:text-white transition-colors duration-fast"
                  >
                    {viewMode === "list" ? <LayoutGrid className="w-4 h-4" /> : <List className="w-4 h-4" />}
                    {viewMode === "list" ? "Ver em grade" : "Ver em lista"}
                  </button>
                </div>
              )}
            </div>

            <Button size="sm" onClick={() => setShowUpload(true)} disabled={!canWrite} aria-label="Enviar documentos">
              <Upload className="w-3.5 h-3.5" aria-hidden />
              <span className="hidden sm:inline">Enviar</span>
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
            // Abaixo de 200ms não mostra nada (regra dos 200ms) — só depois
            // disso o skeleton aparece, já na forma exata do que vai substituir.
            showSkeleton ? (
              viewMode === "grid" ? (
                <div className="p-4 grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1">
                  {Array.from({ length: 12 }).map((_, i) => <SkeletonGridItem key={i} />)}
                </div>
              ) : (
                <table className={`w-full table-auto sm:table-fixed select-none ${density === "compact" ? "[&_td]:py-1!" : "[&_td]:py-1.5!"}`}>
                  <tbody>
                    {Array.from({ length: 8 }).map((_, i) => (
                      <SkeletonTableRow
                        key={i}
                        selectionMode={selectionMode}
                        customFieldCount={resolvedFields.length}
                        compact={density === "compact"}
                      />
                    ))}
                  </tbody>
                </table>
              )
            ) : null
          ) : loadError ? (
            <div className="flex items-center justify-center h-full px-6">
              <div role="alert" className="reveal flex max-w-sm flex-col items-center text-center gap-2">
                <div className="w-11 h-11 rounded-full bg-amber-500/12 flex items-center justify-center">
                  <AlertTriangle className="w-5 h-5 text-(--text-warning)" aria-hidden />
                </div>
                <p className="text-mac-callout font-semibold text-(--text-primary)">Não foi possível abrir esta pasta.</p>
                <p className="text-mac-body text-(--text-secondary)">{loadError} Os documentos continuam guardados.</p>
                <Button variant="secondary" className="mt-1" onClick={load}>
                  <RefreshCw className="w-3.5 h-3.5" aria-hidden /> Tentar de novo
                </Button>
              </div>
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
                  title={currentFolderId ? "Pasta vazia" : "Nenhuma pasta ainda"}
                  description={
                    currentFolderId
                      ? canWrite ? "Arraste arquivos para cá, envie pelo botão ou crie subpastas." : "Ainda não há documentos aqui."
                      : canWrite ? "Os documentos ficam dentro de pastas. Crie a primeira, por exemplo Fiscal ou RH." : "Você ainda não tem pastas nesta empresa."
                  }
                  icon={<FolderOpen className="w-6 h-6" />}
                  action={canWrite ? (
                    <div className="flex flex-wrap justify-center gap-2">
                      {currentFolderId && (
                        <Button size="sm" onClick={() => setShowUpload(true)}>
                          <Upload className="w-3.5 h-3.5" aria-hidden /> Enviar documentos
                        </Button>
                      )}
                      <Button size="sm" variant={currentFolderId ? "secondary" : "primary"} onClick={() => setShowNewFolder(true)}>
                        <FolderPlus className="w-3.5 h-3.5" aria-hidden /> {currentFolderId ? "Nova subpasta" : "Criar pasta"}
                      </Button>
                    </div>
                  ) : undefined}
                />
              )}
            </div>
          ) : viewMode === "grid" ? (
            <div role="listbox" aria-multiselectable="true" aria-label={`Conteúdo de ${breadcrumbs[breadcrumbs.length - 1].name}`} className="p-4 grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1">
              {items.map((item) => {
                if (item.kind === "folder") {
                  const f = item.data;
                  const isDropTarget = dragOverFolderId === f.id;
                  return (
                    <div
                      key={`folder-${f.id}`}
                      ref={(el) => { if (el) rowRefs.current.set(f.id, el); else rowRefs.current.delete(f.id); }}
                      role="option"
                      aria-selected={false}
                      aria-label={`Pasta ${f.name}`}
                      tabIndex={focusedId === f.id || (!focusedId && items[0]?.data.id === f.id) ? 0 : -1}
                      onFocus={() => setFocusedId(f.id)}
                      className={`group relative flex flex-col items-center gap-1.5 py-3 px-2 rounded-(--radius-control) cursor-pointer transition-colors duration-fast hover:bg-(--bg-hover) outline-none focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${
                        isDropTarget ? "bg-teal-500/10 outline-solid outline-2 outline-teal-400 -outline-offset-2" : ""
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
                      <button
                        onClick={(e) => { e.stopPropagation(); openMenuAt(e.currentTarget, "folder", f); }}
                        aria-label={`Ações da pasta ${f.name}`}
                        aria-haspopup="menu"
                        className="absolute top-1 right-1 flex sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) transition-all duration-fast z-10"
                      >
                        <MoreHorizontal className="w-4 h-4" aria-hidden />
                      </button>
                      <Folder className="w-10 h-10 text-teal-500 fill-teal-500/20 shrink-0" />
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
                          className="w-full h-6 px-1 text-mac-caption text-center bg-(--bg-page) border border-teal-500 rounded-badge text-(--text-primary) focus:outline-hidden"
                        />
                      ) : (
                        <span className="text-mac-caption text-(--text-primary) text-center leading-tight w-full line-clamp-2">{f.name}</span>
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
                    role="option"
                    aria-selected={isSelected}
                    aria-label={d.name}
                    tabIndex={focusedId === d.id || (!focusedId && items[0]?.data.id === d.id) ? 0 : -1}
                    onFocus={() => setFocusedId(d.id)}
                    className={`group relative flex flex-col items-center gap-1.5 py-3 px-2 rounded-(--radius-control) cursor-pointer transition-colors duration-fast outline-none focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${
                      isSelected ? "bg-teal-600" : "hover:bg-(--bg-hover)"
                    } ${isDragging ? "opacity-40" : ""}`}
                    onClick={(e) => selectDocClick(e, d.id)}
                    onDoubleClick={() => setPreviewDoc(d)}
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
                      onClick={(e) => { e.stopPropagation(); openMenuAt(e.currentTarget, "document", d); }}
                      aria-label={`Ações de ${d.name}`}
                      aria-haspopup="menu"
                      className={`absolute top-1 right-1 flex sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 items-center justify-center rounded-full transition-all duration-fast z-10 ${isSelected ? "text-white hover:bg-white/20" : "text-(--text-secondary) hover:bg-(--bg-hover)"}`}
                    >
                      <MoreHorizontal className="w-4 h-4" aria-hidden />
                    </button>
                    <div className={`w-10 h-10 rounded-[6px] flex items-center justify-center shrink-0 ${isSelected ? "bg-white/20" : s.bgColor}`}>
                      <Icon className={`w-5 h-5 ${isSelected ? "text-white" : `${s.iconColor} ${s.fillColor}`}`} aria-hidden />
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
                          className="w-full min-w-0 h-6 px-1 text-mac-caption text-center bg-(--bg-page) border border-teal-500 rounded-badge text-(--text-primary) focus:outline-hidden"
                        />
                        <span className="text-mac-caption text-(--text-tertiary) shrink-0">{splitExt(d.name)[1]}</span>
                      </div>
                    ) : (
                      <span className={`text-mac-caption text-center leading-tight w-full line-clamp-2 break-words [hyphens:none] ${isSelected ? "text-white" : "text-(--text-primary)"}`} title={d.name}>{d.name}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            // overflow-x-auto: com colunas redimensionáveis (table-fixed) a soma das
            // larguras pode passar do viewport no mobile — rola em vez de cortar/quebrar.
            <div className="overflow-x-auto">
            <table
              role="grid"
              aria-label={`Conteúdo de ${breadcrumbs[breadcrumbs.length - 1].name}`}
              aria-multiselectable="true"
              aria-rowcount={folders.length + total + 1}
              className={`w-full table-auto sm:table-fixed select-none ${density === "compact" ? "[&_td]:py-1!" : "[&_td]:py-1.5!"}`}
            >
              <colgroup>
                {selectionMode && <col style={{ width: 40 }} />}
                <col style={{ width: colWidths.name }} />
                <col className="hidden sm:table-column" style={{ width: colWidths.created }} />
                <col className="hidden sm:table-column" style={{ width: colWidths.size }} />
                <col className="hidden lg:table-column" style={{ width: colWidths.kind }} />
                <col className="hidden sm:table-column" style={{ width: colWidths.ocr }} />
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
              <thead className="sticky top-0 bg-(--glass-panel-bg) backdrop-blur-xl border-b border-(--border-default)">
                <tr>
                  {selectionMode && (
                    <th className="w-10 px-4 py-2 text-left">
                      <Checkbox
                        checked={selected.size === visibleDocuments.length && visibleDocuments.length > 0}
                        onChange={selectAll}
                        aria-label="Selecionar todos os documentos visíveis"
                      />
                    </th>
                  )}
                  <SortableHeader
                    label="Nome" sortKey="name" sort={sort} onSort={toggleSort}
                    onResizeStart={(e) => startColResize("name", e)}
                    onResizeReset={() => resetColWidth("name")}
                  />
                  {/* Ordem das colunas (regra da pesquisa): nome/tipo/data primeiro — o que
                      identifica o arquivo — badges de status (OCR, e futuramente
                      retenção/compartilhamento) sempre por último, nunca bloqueando o nome. */}
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
                  <th className="relative px-3 py-2 text-mac-caption font-normal text-(--text-secondary) text-left hidden lg:table-cell">
                    Tipo
                    <div
                      onMouseDown={(e) => startColResize("kind", e)}
                      onDoubleClick={() => resetColWidth("kind")}
                      className="absolute top-0 right-0 h-full w-2 cursor-col-resize select-none hover:bg-teal-400/40 active:bg-teal-400/60"
                    />
                  </th>
                  <th className="relative px-3 py-2 text-mac-caption font-normal text-(--text-secondary) text-left hidden sm:table-cell">
                    OCR
                    <div
                      onMouseDown={(e) => startColResize("ocr", e)}
                      onDoubleClick={() => resetColWidth("ocr")}
                      className="absolute top-0 right-0 h-full w-2 cursor-col-resize select-none hover:bg-teal-400/40 active:bg-teal-400/60"
                    />
                  </th>
                  {resolvedFields.map((f) => (
                    <th key={f.custom_field_id} className="px-3 py-2 text-mac-caption font-normal text-(--text-secondary) text-left truncate hidden sm:table-cell">
                      {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
                    </th>
                  ))}
                  <th className="w-[76px]"><span className="sr-only">Ações</span></th>
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
                        ref={(el) => { if (el) rowRefs.current.set(f.id, el); else rowRefs.current.delete(f.id); }}
                        tabIndex={focusedId === f.id || (!focusedId && items[0]?.data.id === f.id) ? 0 : -1}
                        aria-label={`Pasta ${f.name}`}
                        onFocus={() => setFocusedId(f.id)}
                        className={`border-b border-(--border-default) odd:bg-black/4 dark:odd:bg-white/[0.035] hover:bg-(--bg-hover) transition-colors duration-fast group outline-none focus-visible:bg-teal-500/12 focus-visible:shadow-[inset_3px_0_0_var(--focus-ring)] ${
                          isDropTarget ? "bg-teal-500/10 outline-solid outline-2 outline-teal-400 -outline-offset-2" : ""
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
                              className="w-full max-w-[280px] h-7 px-2 text-mac-body bg-(--bg-page) border border-teal-500 rounded-[6px] text-(--text-primary) focus:outline-hidden"
                            />
                          ) : (
                            <div className="flex items-center gap-1">
                              {/* Triângulo de disclosure — expande a subpasta inline sem
                                  navegar pra dentro dela, igual Finder/Explorer em lista. */}
                              <button
                                onClick={(e) => toggleExpandFolder(e, f.id)}
                                className="p-0.5 -ml-1 rounded text-(--text-tertiary) hover:text-(--text-primary) shrink-0"
                                title={expanded ? "Recolher" : "Expandir"}
                                aria-label={`${expanded ? "Recolher" : "Expandir"} ${f.name}`}
                                aria-expanded={!!expanded}
                              >
                                <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-fast ${expanded ? "rotate-90" : ""}`} />
                              </button>
                              <button
                                onClick={() => openFolder(f)}
                                className="flex items-center gap-2 text-mac-body text-(--text-primary) hover:text-teal-500 transition-colors duration-fast min-w-0"
                              >
                                <Folder className="w-4 h-4 text-teal-500 fill-teal-500/20 shrink-0" />
                                <span className="truncate">{f.name}</span>
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) hidden sm:table-cell">—</td>
                        <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) text-right hidden sm:table-cell">—</td>
                        <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) hidden lg:table-cell">Pasta</td>
                        <td className="px-3 py-2 hidden sm:table-cell" />
                        {resolvedFields.map((rf) => (
                          <td key={rf.custom_field_id} className="px-3 py-2 text-mac-caption text-(--text-tertiary) hidden sm:table-cell">—</td>
                        ))}
                        <td className="px-2 py-2 text-right">
                          <button
                            onClick={(e) => { e.stopPropagation(); openMenuAt(e.currentTarget, "folder", f); }}
                            aria-label={`Ações da pasta ${f.name}`}
                            aria-haspopup="menu"
                            className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 w-7 h-7 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover) transition-all duration-fast"
                          >
                            <MoreHorizontal className="w-4 h-4" aria-hidden />
                          </button>
                        </td>
                      </tr>
                      {expanded === "loading" && (
                        <tr className="border-b border-(--border-default)">
                          <td colSpan={nestedColSpan} className="px-3 py-2 pl-10 text-mac-caption text-(--text-tertiary)">Carregando…</td>
                        </tr>
                      )}
                      {expanded && expanded !== "loading" && expanded.folders.length === 0 && expanded.documents.length === 0 && (
                        <tr className="border-b border-(--border-default)">
                          <td colSpan={nestedColSpan} className="px-3 py-2 pl-10 text-mac-caption text-(--text-placeholder) italic">Pasta vazia</td>
                        </tr>
                      )}
                      {expanded && expanded !== "loading" && expanded.folders.map((nf) => (
                        <tr
                          key={`nested-folder-${nf.id}`}
                          className="border-b border-(--border-default) odd:bg-black/4 dark:odd:bg-white/[0.035] hover:bg-(--bg-hover) transition-colors duration-fast cursor-pointer"
                          onClick={() => openFolder(nf)}
                        >
                          {selectionMode && <td className="px-4 py-2" />}
                          <td className="px-3 py-2 pl-10">
                            <div className="flex items-center gap-2 text-mac-body text-(--text-secondary)">
                              <Folder className="w-3.5 h-3.5 text-teal-500/70 fill-teal-500/15 shrink-0" />
                              <span className="truncate">{nf.name}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) hidden sm:table-cell">—</td>
                          <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) text-right hidden sm:table-cell">—</td>
                          <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) hidden lg:table-cell">Pasta</td>
                          <td className="px-3 py-2 hidden sm:table-cell" />
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
                            className="border-b border-(--border-default) odd:bg-black/4 dark:odd:bg-white/[0.035] hover:bg-(--bg-hover) transition-colors duration-fast cursor-pointer"
                            onClick={() => setDetailDoc(nd)}
                          >
                            {selectionMode && <td className="px-4 py-2" />}
                            <td className="px-3 py-2 pl-10">
                              <div className="flex items-center gap-2 text-mac-body text-(--text-secondary) min-w-0">
                                <NIcon className={`w-3.5 h-3.5 shrink-0 ${ns.iconColor} ${ns.fillColor} opacity-70`} />
                                <span className="truncate">{nd.name}</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) hidden sm:table-cell">{fmtDate(nd.created_at)}</td>
                            <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) text-right hidden sm:table-cell">{fmtSize(nd.size_bytes)}</td>
                            <td className="px-3 py-2 text-mac-caption text-(--text-tertiary) hidden lg:table-cell">{kindLabel(nd.name)}</td>
                            <td className="px-3 py-2 hidden sm:table-cell"><OcrIcon status={nd.ocr_status} /></td>
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
                      tabIndex={focusedId === d.id || (!focusedId && items[0]?.data.id === d.id) ? 0 : -1}
                      aria-selected={isSelected}
                      onFocus={() => setFocusedId(d.id)}
                      className={`border-b border-(--border-default) transition-colors duration-fast group cursor-pointer outline-none focus-visible:shadow-[inset_3px_0_0_var(--focus-ring)] ${
                        isSelected ? "bg-teal-600" : "odd:bg-black/4 dark:odd:bg-white/[0.035] hover:bg-(--bg-hover) focus-visible:bg-teal-500/12"
                      } ${isDragging ? "opacity-40" : ""}`}
                      onClick={(e) => selectDocClick(e, d.id)}
                      onDoubleClick={() => setPreviewDoc(d)}
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
                          <Checkbox checked={isSelected} onChange={() => toggleSelect(d.id)} aria-label={`Selecionar ${d.name}`} />
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {(() => { const s = getFileStyle(d.name); const Icon = s.icon; return (
                            <div className={`w-6 h-6 rounded-badge flex items-center justify-center shrink-0 ${isSelected ? "bg-white/20" : s.bgColor}`}>
                              <Icon className={`w-3.5 h-3.5 ${isSelected ? "text-white" : `${s.iconColor} ${s.fillColor}`}`} aria-hidden />
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
                                className="h-7 px-2 text-mac-body bg-(--bg-card) border border-teal-500 rounded-[6px] text-(--text-primary) focus:outline-hidden flex-1 min-w-0"
                              />
                              <span className="text-mac-body text-(--text-tertiary) shrink-0">{splitExt(d.name)[1]}</span>
                            </div>
                          ) : (
                            <div className="min-w-0 flex-1">
                              <TruncatedFileName
                                name={d.name}
                                className={`text-mac-body ${isSelected ? "text-white" : "text-(--text-primary)"}`}
                                inverted={isSelected}
                              />
                              {/* Celular: data, tamanho e situação do texto sob o nome (A4-17). */}
                              <span className={`sm:hidden block text-mac-caption truncate ${isSelected ? "text-white/85" : "text-(--text-secondary)"}`}>
                                {fmtDate(d.created_at)} · {fmtSize(d.size_bytes)}{d.ocr_status === "failed" ? " · texto não lido" : ""}
                              </span>
                            </div>
                          )}
                        </div>
                      </td>
                      <td className={`px-3 py-2 text-mac-caption hidden sm:table-cell ${isSelected ? "text-white/90" : "text-(--text-secondary)"}`} title={d.uploaded_by_name ? `Enviado por ${d.uploaded_by_name}` : undefined}>{fmtDate(d.created_at)}</td>
                      <td className={`px-3 py-2 text-mac-caption text-right tabular-nums hidden sm:table-cell ${isSelected ? "text-white/90" : "text-(--text-secondary)"}`}>{fmtSize(d.size_bytes)}</td>
                      <td className={`px-3 py-2 text-mac-caption hidden lg:table-cell ${isSelected ? "text-white/90" : "text-(--text-secondary)"}`}>{kindLabel(d.name)}</td>
                      <td className="px-3 py-2 hidden sm:table-cell"><OcrIcon status={d.ocr_status} inverted={isSelected} /></td>
                      {resolvedFields.map((rf) => {
                        const value = fieldValues[d.id]?.[rf.custom_field_id];
                        return (
                          <td key={rf.custom_field_id} className="px-3 py-2 text-mac-caption truncate hidden sm:table-cell">
                            {value ? (
                              <span className={isSelected ? "text-white/90" : "text-(--text-secondary)"}>{value}</span>
                            ) : rf.required ? (
                              <span className={isSelected ? "text-white" : "text-amber-600 dark:text-amber-400"} title="Campo obrigatório sem preenchimento">Pendente</span>
                            ) : (
                              <span className={isSelected ? "text-white/60" : "text-(--text-placeholder)"}>—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="px-2 py-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); openMenuAt(e.currentTarget, "document", d); }}
                          aria-label={`Ações de ${d.name}`}
                          aria-haspopup="menu"
                          className={`opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 w-7 h-7 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-full transition-all duration-fast ${
                            isSelected ? "text-white hover:bg-white/20" : "text-(--text-secondary) hover:bg-(--bg-hover)"
                          }`}
                        >
                          <MoreHorizontal className="w-4 h-4" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          )}
          {!loading && !loadError && documents.length < total && (
            <div ref={sentinelRef} className="flex items-center justify-center gap-3 py-4 text-mac-caption text-(--text-secondary)">
              {loadingMore ? "Carregando mais documentos…" : `Mostrando ${documents.length.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")}`}
              {!loadingMore && <Button size="sm" variant="secondary" onClick={loadMore}>Carregar mais</Button>}
            </div>
          )}
          {dragBox && (
            <div
              className="absolute border border-teal-500 bg-teal-500/10 pointer-events-none z-20 rounded-[4px]"
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
        <div className="hidden sm:flex items-center justify-between gap-3 px-4 sm:px-6 h-8 border-t border-(--border-default) shrink-0 text-mac-caption text-(--text-tertiary)">
          <nav className="flex items-center gap-1 min-w-0 overflow-x-auto">
            {breadcrumbs.map((crumb, idx) => (
              <span key={idx} className="flex items-center gap-1 shrink-0">
                {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-(--text-tertiary)" />}
                <button
                  onClick={() => navigateBreadcrumb(idx)}
                  className={`text-mac-caption hover:text-teal-500 transition-colors duration-fast ${
                    idx === breadcrumbs.length - 1
                      ? "text-(--text-primary) font-medium"
                      : "text-(--text-secondary)"
                  }`}
                >
                  {idx === 0 ? <Home className="w-3.5 h-3.5" /> : crumb.name}
                </button>
              </span>
            ))}
          </nav>
          <span className="shrink-0">
            {loading ? (
              "Carregando…"
            ) : loadError ? (
              "Não carregou"
            ) : selected.size > 0 ? (
              <span className="text-(--text-accent) font-medium">{selected.size} selecionado{selected.size !== 1 ? "s" : ""}</span>
            ) : sortedFolders.length === 0 && total === 0 ? (
              "Pasta vazia"
            ) : (
              <>
                {[
                  sortedFolders.length > 0 ? `${sortedFolders.length} pasta${sortedFolders.length !== 1 ? "s" : ""}` : null,
                  total > 0 ? `${total.toLocaleString("pt-BR")} documento${total !== 1 ? "s" : ""}` : null,
                ].filter(Boolean).join(", ")}
                {filterQ && ` · ${items.length} exibido${items.length !== 1 ? "s" : ""}`}
              </>
            )}
          </span>
        </div>
      </div>

      {/* Fase 8.1: painel lateral persistente no desktop (vive dentro da mesma
          janela de vidro, flex sibling da tabela — "nunca modal", consenso
          das 11 rodadas de pesquisa), modal centralizado no mobile (sem
          espaço pra split view). DetailDrawer decide a moldura sozinho a
          partir de `variant`; a posição aqui só importa pro variant="panel"
          (o "modal" é Portal-rendered, sai daqui de qualquer jeito). */}
      {detailDoc && current && (
        <DetailDrawer
          doc={detailDoc}
          companyId={current.id}
          variant={isDesktop ? "panel" : "modal"}
          path={`${current.name} › ${breadcrumbs.slice(1).map((b) => b.name).join(" › ") || "Início"}`}
          canEdit={canWrite}
          onClose={() => setDetailDoc(null)}
          onPreview={() => setPreviewDoc(detailDoc)}
          onFavorite={() => { loadSidebarFavorites(); setDocuments((prev) => prev.map((d) => (d.id === detailDoc.id ? { ...d, favorited: !d.favorited } : d))); }}
          onMenu={(el) => openMenuAt(el, "document", detailDoc)}
          onChanged={load}
          onFieldSaved={(docId, fieldId, value) => setFieldValues((prev) => ({ ...prev, [docId]: { ...(prev[docId] ?? {}), [fieldId]: value } }))}
        />
      )}

      {/* Modals */}
      {showUpload && current && (
        <UploadModal
          folderId={currentFolderId}
          folderName={breadcrumbs[breadcrumbs.length - 1].name}
          companyId={current.id}
          onClose={() => setShowUpload(false)}
          onDone={load}
        />
      )}
      {showNewFolder && current && (
        <CreateFolderModal
          parentId={currentFolderId}
          parentName={breadcrumbs[breadcrumbs.length - 1].name}
          siblings={folders.map((f) => f.name)}
          companyId={current.id}
          onClose={() => setShowNewFolder(false)}
          onDone={(folder) => {
            setFolders((prev) => [...prev, folder]);
            setFolderTreeVersion((v) => v + 1);
            window.setTimeout(() => { setFocusedId(folder.id); rowRefs.current.get(folder.id)?.focus(); }, 50);
          }}
        />
      )}
      {confirmDeleteFolder && (
        <ConfirmModal
          title={`Excluir a pasta "${confirmDeleteFolder.name}"?`}
          description={
            folderDeleteSummary
              ? folderDeleteSummary.subfolders + folderDeleteSummary.documents === 0
                ? "A pasta está vazia. Ela vai para a lixeira e pode ser restaurada de lá."
                : `Vão para a lixeira junto: ${[
                    folderDeleteSummary.subfolders ? plural(folderDeleteSummary.subfolders, "subpasta", "subpastas") : null,
                    folderDeleteSummary.documents ? plural(folderDeleteSummary.documents, "documento", "documentos") : null,
                  ].filter(Boolean).join(" e ")}. Dá para desfazer logo em seguida ou restaurar tudo pela Lixeira.`
              : "A pasta e tudo o que está nela vão para a lixeira. Dá para desfazer logo em seguida ou restaurar tudo pela Lixeira."
          }
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
      {showTreeDrawer && current && (
        <Dialog onClose={() => setShowTreeDrawer(false)} title="Pastas" size="sm" bodyClassName="px-2 py-2">
          <button
            onClick={() => { navigateHome(); setShowTreeDrawer(false); }}
            className={`w-full flex items-center gap-1.5 h-9 pointer-coarse:h-11 pl-3 pr-2 text-mac-body rounded-[6px] text-left ${currentFolderId === null ? "bg-teal-500/12 text-(--text-accent) font-medium" : "text-(--text-primary) hover:bg-(--bg-hover)"}`}
          >
            <Home className="w-4 h-4 shrink-0" aria-hidden /> Início
          </button>
          <FolderTree
            version={folderTreeVersion}
            companyId={current.id}
            activeFolderId={currentFolderId}
            onSelect={(f) => { jumpToFolder(f.id); setShowTreeDrawer(false); }}
            onDropDocuments={(folderId, documentIds, folderName) => moveDocuments(documentIds, folderId, folderName)}
            onMove={onTreeMove}
          />
        </Dialog>
      )}
      {sharingDoc && (
        <ShareModal resourceType="document" resourceId={sharingDoc.id} name={sharingDoc.name} onClose={() => setSharingDoc(null)} />
      )}
      {picker && current && (
        picker.kind === "documents" ? (
          <FolderPickerDialog
            companyId={current.id}
            title={`Mover ${plural(picker.ids.length, "documento", "documentos")} para…`}
            confirmLabel="Mover aqui"
            disabledIds={currentFolderId ? [currentFolderId] : []}
            initialId={currentFolderId}
            onPick={async (f) => { setPicker(null); if (f.id) await moveDocuments(picker.ids, f.id, f.name); }}
            onClose={() => setPicker(null)}
          />
        ) : (
          <FolderPickerDialog
            companyId={current.id}
            title={`Mover a pasta "${picker.folder.name}" para…`}
            confirmLabel="Mover aqui"
            allowRoot
            excludeSubtreeOf={[picker.folder.id]}
            disabledIds={picker.folder.parent_id ? [picker.folder.parent_id] : []}
            onPick={async (f) => { const folder = picker.folder; setPicker(null); await moveFolder(folder, f); }}
            onClose={() => setPicker(null)}
          />
        )
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
          docs={visibleDocuments.some((d) => d.id === previewDoc.id) ? visibleDocuments : undefined}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {menu && (
        <Menu
          label={menu.kind === "document" ? `Ações de ${menu.data.name}` : `Ações da pasta ${menu.data.name}`}
          anchor={menu.anchor}
          align="end"
          items={menuItems(menu)}
          onClose={() => setMenu(null)}
        />
      )}

      {/* Anúncio da seleção para leitor de tela (achado A4-28). */}
      <div className="sr-only" aria-live="polite">{selected.size ? `${plural(selected.size, "documento selecionado", "documentos selecionados")}` : ""}</div>

      {/* Barra de ações em lote — flutuante; escondida, fica inerte (fora do Tab). */}
      <div
        role="toolbar"
        aria-label="Ações para os documentos selecionados"
        inert={selected.size === 0}
        className={`glass-panel glass-blur-pill fixed bottom-[calc(76px+env(safe-area-inset-bottom))] md:bottom-7 lg:bottom-[100px] left-1/2 flex items-center gap-1 rounded-[50px] pl-4 pr-1.5 py-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.45)] z-30 max-w-[calc(100vw-24px)] overflow-x-auto transition-[opacity,transform] duration-normal ${
          selected.size > 0 ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        style={{ transform: selected.size > 0 ? "translateX(-50%)" : "translateX(-50%) translateY(12px)" }}
      >
        <span className="text-mac-body text-(--text-primary) mr-1 whitespace-nowrap">
          <b className="text-(--text-accent) font-semibold tabular-nums">{selected.size}</b> selecionado{selected.size !== 1 ? "s" : ""}
        </span>
        {canWrite && (
          <button onClick={() => setPicker({ kind: "documents", ids: [...selected] })}
            className="flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-primary) whitespace-nowrap hover:bg-(--bg-hover)">
            <FolderInput className="w-3.5 h-3.5" aria-hidden /> Mover
          </button>
        )}
        <button onClick={() => downloadDocuments([...selected])}
          className="flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-primary) whitespace-nowrap hover:bg-(--bg-hover)">
          <Download className="w-3.5 h-3.5" aria-hidden /> Baixar
        </button>
        <button onClick={() => anchorDocuments([...selected])}
          className="hidden sm:flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-primary) whitespace-nowrap hover:bg-(--bg-hover)">
          <Anchor className="w-3.5 h-3.5" aria-hidden /> Ancorar
        </button>
        {resolvedFields.length > 0 && canWrite && (
          <button onClick={() => setShowBulkMetadata(true)}
            className="flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-primary) whitespace-nowrap hover:bg-(--bg-hover)">
            <Pencil className="w-3.5 h-3.5" aria-hidden /> Metadados
          </button>
        )}
        {canWrite && (
          <button onClick={deleteSelected}
            className="flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-danger) whitespace-nowrap hover:bg-red-500/12">
            <Trash2 className="w-3.5 h-3.5" aria-hidden /> Excluir
          </button>
        )}
        <button onClick={() => setSelected(new Set())} aria-label="Limpar seleção (Esc)" title="Limpar seleção (Esc)"
          className="flex items-center justify-center w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) shrink-0">
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>

      {showBulkMetadata && current && (
        <BulkMetadataModal
          documentIds={[...selected]}
          fields={resolvedFields}
          fieldValues={fieldValues}
          companyId={current.id}
          onClose={() => setShowBulkMetadata(false)}
          onSaved={load}
        />
      )}
    </div>
  );
}
