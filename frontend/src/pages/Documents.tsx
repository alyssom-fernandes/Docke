import { useEffect, useRef, useState, useCallback } from "react";
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
  X,
  MoreHorizontal,
  Home,
  Download,
  Eye,
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

// ─── Upload Modal (simplified inline) ────────────────────────────────────────

function UploadModal({ folderId, companyId, onClose, onDone }: { folderId: string | null; companyId: string; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const uploadContainerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(uploadContainerRef);

  async function upload() {
    if (!files.length) return;
    if (!folderId) {
      showError("Abra uma pasta antes de fazer upload.");
      return;
    }
    setUploading(true);
    setProgress({ done: 0, total: files.length });
    try {
      for (const file of files) {
        // Etapa 1: solicitar URL de upload pré-assinada
        const { data } = await api.post("/documents/upload-url", {
          folder_id: folderId,
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
      success(`${files.length} arquivo${files.length > 1 ? "s" : ""} enviado${files.length > 1 ? "s" : ""}.`);
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
      <div ref={uploadContainerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] shadow-modal modal-card w-full max-w-[480px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Upload de documentos</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <label className="block border-2 border-dashed border-[var(--border-default)] rounded-[8px] p-8 text-center cursor-pointer hover:border-teal-400 transition-colors duration-fast">
            <Upload className="w-8 h-8 mx-auto mb-2 text-[var(--text-placeholder)]" />
            <p className="text-sm text-[var(--text-secondary)]">
              {files.length > 0
                ? `${files.length} arquivo${files.length > 1 ? "s" : ""} selecionado${files.length > 1 ? "s" : ""}`
                : "Clique para selecionar ou arraste arquivos aqui"}
            </p>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">PDF, DOCX, XLSX, JPG, PNG — máx. 50 MB cada</p>
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.xml,.jpg,.jpeg,.png,.gif,.txt"
            />
          </label>
          {files.length > 0 && (
            <ul className="max-h-32 overflow-y-auto space-y-1">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="flex-1 truncate">{f.name}</span>
                  <span>{fmtSize(f.size)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        {!folderId && (
          <div className="mx-5 mb-1 px-3 py-2 bg-yellow-50 border border-yellow-200 rounded-[8px] text-xs text-yellow-800">
            Abra uma pasta primeiro para habilitar o upload.
          </div>
        )}
        {uploading && progress.total > 1 && (
          <div className="mx-5 mb-1 text-xs text-[var(--text-secondary)]">
            Enviando {progress.done + 1} de {progress.total}…
          </div>
        )}
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={uploading}>Cancelar</Button>
          <Button size="sm" loading={uploading} onClick={upload} disabled={!files.length || !folderId}>
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
    } catch {
      showError("Não foi possível criar a pasta.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={folderContainerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] shadow-modal modal-card w-full max-w-[360px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Nova pasta</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
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
            className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-teal-400"
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

function DetailDrawer({ doc, onClose, onFavorite, onPreview, onDelete }: { doc: Document; onClose: () => void; onFavorite: () => void; onPreview: () => void; onDelete: () => void }) {
  const { success, error: showError } = useToast();
  const [favorited, setFavorited] = useState(false);

  async function toggleFavorite() {
    try {
      if (favorited) {
        // need favorite_id — simplified: refetch
        showError("Use a lista de favoritos para remover.");
      } else {
        await api.post("/favorites", { document_id: doc.id });
        setFavorited(true);
        success(`"${doc.name}" adicionado aos favoritos.`);
        onFavorite();
      }
    } catch (e: any) {
      if (e?.response?.status === 409) { setFavorited(true); return; }
      showError("Erro ao favoritar.");
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
    <aside className="w-[320px] flex-shrink-0 h-full border-l border-[var(--border-default)] bg-[var(--bg-card)] flex flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Detalhes</h2>
        <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-5 space-y-5">
        <div className="flex items-start gap-3">
          {(() => { const s = getFileStyle(doc.name); const Icon = s.icon; return (
            <div className={`w-10 h-10 rounded-[8px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
              <Icon className={`w-5 h-5 ${s.iconColor}`} />
            </div>
          ); })()}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)] break-words">{doc.name}</p>
            <p className="text-xs text-[var(--text-secondary)] mt-0.5">{fmtSize(doc.size_bytes)}</p>
          </div>
        </div>

        <div className="space-y-2">
          <Row label="Tipo" value={doc.mime_type} />
          <Row label="Tamanho" value={fmtSize(doc.size_bytes)} />
          <Row label="Criado em" value={fmtDateFull(doc.created_at)} />
          <div className="flex justify-between py-1">
            <span className="text-xs text-[var(--text-secondary)]">OCR</span>
            {ocrBadge(doc.ocr_status)}
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2 border-t border-[var(--border-default)]">
          <button
            onClick={onPreview}
            className="w-full h-9 flex items-center justify-center gap-2 text-sm bg-teal-600 text-white rounded-[8px] hover:bg-teal-500 transition-colors duration-fast"
          >
            <Eye className="w-4 h-4" />
            Visualizar
          </button>
          <button
            onClick={download}
            className="w-full h-9 flex items-center justify-center gap-2 text-sm border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
          >
            <Download className="w-4 h-4" />
            Baixar
          </button>
          <button
            onClick={toggleFavorite}
            className={`w-full h-9 flex items-center justify-center gap-2 text-sm border rounded-[8px] transition-colors duration-fast ${
              favorited
                ? "border-teal-200 dark:border-teal-900/40 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-900/20"
                : "border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            <Anchor className={`w-4 h-4 ${favorited ? "fill-current" : ""}`} />
            {favorited ? "Remover favorito" : "Favoritar"}
          </button>
          <button
            onClick={onDelete}
            className="w-full h-9 flex items-center justify-center gap-2 text-sm border border-red-200 dark:border-red-900/40 rounded-[8px] text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors duration-fast"
          >
            <Trash2 className="w-4 h-4" />
            Excluir
          </button>
        </div>
      </div>
    </aside>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1">
      <span className="text-xs text-[var(--text-secondary)]">{label}</span>
      <span className="text-xs text-[var(--text-primary)] truncate max-w-[180px] text-right">{value}</span>
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

  const load = useCallback(() => {
    if (!current) return;
    setLoading(true);
    setSelected(new Set());

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
  }

  function navigateBreadcrumb(idx: number) {
    const crumb = breadcrumbs[idx];
    setCurrentFolderId(crumb.id);
    setBreadcrumbs((prev) => prev.slice(0, idx + 1));
    setDetailDoc(null);
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
      } catch {
        showError("Erro ao excluir documentos.");
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

  async function deleteFolder(folder: Folder) {
    setDeletingFolder(true);
    try {
      await api.delete(`/folders/${folder.id}`);
      success(`Pasta "${folder.name}" excluída.`);
      setConfirmDeleteFolder(null);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Erro ao excluir pasta.");
    } finally {
      setDeletingFolder(false);
    }
  }

  const items: Item[] = [
    ...folders.map((f): Item => ({ kind: "folder", data: f })),
    ...documents.map((d): Item => ({ kind: "document", data: d })),
  ];

  return (
    <div className="flex h-full -m-6">
      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-[var(--border-default)] flex-shrink-0 bg-[var(--bg-card)]">
          {/* Breadcrumbs */}
          <nav className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
            {breadcrumbs.map((crumb, idx) => (
              <span key={idx} className="flex items-center gap-1 flex-shrink-0">
                {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />}
                <button
                  onClick={() => navigateBreadcrumb(idx)}
                  className={`text-sm hover:text-teal-600 transition-colors duration-fast ${
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

          {/* Actions */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {selected.size > 0 && (
              <button
                onClick={deleteSelected}
                className="flex items-center gap-1.5 h-8 px-3 text-xs text-red-600 border border-red-200 dark:border-red-900/40 rounded-[8px] hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors duration-fast"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Excluir {selected.size}
              </button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setShowNewFolder(true)}>
              <FolderPlus className="w-3.5 h-3.5" />
              Nova pasta
            </Button>
            <Button size="sm" onClick={() => setShowUpload(true)}>
              <Upload className="w-3.5 h-3.5" />
              Upload
            </Button>
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="p-6 space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-11 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] animate-pulse" />
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
          ) : (
            <table className="w-full">
              <thead className="sticky top-0 bg-[var(--bg-page)] border-b border-[var(--border-default)]">
                <tr>
                  <th className="w-10 px-4 py-2 text-left">
                    <input
                      type="checkbox"
                      checked={selected.size === documents.length && documents.length > 0}
                      onChange={selectAll}
                      className="accent-teal-600 w-4 h-4"
                    />
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-[var(--text-secondary)] text-left">Nome</th>
                  <th className="px-3 py-2 text-xs font-medium text-[var(--text-secondary)] text-left w-[100px]">Tamanho</th>
                  <th className="px-3 py-2 text-xs font-medium text-[var(--text-secondary)] text-left w-[120px]">Status OCR</th>
                  <th className="px-3 py-2 text-xs font-medium text-[var(--text-secondary)] text-left w-[110px]">Criado em</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  if (item.kind === "folder") {
                    const f = item.data;
                    return (
                      <tr
                        key={`folder-${f.id}`}
                        className="border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors duration-fast group"
                        onDoubleClick={() => openFolder(f)}
                      >
                        <td className="px-4 py-2.5" />
                        <td className="px-3 py-2.5">
                          <button
                            onClick={() => openFolder(f)}
                            className="flex items-center gap-2 text-sm text-[var(--text-primary)] hover:text-teal-600 transition-colors duration-fast"
                          >
                            <FolderOpen className="w-4 h-4 text-teal-500 flex-shrink-0" />
                            {f.name}
                          </button>
                        </td>
                        <td className="px-3 py-2.5 text-xs text-[var(--text-tertiary)]">—</td>
                        <td className="px-3 py-2.5" />
                        <td className="px-3 py-2.5 text-xs text-[var(--text-tertiary)]">—</td>
                        <td className="px-2 py-2.5">
                          <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDeleteFolder(f); }}
                            className="opacity-0 group-hover:opacity-100 p-1.5 rounded-[6px] text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-fast"
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
                  return (
                    <tr
                      key={`doc-${d.id}`}
                      className={`border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors duration-fast group cursor-pointer ${
                        isSelected ? "bg-teal-50 dark:bg-teal-900/20" : ""
                      }`}
                      onClick={() => setDetailDoc(d)}
                    >
                      <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(d.id)}
                          className="accent-teal-600 w-4 h-4"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          {(() => { const s = getFileStyle(d.name); const Icon = s.icon; return (
                            <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                              <Icon className={`w-3.5 h-3.5 ${s.iconColor}`} />
                            </div>
                          ); })()}
                          <TruncatedFileName name={d.name} className="text-sm text-[var(--text-primary)]" />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-xs text-[var(--text-tertiary)]">{fmtSize(d.size_bytes)}</td>
                      <td className="px-3 py-2.5">{ocrBadge(d.ocr_status)}</td>
                      <td className="px-3 py-2.5 text-xs text-[var(--text-tertiary)]">{fmtDate(d.created_at)}</td>
                      <td className="px-2 py-2.5">
                        <button
                          onClick={(e) => { e.stopPropagation(); setDetailDoc(d); }}
                          className="opacity-0 group-hover:opacity-100 p-1.5 rounded-[6px] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] transition-all duration-fast"
                        >
                          <MoreHorizontal className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
          onDone={load}
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
      {previewDoc && (
        <PreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
        />
      )}
    </div>
  );
}
