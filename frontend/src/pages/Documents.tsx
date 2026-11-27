import { Fragment, useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { getFileStyle } from "@/lib/fileType";
import {
  Folder,
  FolderOpen,
  FolderPlus,
  ShieldAlert,
  Upload,
  Trash2,
  Anchor,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  X,
  MoreHorizontal,
  Home,
  Download,
  Eye,
  Share2,
  Rows3,
  Rows4,
  AlertCircle,
  ListChecks,
  LayoutGrid,
  List,
  Pencil,
  Info,
  Search,
  Copy,
  Shield,
  Tags,
  Archive,
  FolderInput,
  Link2,
  RefreshCw,
  AlertTriangle,
  Inbox,
  LayoutTemplate,
  FilePlus,
} from "lucide-react";
import api from "@/lib/api";
import { useCompany, useFeatures } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { useNavigation } from "@/lib/NavigationContext";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import EmptyState from "@/components/shared/EmptyState";
import TruncatedFileName from "@/components/ui/TruncatedFileName";
import ConfirmModal from "@/components/ui/ConfirmModal";
import PreviewModal from "@/components/documents/PreviewModal";
import ShareModal from "@/components/documents/ShareModal";
import RequestFilesModal from "@/components/documents/RequestFilesModal";
import { RequestAccessBanner } from "@/components/shared/AccessRequests";
import CopyStructureModal from "@/components/documents/CopyStructureModal";
import { SaveTemplateDialog, ApplyTemplateDialog, NewFromTemplateDialog } from "@/components/documents/Templates";
import InboxPanel from "@/components/documents/InboxPanel";
import FolderTree from "@/components/documents/FolderTree";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import Menu, { type MenuItem } from "@/components/ui/Menu";
import FolderPickerDialog, { type PickedFolder } from "@/components/documents/FolderPickerDialog";
import { pushUndo, useUndo } from "@/lib/undo";
import { SkeletonTableRow, SkeletonGridItem } from "@/components/shared/Skeleton";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { prefetchPdfViewer } from "@/lib/prefetch";
import PrivacyDialog, { PRIVACY_LABEL } from "@/components/documents/PrivacyDialog";
import { friendlyError } from "@/lib/errors";
import {
  type Document,
  type ResolvedField,
  type DocFieldValueRow,
  type Item,
  fmtSize,
  fmtDate,
  FORBIDDEN_NAME_CHARS,
  chunks,
  plural,
  splitExt,
  kindLabel,
  OcrIcon,
  GridThumb,
} from "@/components/documents/docShared";
import { UploadModal } from "@/components/documents/UploadModal";
import { CreateFolderModal } from "@/components/documents/CreateFolderModal";
import { DetailDrawer } from "@/components/documents/DetailDrawer";
import { PageHeader, ToolbarGroup, ToolbarButton, ToolbarSearchField } from "@/components/layout/window";
import { MacFolderIcon } from "@/components/ui/MacIcons";
import { BulkMetadataModal } from "@/components/documents/BulkMetadataModal";
import type { DocFolder } from "@/components/documents/docShared";

export type { CustomFieldType, ResolvedField } from "@/components/documents/docShared";

// Tipos comuns (pasta e documento) vivem em docShared (A4-63).
type Folder = DocFolder;

type SortKey = "name" | "size" | "created_at" | "updated_at" | "kind" | "ocr" | "uploader" | `field:${string}`;

/** Vista salva da pasta (B1.2.7): ordenação, colunas, agrupamento e filtro por metadado. */
interface SavedView { id: string; name: string; folder_id: string | null; mine: boolean; shared: boolean; config: { sort?: { key: SortKey; dir: "asc" | "desc" }; cols?: string[]; groupBy?: string; fieldFilter?: { id: string; label: string; value: string } | null; view?: "list" | "grid" } }
const SEM_VALOR = "Sem valor";

// Colunas opcionais da lista (A4-16): a pessoa escolhe quais ver (clique
// direito no cabeçalho ou no botão de visualização); todas ordenam.
type OptCol = "created" | "updated" | "uploader" | "size" | "kind" | "ocr";
// colCls por extenso: o Tailwind só gera classes que aparecem literalmente no
// código. Antes a classe da <col> era montada trocando "table-cell" por
// "table-column", e md:/lg:table-column nunca existiam: as colunas "Enviado
// por" e "Tipo" ficavam sem largura e as seguintes se deslocavam (cortando
// "Tamanho" e deixando o OCR com a sobra).
const OPT_COLS: { key: OptCol; label: string; menu: string; sortKey: SortKey; align?: "right"; cls: string; colCls: string }[] = [
  { key: "created", label: "Criado em", menu: "Criado em", sortKey: "created_at", cls: "hidden sm:table-cell", colCls: "hidden sm:table-column" },
  { key: "updated", label: "Modificado em", menu: "Modificado em", sortKey: "updated_at", cls: "hidden sm:table-cell", colCls: "hidden sm:table-column" },
  { key: "uploader", label: "Enviado por", menu: "Enviado por", sortKey: "uploader", cls: "hidden md:table-cell", colCls: "hidden md:table-column" },
  { key: "size", label: "Tamanho", menu: "Tamanho", sortKey: "size", align: "right", cls: "hidden sm:table-cell", colCls: "hidden sm:table-column" },
  { key: "kind", label: "Tipo", menu: "Tipo", sortKey: "kind", cls: "hidden lg:table-cell", colCls: "hidden lg:table-column" },
  { key: "ocr", label: "OCR", menu: "Texto lido (OCR)", sortKey: "ocr", cls: "hidden sm:table-cell", colCls: "hidden sm:table-column" },
];
const DEFAULT_VISIBLE_COLS: OptCol[] = ["created", "size", "kind", "ocr"];
const OCR_ORDER: Record<string, number> = { failed: 0, pending: 1, processing: 2, skipped: 3, done: 4 };
type Density = "compact" | "comfortable" | "spacious";
const DENSITY_PAD: Record<Density, string> = { compact: "[&_td]:py-px!", comfortable: "[&_td]:py-[3px]!", spacious: "[&_td]:py-1.5!" };

// ─── Preferência de view/sort por pasta ─────────────────────────────────────
// Finder/Explorer lembram como cada pasta foi deixada (ordenação, modo de
// visualização) em vez de aplicar uma preferência global — ADENDO-09 §13.3.7.

interface FolderPref {
  sort: { key: SortKey; dir: "asc" | "desc" };
  view: "list" | "grid";
}

const DEFAULT_FOLDER_PREF: FolderPref = { sort: { key: "name", dir: "asc" }, view: "list" };
const FOLDER_PREFS_STORAGE_KEY = "docke_folder_prefs";

/** Lê e limpa os arquivos que o service worker guardou ao receber um "Compartilhar" (B4.5.7). */
async function lerCompartilhados(): Promise<File[]> {
  if (!("caches" in window)) return [];
  try {
    const cache = await caches.open("docke-compartilhado");
    const files: File[] = [];
    for (const req of await cache.keys()) {
      const r = await cache.match(req);
      if (r) {
        const nome = decodeURIComponent(r.headers.get("X-Nome") ?? "arquivo");
        files.push(new File([await r.blob()], nome, { type: r.headers.get("Content-Type") ?? "" }));
      }
      await cache.delete(req);
    }
    return files;
  } catch {
    return [];
  }
}

/** Salvar a vista atual (B1.2.7): nome, onde vale e com quem fica. */
function SaveViewDialog({ folderName, onClose, onSave }: { folderName: string; onClose: () => void; onSave: (name: string, scope: "pasta" | "todas", shared: boolean) => Promise<void> }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"pasta" | "todas">("pasta");
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog onClose={onClose} size="sm" busy={busy} title="Salvar vista"
      description="Guarda a ordenação, as colunas, o agrupamento e o filtro por metadado de agora."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} disabled={!name.trim()} onClick={async () => { setBusy(true); await onSave(name.trim(), scope, shared); setBusy(false); }}>Salvar</Button></>}>
      <div className="space-y-3">
        <Input label="Nome da vista" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Holerites por competência" autoFocus />
        <div>
          <p id="vista-onde" className="mb-1.5 text-[13px] text-(--text-secondary)">Onde vale</p>
          <div role="radiogroup" aria-labelledby="vista-onde" className="mac-segmented is-fill">
            <button type="button" role="radio" aria-checked={scope === "pasta"} onClick={() => setScope("pasta")} className="mac-segment min-w-0"><span className="truncate">Só em “{folderName}”</span></button>
            <button type="button" role="radio" aria-checked={scope === "todas"} onClick={() => setScope("todas")} className="mac-segment">Em todas as pastas</button>
          </div>
        </div>
        <div>
          <p id="vista-quem" className="mb-1.5 text-[13px] text-(--text-secondary)">Quem vê</p>
          <div role="radiogroup" aria-labelledby="vista-quem" className="mac-segmented is-fill">
            <button type="button" role="radio" aria-checked={shared} onClick={() => setShared(true)} className="mac-segment">Todos da empresa</button>
            <button type="button" role="radio" aria-checked={!shared} onClick={() => setShared(false)} className="mac-segment">Só eu</button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

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

const DEFAULT_COL_WIDTHS = { name: 320, kind: 150, size: 100, ocr: 70, created: 110, updated: 120, uploader: 150 };

function SortableHeader({ label, sortKey, sort, onSort, className = "", align = "left", onResizeStart, onResizeReset, onResizeNudge, width }: {
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
  /** Teclado: setas ajustam a largura (X1-11). */
  onResizeNudge?: (delta: number) => void;
  width?: number;
}) {
  const active = sort.key === sortKey;
  return (
    <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"} className={`finder-th relative px-2 py-1 text-[11px] leading-[14px] text-left ${active ? "font-bold text-(--text-primary)" : "font-medium text-(--text-secondary)"} ${className}`}>
      <button
        onClick={() => onSort(sortKey)}
        className={`flex items-center gap-1 w-full ${align === "right" ? "justify-end" : "justify-between"}`}
      >
        {align === "right" && active && (sort.dir === "asc" ? <ChevronUp className="w-2.5 h-2.5 shrink-0" strokeWidth={3} /> : <ChevronDown className="w-2.5 h-2.5 shrink-0" strokeWidth={3} />)}
        <span className="truncate">{label}</span>
        {align === "left" && active && (sort.dir === "asc" ? <ChevronUp className="w-2.5 h-2.5 shrink-0" strokeWidth={3} /> : <ChevronDown className="w-2.5 h-2.5 shrink-0" strokeWidth={3} />)}
      </button>
      {onResizeStart && (
        <ColumnResizeHandle label={label} width={width ?? 0} onMouseDown={onResizeStart}
          onReset={() => onResizeReset?.()} onNudge={(d) => onResizeNudge?.(d)} />
      )}
    </th>
  );
}

// Alça de largura de coluna (X1-11): arrastar com o mouse, setas ←/→ no
// teclado (Shift = passo maior), Home volta ao padrão, duplo clique também.
function ColumnResizeHandle({ label, width, onMouseDown, onReset, onNudge }: {
  label: string; width: number; onMouseDown: (e: React.MouseEvent) => void; onReset: () => void; onNudge: (delta: number) => void;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`Largura da coluna ${label}`}
      aria-valuenow={width}
      aria-valuemin={60}
      aria-valuemax={800}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onDoubleClick={(e) => { e.stopPropagation(); onReset(); }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 16;
        if (e.key === "ArrowRight") { e.preventDefault(); onNudge(step); }
        else if (e.key === "ArrowLeft") { e.preventDefault(); onNudge(-step); }
        else if (e.key === "Home") { e.preventDefault(); onReset(); }
      }}
      className="absolute top-0 right-0 h-full w-2 cursor-col-resize select-none hover:bg-teal-400/40 active:bg-teal-400/60 focus-visible:outline-hidden focus-visible:bg-(--accent)/60"
    />
  );
}

// ─── Upload Modal (simplified inline) ────────────────────────────────────────


const NAV_KEY = "documents";


// Lista virtualizada: a partir de quantos itens, e quantas linhas a mais acima e abaixo da área visível.
const VIRT_MIN = 300;
const VIRT_FOLGA = 15;

export default function Documents() {
  usePageTitle("Documentos");
  const { current } = useCompany();
  const recursos = useFeatures();
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
  // Pasta com PDF: o visualizador baixa com o navegador ocioso (X1-22).
  useEffect(() => {
    if (documents.some((d) => d.name.toLowerCase().endsWith(".pdf"))) prefetchPdfViewer();
  }, [documents]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(saved?.folderId ?? null);
  const [breadcrumbs, setBreadcrumbs] = useState<Array<{ id: string | null; name: string }>>(
    (saved?.breadcrumbs ?? [{ id: null, name: "Documentos" }]).map((b, i) => (i === 0 && b.id === null ? { ...b, name: "Documentos" } : b))
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

  const [loading, setLoading] = useState(true);
  // Regra dos 200ms: só mostra skeleton se a carga passar de 200ms, e uma vez
  // visível fica pelo menos 500ms — evita o "flicker" em resposta de cache quente.
  const showSkeleton = useDelayedLoading(loading);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkMetadata, setShowBulkMetadata] = useState(false);
  const [detailDoc, setDetailDoc] = useState<Document | null>(null);
  const [previewDoc, setPreviewDoc] = useState<Document | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showNewFolder, setShowNewFolder] = useState(false);
  // LGPD (X2-17): classificação da pasta e selo na barra.
  const [privacyFolder, setPrivacyFolder] = useState<{ id: string; name: string } | null>(null);
  const [currentPrivacy, setCurrentPrivacy] = useState<string>("normal");
  useEffect(() => {
    if (!currentFolderId) { setCurrentPrivacy("normal"); return; }
    api.get(`/folders/${currentFolderId}/privacy`).then((r) => setCurrentPrivacy(r.data.effective ?? "normal")).catch(() => setCurrentPrivacy("normal"));
  }, [currentFolderId]);
  const [confirmDeleteFolder, setConfirmDeleteFolder] = useState<Folder | null>(null);
  const [deletingFolder, setDeletingFolder] = useState(false);
  const [sharingFolder, setSharingFolder] = useState<Folder | null>(null);
  const [requestingFolder, setRequestingFolder] = useState<Folder | null>(null);
  const [sharingDoc, setSharingDoc] = useState<Document | null>(null);
  const [showTreeDrawer, setShowTreeDrawer] = useState(false);
  const [mobileMenu, setMobileMenu] = useState<HTMLElement | null>(null);
  const [copyingFolder, setCopyingFolder] = useState<Folder | null>(null);
  const [sharedFiles, setSharedFiles] = useState<File[] | undefined>(undefined);
  // Vista da pasta (B1.2.7): agrupar, filtrar por valor de metadado e vistas salvas.
  const [groupBy, setGroupBy] = useState<string>("");
  const [fieldFilter, setFieldFilter] = useState<{ id: string; label: string; value: string } | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savingView, setSavingView] = useState(false);
  // Modelos (B1.5.4, B1.5.6, B1.5.8).
  const [savingTemplate, setSavingTemplate] = useState<Folder | null>(null);
  const [applyingTemplate, setApplyingTemplate] = useState<Folder | null>(null);
  const [newFromTemplate, setNewFromTemplate] = useState<Folder | null>(null);
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
    if (!selected.has(data.id)) setSelected(new Set([data.id]));
    setMenu({ anchor: { x: e.clientX, y: e.clientY }, kind, data } as MenuTarget);
  }
  function openMenuAt(el: HTMLElement, kind: "document" | "folder", data: Document | Folder) {
    setFocusedId(data.id);
    if (!selected.has(data.id)) setSelected(new Set([data.id]));
    setMenu({ anchor: el, kind, data } as MenuTarget);
  }
  // "Mover para…" (documentos ou pasta) — achados A4-36 e X1-08.
  const [picker, setPicker] = useState<
    | { kind: "documents"; ids: string[] }
    | { kind: "folder"; folder: Folder }
    | { kind: "selection"; docIds: string[]; folders: Folder[] }
    | null
  >(null);
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
      const ids = selected.has(d.id) && selDocIds.length > 1 ? selDocIds : [d.id];
      const multi = ids.length > 1;
      const list: MenuItem[] = [];
      if (!multi) {
        list.push({ label: "Abrir", icon: <Eye />, shortcut: "Espaço", onSelect: () => setPreviewDoc(d) });
        list.push({ label: "Detalhes", icon: <Info />, onSelect: () => setDetailDoc(d) });
      }
      list.push({ label: multi ? `Baixar ${ids.length} em ZIP` : "Baixar", icon: <Download />, separatorBefore: !multi, onSelect: () => downloadDocuments(ids) });
      if (!multi) {
        list.push({ label: "Copiar link", icon: <Link2 />, onSelect: () => copyLink(d) });
        if (recursos.links) list.push({ label: "Compartilhar…", icon: <Share2 />, disabled: !canWrite, onSelect: () => setSharingDoc(d) });
      }
      list.push({ label: multi ? "Ancorar todos" : d.favorited ? "Já está ancorado" : "Ancorar", icon: <Anchor />, disabled: !multi && !!d.favorited, onSelect: () => anchorDocuments(ids) });
      if (canWrite) {
        list.push({ label: "Mover para…", icon: <FolderInput />, separatorBefore: true, onSelect: () => setPicker({ kind: "documents", ids }) });
        if (!multi) list.push({ label: "Renomear", icon: <Pencil />, shortcut: "F2", onSelect: () => startRename("document", d.id, d.name) });
        if (!multi && canAdmin) list.push({ label: d.is_template ? "Deixar de ser modelo" : "Marcar como modelo", icon: <LayoutTemplate />, onSelect: () => toggleDocTemplate(d) });
        list.push({ label: multi ? `Excluir ${ids.length}` : "Excluir", icon: <Trash2 />, shortcut: "Del", danger: true, separatorBefore: true, onSelect: () => deleteDocuments(ids) });
      }
      return list;
    }
    const f = t.data;
    const list: MenuItem[] = [{ label: "Abrir", icon: <FolderOpen />, shortcut: "Enter", onSelect: () => openFolder(f) }];
    if (recursos.links) list.push({ label: "Compartilhar…", icon: <Share2 />, disabled: !canWrite, onSelect: () => setSharingFolder(f) });
    // Link de envio para alguém de fora mandar arquivos para a pasta (FA-A4-11).
    if (recursos.pedidos) list.push({ label: "Pedir arquivos…", icon: <Inbox />, disabled: !canWrite, onSelect: () => setRequestingFolder(f) });
    list.push({ label: "Novo a partir de modelo…", icon: <FilePlus />, disabled: !canWrite, onSelect: () => setNewFromTemplate(f) });
    if (canAdmin) {
      list.push({ label: "Mover para…", icon: <FolderInput />, separatorBefore: true, onSelect: () => setPicker({ kind: "folder", folder: f }) });
      list.push({ label: "Renomear", icon: <Pencil />, shortcut: "F2", onSelect: () => startRename("folder", f.id, f.name) });
      list.push({ label: "Copiar estrutura para…", icon: <Copy />, onSelect: () => setCopyingFolder(f) });
      list.push({ label: "Salvar como modelo…", icon: <LayoutTemplate />, onSelect: () => setSavingTemplate(f) });
      list.push({ label: "Aplicar modelo…", icon: <LayoutTemplate />, onSelect: () => setApplyingTemplate(f) });
      list.push({ label: "Usar como pasta de triagem", icon: <Inbox />, onSelect: () => marcarComoTriagem(f) });
      list.push({ label: "Permissões desta pasta", icon: <Shield />, separatorBefore: true, onSelect: () => navigate(`/settings/users?folder=${f.id}`) });
      list.push({ label: "Metadados desta pasta", icon: <Tags />, onSelect: () => navigate(`/settings/metadata?tab=tree&folder=${f.id}`) });
      list.push({ label: "Retenção desta pasta", icon: <Archive />, onSelect: () => navigate(`/settings/retention?folder=${f.id}`) });
      list.push({ label: "Privacidade (LGPD)…", icon: <ShieldAlert />, onSelect: () => setPrivacyFolder(f) });
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
  const [density, setDensity] = useState<Density>(
    () => (["compact", "comfortable", "spacious"].includes(localStorage.getItem("docke_table_density") ?? "") ? localStorage.getItem("docke_table_density") as Density : "comfortable")
  );
  function chooseDensity(next: Density) {
    setDensity(next);
    localStorage.setItem("docke_table_density", next);
  }
  function toggleDensity() {
    chooseDensity(density === "compact" ? "comfortable" : "compact");
  }

  const [visibleCols, setVisibleCols] = useState<OptCol[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("docke_doc_columns") ?? "null");
      if (Array.isArray(raw)) return OPT_COLS.map((c) => c.key).filter((k) => raw.includes(k));
    } catch { /* ignora */ }
    return DEFAULT_VISIBLE_COLS;
  });
  function toggleCol(k: OptCol) {
    setVisibleCols((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : OPT_COLS.map((c) => c.key).filter((x) => x === k || prev.includes(x));
      localStorage.setItem("docke_doc_columns", JSON.stringify(next));
      return next;
    });
  }
  function resetCols() {
    setVisibleCols(DEFAULT_VISIBLE_COLS);
    localStorage.removeItem("docke_doc_columns");
  }
  const shownCols = OPT_COLS.filter((c) => visibleCols.includes(c.key));
  const [viewMenu, setViewMenu] = useState<{ x: number; y: number } | HTMLElement | null>(null);

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
  function setSortTo(key: SortKey, dir: "asc" | "desc") {
    const next = { key, dir };
    saveFolderPref(currentFolderId, { sort: next });
    setSort(next);
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
  function nudgeColWidth(col: keyof typeof DEFAULT_COL_WIDTHS, delta: number) {
    setColWidths((prev) => {
      const next = { ...prev, [col]: Math.min(800, Math.max(60, prev[col] + delta)) };
      localStorage.setItem("docke_col_widths", JSON.stringify(next));
      return next;
    });
  }

  // Duplo clique na borda: ajusta a coluna ao maior conteúdo visível (Finder/Excel).
  function autoFitCol(col: keyof typeof DEFAULT_COL_WIDTHS) {
    const cells = scrollBodyRef.current?.querySelectorAll<HTMLElement>(`[data-col="${col}"]`);
    if (!cells || !cells.length) { resetColWidth(col); return; }
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) { resetColWidth(col); return; }
    let max = 0;
    cells.forEach((c) => {
      const cs = getComputedStyle(c);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      max = Math.max(max, ctx.measureText((c.innerText || "").trim()).width);
    });
    const extra = col === "name" ? 64 : 34;
    const w = Math.round(Math.min(640, Math.max(60, max + extra)));
    setColWidths((prev) => {
      const next = { ...prev, [col]: w };
      localStorage.setItem("docke_col_widths", JSON.stringify(next));
      return next;
    });
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
      showError("Não foi possível expandir a pasta. Clique de novo na seta para tentar outra vez.");
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

  // Desfazer é global (lib/undo): aviso com "Desfazer" e Ctrl+Z em qualquer
  // tela. Depois de desfazer, a lista e a árvore recarregam.
  const { offer: toastWithUndo } = useUndo();
  useEffect(() => {
    function onUndone() { load(); setFolderTreeVersion((v) => v + 1); }
    window.addEventListener("docke:desfeito", onUndone);
    return () => window.removeEventListener("docke:desfeito", onUndone);
  });

  /**
   * Nova pasta como no Finder (A4-41): cria "Nova pasta" (ou "Nova pasta 2"…)
   * na hora e já abre o nome para editar. Esc mantém o nome sugerido; Ctrl+Z
   * desfaz a criação.
   */
  const creatingFolder = useRef(false);
  async function createFolderInline() {
    if (!current || currentFolderId === undefined || !canWrite || creatingFolder.current) return;
    creatingFolder.current = true;
    const usados = new Set(folders.map((f) => f.name.toLowerCase()));
    let nome = "Nova pasta";
    for (let n = 2; usados.has(nome.toLowerCase()); n++) nome = `Nova pasta ${n}`;
    try {
      const { data } = await api.post<Folder>("/folders", { name: nome, company_id: current.id, parent_id: currentFolderId });
      setFolders((prev) => [...prev, data]);
      setFolderTreeVersion((v) => v + 1);
      pushUndo(`criar a pasta "${data.name}"`, async () => { await api.delete(`/folders/${data.id}`); });
      setFocusedId(data.id);
      setRenaming({ kind: "folder", id: data.id, value: data.name });
      window.setTimeout(() => rowRefs.current.get(data.id)?.scrollIntoView({ block: "nearest" }), 30);
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível criar a pasta."));
    } finally {
      creatingFolder.current = false;
    }
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
      // Rollback com motivo e caminho de volta (A2-34): o campo reabre com o
      // nome tentado, pronto para corrigir e confirmar de novo.
      setRenaming({ kind, id, value: trimmed });
      showError(`${friendlyError(e, "Não foi possível renomear.")} O nome voltou para edição.`);
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
      if (mod && e.shiftKey && e.key.toLowerCase() === "n") { e.preventDefault(); createFolderInline(); return; }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(new Set(items.map((it) => it.data.id)));
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
          setSelected(new Set(items.slice(a, b + 1).map((it) => it.data.id)));
        } else if (!mod) {
          setSelected(new Set([id]));
        }
        // O painel de detalhes acompanha o item em foco (como a pré-visualização do Finder).
        if (isDoc && detailDoc && isDesktop) {
          const d = documents.find((x) => x.id === id);
          if (d) setDetailDoc(d);
        }
        const el = rowRefs.current.get(id);
        if (!el) { revelarLinha(id); return; }
        el.focus({ preventScroll: true });
        el.scrollIntoView({ block: "nearest" });
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
        if (selected.size) deleteSelected();
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
  // Pastas também se arrastam e entram no lote (A4-14).
  const [dragFolderIds, setDragFolderIds] = useState<string[] | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  // Pasta que acabou de receber itens: pulso curto de confirmação (A4-38).
  const [droppedOn, setDroppedOn] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  // Spring-loaded folders: manter um documento arrastado sobre uma pasta por
  // um tempo abre a pasta automaticamente (padrão Finder/Explorer).
  const dragHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearDragHoverTimer() {
    if (dragHoverTimerRef.current) { clearTimeout(dragHoverTimerRef.current); dragHoverTimerRef.current = null; }
  }

  // Laço (A4-29, A4-30): com mouse funciona sempre, a partir de área vazia; a
  // seleção acompanha o retângulo enquanto ele é desenhado. Clique simples em
  // área vazia limpa a seleção (Finder). No celular, só no modo de seleção.
  function handleBodyMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return;
    // Com mouse (ponteiro fino), sempre; no toque, só no modo de seleção.
    if (!selectionMode && !window.matchMedia("(pointer: fine)").matches) return;
    if ((e.target as HTMLElement).closest("tr, button, input, a, [role=option], [role=menu], [role=dialog]")) return;
    const container = scrollBodyRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const startX = e.clientX - rect.left + container.scrollLeft;
    const startY = e.clientY - rect.top + container.scrollTop;
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const base = additive ? new Set(selected) : new Set<string>();
    let moved = false;
    let frame = 0;

    function hits(x2: number, y2: number) {
      const r = container!.getBoundingClientRect();
      const left = Math.min(startX, x2), right = Math.max(startX, x2);
      const top = Math.min(startY, y2), bottom = Math.max(startY, y2);
      const out: string[] = [];
      rowRefs.current.forEach((el, id) => {
        const er = el.getBoundingClientRect();
        const rowTop = er.top - r.top + container!.scrollTop;
        const rowLeft = er.left - r.left + container!.scrollLeft;
        if (rowTop + er.height >= top && rowTop <= bottom && rowLeft + er.width >= left && rowLeft <= right
          && (documents.some((d) => d.id === id) || folders.some((f) => f.id === id))) out.push(id);
      });
      return out;
    }

    function handleMove(ev: MouseEvent) {
      const r = container!.getBoundingClientRect();
      const x = ev.clientX - r.left + container!.scrollLeft;
      const y = ev.clientY - r.top + container!.scrollTop;
      if (!moved && Math.abs(x - startX) < 4 && Math.abs(y - startY) < 4) return;
      moved = true;
      setDragBox({ x1: startX, y1: startY, x2: x, y2: y });
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = new Set(base);
        hits(x, y).forEach((id) => next.add(id));
        setSelected(next);
      });
    }

    function handleUp(ev: MouseEvent) {
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
      if (frame) cancelAnimationFrame(frame);
      if (moved) {
        // Resultado final calculado na hora (não depende de um quadro pendente).
        const r = container!.getBoundingClientRect();
        const next = new Set(base);
        hits(ev.clientX - r.left + container!.scrollLeft, ev.clientY - r.top + container!.scrollTop).forEach((id) => next.add(id));
        setSelected(next);
      } else if (!additive && selected.size) {
        setSelected(new Set());
        if (isDesktop) setDetailDoc(null);
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
  const tableWrapRef = useRef<HTMLDivElement>(null);

  const PAGE = 200;
  // Com mais de uma página, o filtro e a ordenação vão para o servidor.
  const [serverQuery, setServerQuery] = useState("");

  // Pré-carga ao pairar sobre uma pasta (A4-06): quando ela abre, o conteúdo
  // já está a caminho (ou pronto) e a troca acontece sem esqueleto.
  type FolderContent = { folders: Folder[]; docs: Document[]; total: number; cursor: string | null };
  // FA-A4-03: a próxima página vem pelo cursor (não pula nem repete quando a lista muda no meio).
  const cursorRef = useRef<string | null>(null);
  const prefetchRef = useRef(new Map<string, { at: number; p: Promise<FolderContent> }>());
  const fetchFolderContent = useCallback((companyId: string, folderId: string | null, sk: string, sd: string, q: string): Promise<FolderContent> => {
    const foldersParams: Record<string, string> = { company_id: companyId };
    if (folderId) foldersParams.parent_id = folderId;
    return Promise.all([
      api.get<Folder[]>("/folders", { params: foldersParams }),
      folderId
        ? api.get<Document[]>("/documents", { params: { company_id: companyId, folder_id: folderId, limit: PAGE, offset: 0, sort: sk, dir: sd, q: q || undefined } })
        : Promise.resolve({ data: [] as Document[], headers: {} as Record<string, string> }),
    ]).then(([fRes, dRes]) => {
      const docs = Array.isArray(dRes.data) ? dRes.data : [];
      return {
        folders: Array.isArray(fRes.data) ? fRes.data : [],
        docs,
        total: Number((dRes.headers as Record<string, string>)?.["x-total-count"] ?? docs.length) || docs.length,
        cursor: (dRes.headers as Record<string, string>)?.["x-next-cursor"] ?? null,
      };
    });
  }, []);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function prefetchFolder(folderId: string) {
    if (!current) return;
    const pref = loadFolderPref(folderId).sort;
    const key = `${current.id}:${folderId}:${pref.key}:${pref.dir}`;
    const hit = prefetchRef.current.get(key);
    if (hit && Date.now() - hit.at < 20_000) return;
    const p = fetchFolderContent(current.id, folderId, pref.key, pref.dir, "");
    p.catch(() => prefetchRef.current.delete(key));
    prefetchRef.current.set(key, { at: Date.now(), p });
  }
  function hoverFolder(folderId: string) {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => prefetchFolder(folderId), 120);
  }
  function leaveFolder() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }

  const load = useCallback(async () => {
    if (!current) return;
    setLoading(true);
    setLoadError(null);
    setSelected(new Set());

    try {
      const key = `${current.id}:${currentFolderId}:${sort.key}:${sort.dir}`;
      const hit = !serverQuery && currentFolderId ? prefetchRef.current.get(key) : undefined;
      if (hit) prefetchRef.current.delete(key); // usa uma vez; a próxima abertura busca de novo
      const r = hit && Date.now() - hit.at < 20_000
        ? await hit.p
        : await fetchFolderContent(current.id, currentFolderId, sort.key, sort.dir, serverQuery);
      setFolders(r.folders);
      setDocuments(r.docs);
      setTotal(r.total);
      cursorRef.current = r.cursor;
    } catch (e: any) {
      setFolders([]);
      setDocuments([]);
      setTotal(0);
      setLoadError(friendlyError(e, "Não foi possível abrir esta pasta agora."));
    } finally {
      setLoading(false);
    }
  }, [current?.id, currentFolderId, sort.key, sort.dir, serverQuery, fetchFolderContent]);

  async function loadMore() {
    if (!current || !currentFolderId || loadingMore || documents.length >= total) return;
    setLoadingMore(true);
    try {
      const r = await api.get<Document[]>("/documents", {
        params: {
          company_id: current.id, folder_id: currentFolderId, limit: PAGE, sort: sort.key, dir: sort.dir, q: serverQuery || undefined,
          ...(cursorRef.current ? { cursor: cursorRef.current } : { offset: documents.length }),
        },
      });
      cursorRef.current = (r.headers as Record<string, string>)?.["x-next-cursor"] ?? null;
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
  // Pedido de acesso (B3.1.6): link de uma pasta que a pessoa não acessa.
  const [semAcesso, setSemAcesso] = useState<string | null>(null);
  // Termo vindo da Busca (B2.6.6): abre a prévia com a busca interna preenchida.
  const [pendingBusca, setPendingBusca] = useState<string | null>(null);
  const [previewQuery, setPreviewQuery] = useState<string | null>(null);
  useEffect(() => {
    const linkedFolderId = searchParams.get("folder_id");
    const linkedDocId = searchParams.get("doc");
    if (!linkedFolderId || !current) return;
    if (linkedDocId) setPendingDocId(linkedDocId);
    setPendingBusca(searchParams.get("busca"));

    api.get<Array<Folder & { path: string }>>("/folders", { params: { company_id: current.id, flat: true } })
      .then((res) => {
        const all = Array.isArray(res.data) ? res.data : [];
        const target = all.find((f) => f.id === linkedFolderId);
        if (!target) { setSemAcesso(linkedFolderId); return; }

        const chain: Array<{ id: string | null; name: string }> = [{ id: null, name: "Documentos" }];
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
    if (doc) {
      setDetailDoc(doc);
      if (pendingBusca) { setPreviewQuery(pendingBusca); setPreviewDoc(doc); setPendingBusca(null); }
    }
  }, [documents, loading, pendingDocId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vistas salvas (B1.2.7): as da pasta aberta e as de "todas as pastas".
  useEffect(() => {
    if (!current) return;
    api.get<SavedView[]>(`/companies/${current.id}/views`, { params: { folder_id: currentFolderId ?? undefined } })
      .then((r) => setSavedViews(r.data)).catch(() => setSavedViews([]));
  }, [current?.id, currentFolderId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Filtro e agrupamento valem para a pasta aberta: trocar de pasta limpa.
  useEffect(() => { setFieldFilter(null); setGroupBy(""); }, [currentFolderId]);

  function applyView(v: SavedView) {
    const c = v.config;
    if (c.sort) setSortTo(c.sort.key, c.sort.dir);
    if (c.cols) { const cols = OPT_COLS.map((x) => x.key).filter((k) => c.cols!.includes(k)); setVisibleCols(cols); localStorage.setItem("docke_doc_columns", JSON.stringify(cols)); }
    setGroupBy(c.groupBy ?? "");
    setFieldFilter(c.fieldFilter ?? null);
    if (c.view && c.view !== viewMode) setView(c.view);
    success(`Vista "${v.name}" aplicada.`);
  }
  async function saveView(name: string, scope: "pasta" | "todas", shared: boolean) {
    if (!current) return;
    try {
      const r = await api.post<SavedView>(`/companies/${current.id}/views`, {
        name, shared, folder_id: scope === "pasta" ? currentFolderId : null,
        config: { sort, cols: visibleCols, groupBy, fieldFilter, view: viewMode },
      });
      setSavedViews((prev) => [...prev, r.data]);
      success(`Vista "${name}" salva${shared ? " para todos da empresa" : " só para você"}.`);
      setSavingView(false);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível salvar a vista.");
    }
  }
  async function deleteView(v: SavedView) {
    try {
      await api.delete(`/views/${v.id}`);
      setSavedViews((prev) => prev.filter((x) => x.id !== v.id));
      success(`Vista "${v.name}" apagada.`);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível apagar a vista.");
    }
  }

  // Ações vindas do ⌘K (?acao=enviar | nova-pasta).
  const acaoParam = searchParams.get("acao");
  useEffect(() => {
    if (!acaoParam || !current) return;
    if (acaoParam === "enviar" && canWrite) setShowUpload(true);
    if (acaoParam === "nova-pasta" && canWrite) setShowNewFolder(true);
    // Arquivos do "Compartilhar" do celular (B4.5.7): o service worker guardou
    // num cache próprio; viram a lista do envio, com a pasta à escolha.
    if (acaoParam === "compartilhado") {
      lerCompartilhados().then((files) => {
        if (!files.length) return;
        if (!canWrite) { showError("Você só lê esta empresa: os arquivos compartilhados não podem ser enviados aqui."); return; }
        setSharedFiles(files);
        setShowUpload(true);
      });
    }
    const next = new URLSearchParams(searchParams);
    next.delete("acao");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acaoParam, current?.id]);

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
    setBreadcrumbs([{ id: null, name: "Documentos" }]);
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

      const chain: Array<{ id: string | null; name: string }> = [{ id: null, name: "Documentos" }];
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
      showError("Não foi possível abrir a pasta. Ela pode ter sido movida ou excluída. Atualize a página e tente de novo.");
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
    const allIds = items.map((it) => it.data.id);
    setSelected(selected.size === allIds.length ? new Set() : new Set(allIds));
  }

  // Excluir grava na hora e empilha a restauração (achados A4-26, A4-61).
  /** As linhas que saem da lista somem deslizando, em vez de sumir de uma vez (A4-18). */
  async function animateOut(ids: string[]) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = ids.map((id) => rowRefs.current.get(id)).filter((el): el is HTMLElement => !!el);
    if (!els.length || els.length > 60) return;
    els.forEach((el) => el.classList.add("row-leave"));
    await new Promise((r) => window.setTimeout(r, 170));
    els.forEach((el) => el.classList.remove("row-leave"));
  }

  async function deleteDocuments(ids: string[]) {
    if (!ids.length) return;
    const backup = documents.filter((d) => ids.includes(d.id));
    await animateOut(ids);
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
    if (selFolders.length) { setConfirmBulkDelete(true); return; }
    deleteDocuments(selDocIds);
  }

  // Lote com pastas: confirma (vai tudo o que há dentro) e oferece Desfazer.
  async function deleteSelectedConfirmed() {
    const fs = selFolders;
    const ds = selDocIds;
    setConfirmBulkDelete(false);
    if (ds.length) await deleteDocuments(ds);
    const done: Folder[] = [];
    for (const f of fs) {
      try { await api.delete(`/folders/${f.id}`); done.push(f); }
      catch (e: any) { showError(friendlyError(e, `Não foi possível excluir a pasta "${f.name}".`)); }
    }
    if (!done.length) return;
    setFolders((prev) => prev.filter((f) => !done.some((x) => x.id === f.id)));
    setFolderTreeVersion((v) => v + 1);
    setSelected(new Set());
    toastWithUndo(
      `${plural(done.length, "pasta foi", "pastas foram")} para a lixeira.`,
      `excluir ${plural(done.length, "pasta", "pastas")}`,
      async () => { for (const f of done) await api.post(`/trash/${f.id}/restore`, null, { params: { item_type: "folder" } }); },
    );
  }

  // Ler o texto de novo direto da linha (A4-19).
  async function retryOcr(d: Document) {
    try {
      await api.post(`/documents/${d.id}/retry-ocr`);
      setDocuments((prev) => prev.map((x) => (x.id === d.id ? { ...x, ocr_status: "pending" } : x)));
      success(`"${d.name}" voltou para a fila de leitura do texto.`);
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível pedir a leitura de novo. Tente pelo painel de detalhes."));
    }
  }

  async function moveFoldersTo(list: Folder[], target: PickedFolder) {
    const moved: { f: Folder; old: string | null }[] = [];
    for (const f of list) {
      if (f.id === target.id || (f.parent_id ?? null) === (target.id ?? null)) continue;
      try { await api.patch(`/folders/${f.id}/move`, { parent_id: target.id }); moved.push({ f, old: f.parent_id ?? null }); }
      catch (e: any) { showError(friendlyError(e, `Não foi possível mover a pasta "${f.name}".`)); }
    }
    if (!moved.length) return;
    setFolders((prev) => prev.filter((x) => !moved.some((m) => m.f.id === x.id)));
    setFolderTreeVersion((v) => v + 1);
    setSelected(new Set());
    toastWithUndo(
      `${moved.length === 1 ? `Pasta "${moved[0].f.name}" movida` : `${moved.length} pastas movidas`} para "${target.name}".`,
      `mover ${plural(moved.length, "pasta", "pastas")}`,
      async () => { for (const m of moved) await api.patch(`/folders/${m.f.id}/move`, { parent_id: m.old }); },
    );
  }

  // Arrastar documentos e pastas (A4-14, A4-39): fantasma com tokens.
  function startItemDrag(e: React.DragEvent, id: string, name: string) {
    const ids = selected.has(id) && selected.size > 1 ? [...selected] : [id];
    const docs = ids.filter((x) => docIdSet.has(x));
    const fids = ids.filter((x) => !docIdSet.has(x));
    setDragDocIds(docs.length ? docs : null);
    setDragFolderIds(fids.length ? fids : null);
    e.dataTransfer.effectAllowed = fids.length ? "move" : "copyMove";
    if (docs.length) e.dataTransfer.setData("application/x-docke-document-ids", docs.join(","));
    if (fids.length === 1 && !docs.length) e.dataTransfer.setData("application/x-docke-folder-id", fids[0]);
    e.dataTransfer.setData("text/plain", ids.join(","));
    const ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    ghost.textContent = ids.length > 1 ? `${ids.length} ${fids.length ? "itens" : "arquivos"}` : name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 14, 14);
    setTimeout(() => ghost.remove(), 0);
  }
  function endItemDrag() {
    setDragDocIds(null);
    setDragFolderIds(null);
    setDragOverFolderId(null);
  }
  // Alt (Option) ao soltar copia em vez de mover (A4-38), como no Finder.
  async function copyDocumentsTo(ids: string[], target: { id: string; name: string }) {
    try {
      const { data } = await api.post<{ copied: number; document_ids: string[] }>("/documents/bulk-copy", { document_ids: ids, target_folder_id: target.id });
      const novos = data.document_ids ?? [];
      if (target.id === currentFolderId) load();
      toastWithUndo(
        `${plural(data.copied, "cópia criada", "cópias criadas")} em "${target.name}".`,
        `copiar ${plural(data.copied, "documento", "documentos")}`,
        async () => { if (novos.length) await api.post("/documents/bulk-delete", { document_ids: novos }); if (target.id === currentFolderId) load(); },
      );
    } catch (e: any) {
      showError(friendlyError(e, "Não foi possível copiar. Tente de novo."));
    }
  }

  function dropOnTarget(target: { id: string | null; name: string }, copy: boolean) {
    if (dragDocIds && target.id) {
      if (copy) copyDocumentsTo(dragDocIds, { id: target.id, name: target.name });
      else moveDocuments(dragDocIds, target.id, target.name);
    }
    if (dragFolderIds && !copy) {
      const list = folders.filter((x) => dragFolderIds.includes(x.id) && x.id !== target.id);
      if (list.length) moveFoldersTo(list, { id: target.id, name: target.name } as PickedFolder);
    }
    if (target.id) {
      setDroppedOn(target.id);
      window.setTimeout(() => setDroppedOn((v) => (v === target.id ? null : v)), 500);
    }
    setDragDocIds(null);
    setDragFolderIds(null);
    setDragOverFolderId(null);
  }
  function dropOnFolder(f: Folder, copy = false) {
    dropOnTarget({ id: f.id, name: f.name }, copy);
  }

  // A barra lateral (árvore de pastas global) conversa com esta tela por eventos:
  // soltar documentos numa pasta, mover uma pasta e recarregar quando algo muda.
  useEffect(() => { window.dispatchEvent(new CustomEvent("docke:pastas")); }, [folderTreeVersion]);
  useEffect(() => { window.dispatchEvent(new CustomEvent("docke:ancorados")); }, [sidebarFavorites]);
  useEffect(() => {
    function onDrop(e: Event) {
      const d = (e as CustomEvent<{ folderId: string; ids: string[]; folderName: string }>).detail;
      moveDocuments(d.ids, d.folderId, d.folderName);
      setDragDocIds(null);
    }
    function onMoved(e: Event) {
      const d = (e as CustomEvent<{ folderId: string; newParent: string | null; oldParent: string | null; name: string }>).detail;
      onTreeMove(d.folderId, d.newParent, d.oldParent, d.name);
    }
    window.addEventListener("docke:soltar-documentos", onDrop);
    window.addEventListener("docke:pasta-movida", onMoved);
    return () => {
      window.removeEventListener("docke:soltar-documentos", onDrop);
      window.removeEventListener("docke:pasta-movida", onMoved);
    };
  });

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
    const novos: string[] = [];
    for (const id of ids) {
      try { await api.post("/favorites", { document_id: id }); ok++; novos.push(id); } catch (e: any) { if (e?.response?.status === 409) ok++; }
    }
    setDocuments((prev) => prev.map((d) => (ids.includes(d.id) ? { ...d, favorited: true } : d)));
    loadSidebarFavorites();
    const msg = `${plural(ok, "documento ancorado", "documentos ancorados")}.`;
    if (!novos.length) { success(msg); return; }
    // Desfazer tira só as âncoras criadas agora (as que já existiam ficam).
    toastWithUndo(msg, novos.length === 1 ? "ancorar o documento" : `ancorar ${novos.length} documentos`, async () => {
      const list = await api.get<{ id: string; document_id: string | null }[]>("/favorites", { params: { company_id: current?.id } });
      for (const f of list.data) if (f.document_id && novos.includes(f.document_id)) await api.delete(`/favorites/${f.id}`);
      loadSidebarFavorites();
    });
  }

  async function marcarComoTriagem(f: Folder) {
    if (!current) return;
    try {
      await api.put(`/companies/${current.id}/inbox`, { folder_id: f.id });
      success(`"${f.name}" agora é a pasta de triagem: ao abrir, ela sugere o destino de cada documento.`);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível definir a pasta de triagem.");
    }
  }

  async function toggleDocTemplate(doc: Document) {
    try {
      await api.put(`/documents/${doc.id}/template`, { is_template: !doc.is_template });
      success(doc.is_template ? `"${doc.name}" deixou de ser modelo.` : `"${doc.name}" agora é modelo: aparece em "Novo a partir de modelo".`);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível mudar o modelo.");
    }
  }

  function copyLink(doc: Document) {
    const url = `${window.location.origin}/documents?folder_id=${doc.folder_id ?? currentFolderId}&doc=${doc.id}`;
    navigator.clipboard?.writeText(url).then(
      () => success("Link copiado. Quem tiver acesso à pasta abre direto no documento."),
      () => showError("Não foi possível copiar o link. Abra o documento e copie o endereço da barra do navegador."),
    );
  }

    const sortedFolders = [...folders].sort((a, b) => a.name.localeCompare(b.name));
  function groupLabel(d: Document): string {
    if (groupBy === "kind") return kindLabel(d.name);
    if (groupBy === "uploader") return d.uploaded_by_name || SEM_VALOR;
    if (groupBy.startsWith("field:")) return fieldValues[d.id]?.[groupBy.slice(6)] || SEM_VALOR;
    return "";
  }
  const sortedDocuments = [...documents].sort((a, b) => {
    let cmp = 0;
    if (sort.key === "name") cmp = a.name.localeCompare(b.name, "pt-BR");
    else if (sort.key === "size") cmp = a.size_bytes - b.size_bytes;
    else if (sort.key === "kind") cmp = kindLabel(a.name).localeCompare(kindLabel(b.name), "pt-BR");
    else if (sort.key === "ocr") cmp = (OCR_ORDER[a.ocr_status] ?? 9) - (OCR_ORDER[b.ocr_status] ?? 9);
    else if (sort.key === "uploader") cmp = (a.uploaded_by_name ?? "").localeCompare(b.uploaded_by_name ?? "", "pt-BR");
    else if (sort.key === "updated_at") cmp = new Date(a.updated_at ?? a.created_at).getTime() - new Date(b.updated_at ?? b.created_at).getTime();
    else if (sort.key.startsWith("field:")) {
      // Metadado (B1.2.7): vazio vai para o fim; números e datas em ordem natural.
      const fid = sort.key.slice(6);
      const va = fieldValues[a.id]?.[fid] ?? "", vb = fieldValues[b.id]?.[fid] ?? "";
      if (!va || !vb) cmp = !va && !vb ? 0 : !va ? 1 : -1;
      else cmp = va.localeCompare(vb, "pt-BR", { numeric: true });
      if (!va || !vb) cmp = sort.dir === "asc" ? cmp : -cmp;
    }
    else cmp = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    cmp = sort.dir === "asc" ? cmp : -cmp;
    // Agrupar (B1.2.7): o grupo manda, a ordenação vale dentro dele.
    if (groupBy) {
      const ga = groupLabel(a), gb = groupLabel(b);
      if (ga !== gb) return ga === SEM_VALOR ? 1 : gb === SEM_VALOR ? -1 : ga.localeCompare(gb, "pt-BR", { numeric: true });
    }
    return cmp;
  });

  // Filtro rápido aplicado por cima da ordenação — não mexe na seleção nem
  // na ordenação salva, só restringe o que é exibido/alcançável por clique.
  const filterQ = filterQuery.trim().toLowerCase();
  const visibleFolders = filterQ ? sortedFolders.filter((f) => f.name.toLowerCase().includes(filterQ)) : sortedFolders;
  // Campos obrigatórios vazios por documento (X2-20): aviso na linha e filtro rápido.
  const missingRequired = useMemo(() => {
    const req = resolvedFields.filter((f) => f.required);
    const map = new Map<string, string[]>();
    if (!req.length) return map;
    for (const d of sortedDocuments) {
      const vals = fieldValues[d.id] ?? {};
      const faltam = req.filter((f) => !(vals[f.custom_field_id] ?? "").trim()).map((f) => f.label);
      if (faltam.length) map.set(d.id, faltam);
    }
    return map;
  }, [resolvedFields, fieldValues, sortedDocuments]);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const visibleDocuments = (filterQ ? sortedDocuments.filter((d) => d.name.toLowerCase().includes(filterQ)) : sortedDocuments)
    .filter((d) => !onlyMissing || missingRequired.has(d.id))
    .filter((d) => !fieldFilter || (fieldValues[d.id]?.[fieldFilter.id] ?? "") === fieldFilter.value);

  // Pastas sempre no topo (convenção de gerenciador de arquivos); só os documentos respeitam a ordenação escolhida
  const items: Item[] = [
    ...visibleFolders.map((f): Item => ({ kind: "folder", data: f })),
    ...visibleDocuments.map((d): Item => ({ kind: "document", data: d })),
  ];

  // Lista virtualizada (B1.2.10, FA-A4-03, A4-24): com muitos itens, só as
  // linhas perto da área visível vão para a tela; espaçadores no lugar das
  // outras mantêm a rolagem do tamanho certo. A altura vem medida da própria
  // linha. Pastas abertas em árvore desligam a janela (alturas variam muito).
  const virt = viewMode === "list" && items.length > VIRT_MIN && !Object.values(expandedFolders).some(Boolean);
  const tbodyRef = useRef<HTMLTableSectionElement>(null);
  const alturaLinha = useRef(density === "compact" ? 36 : density === "spacious" ? 60 : 48);
  const [janela, setJanela] = useState({ start: 0, end: VIRT_MIN });
  useEffect(() => {
    if (!virt) return;
    const box = scrollBodyRef.current;
    if (!box) return;
    let frame = 0;
    const calc = () => {
      frame = 0;
      const tb = tbodyRef.current;
      if (!tb) return;
      const linha = tb.querySelector<HTMLElement>("tr[data-linha]");
      if (linha && linha.offsetHeight > 0) alturaLinha.current = linha.offsetHeight;
      const h = alturaLinha.current;
      const topo = tb.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      const ini = Math.max(0, Math.floor((box.scrollTop - topo) / h) - VIRT_FOLGA);
      const fim = Math.min(items.length, Math.ceil((box.scrollTop - topo + box.clientHeight) / h) + VIRT_FOLGA);
      setJanela((j) => (j.start === ini && j.end === fim ? j : { start: ini, end: fim }));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(calc); };
    calc();
    box.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => { box.removeEventListener("scroll", onScroll); window.removeEventListener("resize", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [virt, items.length, density]);
  /** Leva a lista até um item fora da janela e foca a linha quando ela aparecer. */
  function revelarLinha(id: string) {
    const box = scrollBodyRef.current, tb = tbodyRef.current;
    const idx = items.findIndex((it) => it.data.id === id);
    if (!box || !tb || idx < 0) return;
    const topo = tb.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, topo + idx * alturaLinha.current - box.clientHeight / 2);
    box.dispatchEvent(new Event("scroll"));
    let tentativas = 0;
    const focar = () => {
      const el = rowRefs.current.get(id);
      if (el) el.focus({ preventScroll: true });
      else if (++tentativas < 60) setTimeout(focar, 16);
    };
    setTimeout(focar, 0);
  }

  // Seleção única para pastas e documentos (ids não colidem).
  const docIdSet = new Set(documents.map((d) => d.id));
  const selDocIds = [...selected].filter((id) => docIdSet.has(id));
  const selFolders = folders.filter((f) => selected.has(f.id));

  // Clique em documento — Shift estende o intervalo a partir do último item
  // focado, Ctrl/Cmd alterna a seleção individual, clique simples troca a
  // seleção pra só esse item (padrão Finder/Explorer, "inviolável" — consenso
  // de 5 fontes independentes no ADENDO-09 §13.2).
  function selectDocClick(e: React.MouseEvent, id: string) {
    // Toque longo (handleTouchStart) já tratou a seleção pro mobile — o
    // "click" sintético que o navegador dispara logo depois do touchend não
    // deve sobrescrever com seleção de item único.
    if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
    // Abaixo de 1024 px (sem painel lateral), um toque/clique abre o documento
    // e a seleção vira modo explícito: "Selecionar vários" ou toque longo
    // (J1-03). Ctrl/Shift continuam selecionando.
    if (!isDesktop && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (selectionMode) { toggleSelect(id); setFocusedId(id); return; }
      const pasta = folders.find((f) => f.id === id);
      if (pasta) { openFolder(pasta); return; }
      const doc = documents.find((d) => d.id === id);
      if (doc) { setFocusedId(id); setPreviewDoc(doc); }
      return;
    }
    const ids = items.map((it) => it.data.id);
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
      setDetailDoc(doc ?? null);
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
    <div className="flex h-full min-h-0">
      {/* Main area — o vidro/blur (ADR-017: blur raso, sem re-render no scroll)
          agora vive no wrapper externo, compartilhado com a sidebar. */}
      <div ref={tableWrapRef} className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Barra de ferramentas da janela (Finder no macOS 27): voltar e
            avançar, nome da pasta, visualização, organizar, nova pasta, enviar
            e o filtro em pílula no lugar da busca geral. No celular, o título
            grande com o caminho embaixo. */}
        <div className="px-4 md:p-0">
          <PageHeader
            title={breadcrumbs[breadcrumbs.length - 1].name}
            subtitle={breadcrumbs.length > 1 ? breadcrumbs.slice(0, -1).map((b) => b.name).join(" › ") : current?.name}
            leading={
              <ToolbarGroup label="Navegação">
                <ToolbarButton inGroup label="Voltar" onClick={goBack} disabled={!canGoBack}><ChevronLeft aria-hidden /></ToolbarButton>
                <ToolbarButton inGroup label="Avançar" onClick={goForward} disabled={!canGoForward}><ChevronRight aria-hidden /></ToolbarButton>
              </ToolbarGroup>
            }
            titleAccessory={currentPrivacy !== "normal" ? (
              <span title={currentPrivacy === "sensivel" ? "Dado sensível (LGPD): link público bloqueado" : "Dado pessoal (LGPD)"}
                className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-mac-caption2 font-semibold ${currentPrivacy === "sensivel" ? "bg-(--tint-danger) text-(--chip-danger-text)" : "bg-(--tint-warning) text-(--chip-warning-text)"}`}>
                <ShieldAlert className="w-3 h-3" aria-hidden />{PRIVACY_LABEL[currentPrivacy]}
              </span>
            ) : undefined}
            search={
              <ToolbarSearchField
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
                onClear={() => setFilterQuery("")}
                placeholder="Filtrar nesta pasta"
                aria-label="Filtrar nesta pasta"
                widthClass="w-[180px] lg:w-[220px]"
              />
            }
            mobileActions={
              <>
                <ToolbarButton label="Mais ações" aria-haspopup="menu" onClick={(e) => setMobileMenu(e.currentTarget)}><MoreHorizontal aria-hidden /></ToolbarButton>
                <ToolbarButton prominent label="Enviar documentos" onClick={() => setShowUpload(true)} disabled={!canWrite}><Upload aria-hidden /></ToolbarButton>
              </>
            }
            mobileBelow={breadcrumbs.length > 1 ? (
              <nav aria-label="Caminho" className="mt-2 flex items-center gap-1 overflow-x-auto text-[15px]">
                {breadcrumbs.map((crumb, i) => (
                  <span key={crumb.id ?? "raiz"} className="flex shrink-0 items-center gap-1">
                    {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-(--text-tertiary)" aria-hidden />}
                    {i < breadcrumbs.length - 1 ? (
                      <button onClick={() => navigateBreadcrumb(i)} className="text-(--text-accent)">{i === 0 ? <Home className="w-4 h-4" aria-label="Documentos" /> : crumb.name}</button>
                    ) : (
                      <span className="font-medium text-(--text-primary)">{crumb.name}</span>
                    )}
                  </span>
                ))}
              </nav>
            ) : undefined}
          >
            <ToolbarGroup label="Visualização">
              <ToolbarButton inGroup selected={viewMode === "grid"} label="Ícones" onClick={() => setView("grid")}><LayoutGrid aria-hidden /></ToolbarButton>
              <ToolbarButton inGroup selected={viewMode === "list"} label="Lista" onClick={() => setView("list")}><List aria-hidden /></ToolbarButton>
            </ToolbarGroup>
            <ToolbarGroup label="Organizar">
              <ToolbarButton inGroup selected={selectionMode} label={selectionMode ? "Sair do modo de seleção" : "Selecionar vários"} onClick={() => setSelectionMode((v) => !v)}>
                <ListChecks aria-hidden />
              </ToolbarButton>
              <ToolbarButton inGroup label="Ordenação, colunas e densidade" aria-haspopup="menu" onClick={(e) => setViewMenu(e.currentTarget)}>
                {density === "compact" ? <Rows4 aria-hidden /> : <Rows3 aria-hidden />}
              </ToolbarButton>
              <ToolbarButton inGroup label="Nova pasta (Ctrl+Shift+N)" onClick={createFolderInline} disabled={!canWrite}>
                <FolderPlus aria-hidden />
              </ToolbarButton>
            </ToolbarGroup>
            <ToolbarButton prominent label="Enviar documentos" onClick={() => setShowUpload(true)} disabled={!canWrite}>
              <Upload aria-hidden />
            </ToolbarButton>
          </PageHeader>
          {viewMenu && (
            <Menu
              anchor={viewMenu}
              label="Colunas e densidade"
              onClose={() => setViewMenu(null)}
              items={[
                ...OPT_COLS.map((c) => ({ label: c.menu, checked: visibleCols.includes(c.key), onSelect: () => toggleCol(c.key) })),
                ...([["name", "Ordenar por nome"], ["created_at", "Ordenar por criação"], ["updated_at", "Ordenar por modificação"], ["size", "Ordenar por tamanho"], ["kind", "Ordenar por tipo"]] as [SortKey, string][])
                  .map(([k, l], i) => ({ label: l, checked: sort.key === k, separatorBefore: i === 0, onSelect: () => setSortTo(k, sort.key === k ? sort.dir : "asc") })),
                { label: "Ordem decrescente", checked: sort.dir === "desc", onSelect: () => setSortTo(sort.key, sort.dir === "desc" ? "asc" : "desc") },
                { label: "Linhas compactas", checked: density === "compact", onSelect: () => chooseDensity("compact"), separatorBefore: true },
                { label: "Linhas confortáveis", checked: density === "comfortable", onSelect: () => chooseDensity("comfortable") },
                { label: "Linhas espaçosas", checked: density === "spacious", onSelect: () => chooseDensity("spacious") },
                ...([["", "Sem agrupar"], ["kind", "Agrupar por tipo"], ["uploader", "Agrupar por quem enviou"], ...resolvedFields.map((f) => [`field:${f.custom_field_id}`, `Agrupar por ${f.label}`])] as [string, string][])
                  .map(([k, l], i) => ({ label: l, checked: groupBy === k, separatorBefore: i === 0, onSelect: () => setGroupBy(k) })),
                ...savedViews.map((v, i) => ({ label: `Vista: ${v.name}${v.folder_id ? "" : " (todas as pastas)"}${v.mine && !v.shared ? " · só você" : ""}`, separatorBefore: i === 0, onSelect: () => applyView(v) })),
                { label: "Salvar vista atual…", separatorBefore: savedViews.length === 0, onSelect: () => setSavingView(true) },
                ...savedViews.filter((v) => v.mine || canAdmin).map((v) => ({ label: `Apagar vista "${v.name}"`, danger: true, onSelect: () => deleteView(v) })),
                { label: "Voltar ao padrão", onSelect: () => { resetCols(); chooseDensity("comfortable"); setGroupBy(""); setFieldFilter(null); }, separatorBefore: true },
              ]}
            />
          )}
          {mobileMenu && (
            <Menu
              anchor={mobileMenu}
              align="end"
              label="Mais ações"
              onClose={() => setMobileMenu(null)}
              items={[
                { label: selectionMode ? "Sair da seleção" : "Selecionar vários", icon: <ListChecks />, onSelect: () => setSelectionMode((v) => !v) },
                { label: "Nova pasta", icon: <FolderPlus />, disabled: !canWrite, onSelect: createFolderInline },
                { label: viewMode === "list" ? "Ver em ícones" : "Ver em lista", icon: viewMode === "list" ? <LayoutGrid /> : <List />, onSelect: () => setView(viewMode === "list" ? "grid" : "list") },
                { label: density === "comfortable" ? "Linhas compactas" : "Linhas confortáveis", icon: density === "comfortable" ? <Rows4 /> : <Rows3 />, onSelect: () => toggleDensity() },
              ]}
            />
          )}
        </div>

        {/* File list — pb extra no mobile e no desktop (lg+): essa página cancela o
            padding vertical do AppShell (-my-6), então precisa da própria folga pra não
            ficar atrás da barra inferior mobile nem da borda da janela no desktop */}
        <div
          ref={scrollBodyRef}
          className="flex-1 overflow-y-auto pb-6 relative"
          onMouseDown={handleBodyMouseDown}
        >
          {/* Triagem (B1.1.8): só aparece quando a pasta aberta é a "Entrada" da empresa. */}
          {current && currentFolderId && !loading && <InboxPanel companyId={current.id} folderId={currentFolderId} onMoved={load} />}
          {loading ? (
            // Abaixo de 200ms não mostra nada (regra dos 200ms) — só depois
            // disso o skeleton aparece, já na forma exata do que vai substituir.
            showSkeleton ? (
              viewMode === "grid" ? (
                <div className="p-4 grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1">
                  {Array.from({ length: 12 }).map((_, i) => <SkeletonGridItem key={i} />)}
                </div>
              ) : (
                <table className={`w-full table-auto sm:table-fixed select-none ${DENSITY_PAD[density]}`}>
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
                <div className="w-11 h-11 rounded-full bg-(--tint-warning) flex items-center justify-center">
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
            <div key={`grade-${currentFolderId}`} role="listbox" aria-multiselectable="true" aria-label={`Conteúdo de ${breadcrumbs[breadcrumbs.length - 1].name}`} className="p-4 space-y-4 page-enter">
              {(["folder", "document"] as const).map((sec) => {
                const lista = items.filter((it) => it.kind === sec);
                if (!lista.length) return null;
                const ambos = items.some((it) => it.kind === "folder") && items.some((it) => it.kind === "document");
                return (
              <div key={sec} role="group" aria-label={sec === "folder" ? "Pastas" : "Documentos"}>
                {ambos && (
                  <p aria-hidden="true" className="px-2 pb-1.5 text-mac-caption font-semibold text-(--text-secondary)">
                    {sec === "folder" ? "Pastas" : "Documentos"} <span className="font-normal text-(--text-tertiary)">{lista.length.toLocaleString("pt-BR")}</span>
                  </p>
                )}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-1 gap-y-2">
              {lista.map((item) => {
                if (item.kind === "folder") {
                  const f = item.data;
                  const isDropTarget = dragOverFolderId === f.id;
                  return (
                    <div
                      key={`folder-${f.id}`}
                      ref={(el) => { if (el) rowRefs.current.set(f.id, el); else rowRefs.current.delete(f.id); }}
                      role="option"
                      aria-selected={selected.has(f.id)}
                      aria-label={`Pasta ${f.name}`}
                      tabIndex={focusedId === f.id || (!focusedId && items[0]?.data.id === f.id) ? 0 : -1}
                      onFocus={() => setFocusedId(f.id)}
                      className={`group relative flex flex-col items-center gap-1 py-2 px-1.5 rounded-(--radius-sm) cursor-default outline-none focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${isDropTarget ? "spring-target bg-(--control-fill)" : ""} ${dragFolderIds?.includes(f.id) ? "opacity-40" : ""} ${droppedOn === f.id ? "drop-pulse" : ""}`}
                      onClick={(e) => selectDocClick(e, f.id)}
                      onDoubleClick={() => openFolder(f)}
                      onContextMenu={(e) => openContextMenu(e, "folder", f)}
                      onMouseEnter={() => hoverFolder(f.id)}
                      onMouseLeave={leaveFolder}
                      onTouchStart={(e) => handleTouchStart(e, f.id)}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleTouchEnd}
                      draggable={!(renaming?.kind === "folder" && renaming.id === f.id) && canAdmin}
                      onDragStart={(e) => startItemDrag(e, f.id, f.name)}
                      onDragEnd={endItemDrag}
                      onDragOver={(e) => {
                        if (!dragDocIds && !dragFolderIds) return;
                        if (dragFolderIds?.includes(f.id)) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = e.altKey && !dragFolderIds ? "copy" : "move";
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
                        dropOnFolder(f, e.altKey);
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
                      <span className={`flex h-[80px] items-end justify-center rounded-(--radius-control) px-1.5 pb-1 ${selected.has(f.id) || isDropTarget ? "bg-(--control-fill)" : ""}`} aria-hidden>
                        <MacFolderIcon className="w-[72px] h-[58px]" open={isDropTarget} />
                      </span>
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
                          className="w-full h-6 px-1 text-mac-caption text-center mac-field reveal rounded-(--radius-badge) text-(--text-primary)"
                        />
                      ) : (
                        <span className={`max-w-full px-1.5 py-px rounded-(--radius-badge) text-[12px] leading-[15px] font-medium text-center line-clamp-2 ${selected.has(f.id) ? "bg-(--selection-bg) text-(--selection-text)" : "text-(--text-primary)"}`}>{f.name}</span>
                      )}
                    </div>
                  );
                }

                const d = item.data;
                const isSelected = selected.has(d.id);
                const isDragging = dragDocIds?.includes(d.id) ?? false;
                const isRenamingDoc = renaming?.kind === "document" && renaming.id === d.id;
                return (
                  <div
                    key={`doc-${d.id}`}
                    ref={(el) => { if (el) rowRefs.current.set(d.id, el); else rowRefs.current.delete(d.id); }}
                    role="option"
                    aria-selected={isSelected}
                    aria-label={d.name}
                    tabIndex={focusedId === d.id || (!focusedId && items[0]?.data.id === d.id) ? 0 : -1}
                    onFocus={() => setFocusedId(d.id)}
                    className={`group relative flex flex-col items-center gap-1 py-2 px-1.5 rounded-(--radius-sm) cursor-default outline-none [content-visibility:auto] [contain-intrinsic-size:auto_132px] focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${isDragging ? "opacity-40" : ""}`}
                    onClick={(e) => selectDocClick(e, d.id)}
                    onDoubleClick={() => setPreviewDoc(d)}
                    onContextMenu={(e) => openContextMenu(e, "document", d)}
                    onTouchStart={(e) => handleTouchStart(e, d.id)}
                    onTouchMove={handleTouchMove}
                    onTouchEnd={handleTouchEnd}
                    draggable={!isRenamingDoc}
                    onDragStart={(e) => startItemDrag(e, d.id, d.name)}
                    onDragEnd={endItemDrag}
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
                      className="absolute top-1 right-1 flex sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 items-center justify-center rounded-full transition-all duration-fast z-10 text-(--text-secondary) hover:bg-(--control-fill)"
                    >
                      <MoreHorizontal className="w-4 h-4" aria-hidden />
                    </button>
                    <GridThumb doc={d} selected={isSelected} />
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
                          className="w-full min-w-0 h-6 px-1 text-mac-caption text-center mac-field reveal rounded-(--radius-badge) text-(--text-primary)"
                        />
                        <span className="text-mac-caption text-(--text-tertiary) shrink-0">{splitExt(d.name)[1]}</span>
                      </div>
                    ) : (
                      // Nome em até duas linhas sem perder a extensão (A4-21): a base corta
                      // com reticências e a extensão fica sempre visível embaixo.
                      <span className={`max-w-full px-1.5 py-px rounded-(--radius-badge) text-[12px] leading-[15px] font-medium text-center ${isSelected ? "bg-(--selection-bg) text-(--selection-text)" : "text-(--text-primary)"}`} title={d.name}>
                        <span className="line-clamp-2 break-words [hyphens:none]">{d.name}</span>
                      </span>
                    )}
                  </div>
                );
              })}
              </div>
              </div>
                );
              })}
            </div>
          ) : (
            // overflow-x-auto: com colunas redimensionáveis (table-fixed) a soma das
            // larguras pode passar do viewport no mobile — rola em vez de cortar/quebrar.
            <div key={`lista-${currentFolderId}`} className="overflow-x-auto page-enter">
            <table
              role="grid"
              aria-label={`Conteúdo de ${breadcrumbs[breadcrumbs.length - 1].name}`}
              aria-multiselectable="true"
              aria-rowcount={folders.length + total + 1}
              className={`finder-table w-full table-auto sm:table-fixed select-none ${DENSITY_PAD[density]}`}
            >
              <colgroup>
                {selectionMode && <col style={{ width: 40 }} />}
                <col style={{ width: colWidths.name }} />
                {shownCols.map((c) => (
                  <col key={c.key} className={c.colCls} style={{ width: colWidths[c.key] }} />
                ))}
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
              <thead
                className="sticky top-0 z-[2] bg-(--window-bg) shadow-(--shadow-separator)"
                onContextMenu={(e) => { e.preventDefault(); setViewMenu({ x: e.clientX, y: e.clientY }); }}
              >
                <tr>
                  {selectionMode && (
                    <th className="w-10 px-4 py-2 text-left">
                      <Checkbox
                        checked={selected.size === items.length && items.length > 0}
                        indeterminate={selected.size > 0 && selected.size < items.length}
                        onChange={selectAll}
                        aria-label="Selecionar tudo o que está visível"
                      />
                    </th>
                  )}
                  <SortableHeader
                    label="Nome" sortKey="name" sort={sort} onSort={toggleSort}
                    onResizeStart={(e) => startColResize("name", e)}
                    onResizeReset={() => autoFitCol("name")} onResizeNudge={(d) => nudgeColWidth("name", d)} width={colWidths.name}
                  />
                  {/* Ordem das colunas (regra da pesquisa): o que identifica o
                      arquivo primeiro, estado (OCR) por último. Clique direito no
                      cabeçalho escolhe as colunas (A4-16). */}
                  {shownCols.map((c) => (
                    <SortableHeader
                      key={c.key}
                      label={c.label} sortKey={c.sortKey} sort={sort} onSort={toggleSort}
                      className={c.cls} align={c.align}
                      onResizeStart={(e) => startColResize(c.key, e)}
                      onResizeReset={() => autoFitCol(c.key)} onResizeNudge={(d) => nudgeColWidth(c.key, d)} width={colWidths[c.key]}
                    />
                  ))}
                  {resolvedFields.map((f) => {
                    const k = `field:${f.custom_field_id}` as SortKey;
                    return (
                      <th key={f.custom_field_id} className="px-3 py-2 text-mac-caption font-normal text-(--text-secondary) text-left truncate hidden sm:table-cell"
                        aria-sort={sort.key === k ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" onClick={() => toggleSort(k)} className="inline-flex items-center gap-1 hover:text-(--text-primary) focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) rounded-sm">
                          {f.label}{f.required && <span className="text-(--text-danger)">*</span>}
                          {sort.key === k && <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span>}
                        </button>
                      </th>
                    );
                  })}
                  <th className="w-[76px]"><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody ref={tbodyRef}>
                {virt && janela.start > 0 && <tr aria-hidden="true" style={{ height: janela.start * alturaLinha.current }} />}
                {items.map((item, idx) => {
                  if (virt && (idx < janela.start || idx >= janela.end)) return null;
                  if (item.kind === "folder") {
                    const f = item.data;
                    const isDropTarget = dragOverFolderId === f.id;
                    const isFolderSel = selected.has(f.id);
                    const isRenamingFolder = renaming?.kind === "folder" && renaming.id === f.id;
                    const expanded = expandedFolders[f.id];
                    const nestedColSpan = (selectionMode ? 1 : 0) + 2 + shownCols.length + resolvedFields.length;
                    return (
                      <Fragment key={`folder-${f.id}`}>
                      <tr
                        ref={(el) => { if (el) rowRefs.current.set(f.id, el); else rowRefs.current.delete(f.id); }}
                        tabIndex={focusedId === f.id || (!focusedId && items[0]?.data.id === f.id) ? 0 : -1}
                        aria-label={`Pasta ${f.name}`}
                        aria-selected={isFolderSel}
                        onFocus={() => setFocusedId(f.id)}
                        data-drop={isDropTarget || undefined}
                        className={`group cursor-default outline-none ${isDropTarget ? "spring-target" : ""} ${dragFolderIds?.includes(f.id) ? "opacity-40" : ""} ${droppedOn === f.id ? "drop-pulse" : ""}`}
                        onClick={(e) => selectDocClick(e, f.id)}
                        onDoubleClick={() => openFolder(f)}
                        onContextMenu={(e) => openContextMenu(e, "folder", f)}
                        onMouseEnter={() => hoverFolder(f.id)}
                        onMouseLeave={leaveFolder}
                        onTouchStart={(e) => handleTouchStart(e, f.id)}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                        draggable={!isRenamingFolder && canAdmin}
                        onDragStart={(e) => startItemDrag(e, f.id, f.name)}
                        onDragEnd={endItemDrag}
                        onDragOver={(e) => {
                          if (!dragDocIds && !dragFolderIds) return;
                          if (dragFolderIds?.includes(f.id)) return;
                          e.preventDefault();
                          e.dataTransfer.dropEffect = e.altKey && !dragFolderIds ? "copy" : "move";
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
                          dropOnFolder(f, e.altKey);
                        }}
                      >
                        {selectionMode && (
                          <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                            <Checkbox checked={isFolderSel} onChange={() => toggleSelect(f.id)} aria-label={`Selecionar a pasta ${f.name}`} />
                          </td>
                        )}
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
                              className="w-full max-w-[280px] h-7 px-2 text-mac-body mac-field reveal rounded-(--radius-control) text-(--text-primary)"
                            />
                          ) : (
                            <div className="flex items-center gap-1">
                              {/* Triângulo de disclosure — expande a subpasta inline sem
                                  navegar pra dentro dela, igual Finder/Explorer em lista. */}
                              <button
                                onClick={(e) => toggleExpandFolder(e, f.id)}
                                className={`p-0.5 -ml-1 rounded shrink-0 ${isFolderSel ? "text-white/80 hover:text-white" : "text-(--text-tertiary) hover:text-(--text-primary)"}`}
                                title={expanded ? "Recolher" : "Expandir"}
                                aria-label={`${expanded ? "Recolher" : "Expandir"} ${f.name}`}
                                aria-expanded={!!expanded}
                              >
                                <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-fast ${expanded ? "rotate-90" : ""}`} />
                              </button>
                              {/* Clique seleciona, duplo clique ou Enter abre (igual à grade e ao Finder); no celular, o toque abre. */}
                              <span className={`flex items-center gap-2 text-mac-body min-w-0 ${isFolderSel ? "text-white" : "text-(--text-primary)"}`}>
                                <MacFolderIcon className="w-[18px] h-[15px] shrink-0" />
                                <span className="truncate">{f.name}</span>
                              </span>
                            </div>
                          )}
                        </td>
                        {shownCols.map((c) => (
                          <td key={c.key} className={`px-3 py-2 text-mac-caption ${isFolderSel ? "text-white/80" : "text-(--text-tertiary)"} ${c.cls} ${c.align === "right" ? "text-right" : ""}`}>
                            {c.key === "kind" ? "Pasta" : c.key === "ocr" ? null : "—"}
                          </td>
                        ))}
                        {resolvedFields.map((rf) => (
                          <td key={rf.custom_field_id} className="px-3 py-2 text-mac-caption text-(--text-tertiary) hidden sm:table-cell">—</td>
                        ))}
                        <td className="px-2 py-2 text-right">
                          <button
                            onClick={(e) => { e.stopPropagation(); openMenuAt(e.currentTarget, "folder", f); }}
                            aria-label={`Ações da pasta ${f.name}`}
                            aria-haspopup="menu"
                            className={`opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100 w-7 h-7 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-full transition-all duration-fast ${isFolderSel ? "text-white hover:bg-white/20" : "text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover)"}`}
                          >
                            <MoreHorizontal className="w-4 h-4" aria-hidden />
                          </button>
                        </td>
                      </tr>
                      {expanded === "loading" && (
                        <tr className="border-b border-(--border-default)">
                          <td colSpan={nestedColSpan} className="px-3 py-2 pl-10" aria-label="Carregando o conteúdo da pasta">
                            <div className="space-y-2" aria-hidden>
                              <div className="h-3.5 w-48 rounded bg-(--bg-hover) animate-pulse" />
                              <div className="h-3.5 w-36 rounded bg-(--bg-hover) animate-pulse" />
                            </div>
                          </td>
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
                          className="reveal cursor-default"
                          onClick={() => openFolder(nf)}
                        >
                          {selectionMode && <td className="px-4 py-2" />}
                          <td className="px-3 py-2 pl-10">
                            <div className="flex items-center gap-2 text-mac-body text-(--text-secondary)">
                              <MacFolderIcon className="w-[18px] h-[15px] shrink-0 opacity-80" />
                              <span className="truncate">{nf.name}</span>
                            </div>
                          </td>
                          {shownCols.map((c) => (
                            <td key={c.key} className={`px-3 py-2 text-mac-caption text-(--text-tertiary) ${c.cls} ${c.align === "right" ? "text-right" : ""}`}>
                              {c.key === "kind" ? "Pasta" : c.key === "ocr" ? null : "—"}
                            </td>
                          ))}
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
                            className="reveal cursor-default"
                            onClick={() => setDetailDoc(nd)}
                          >
                            {selectionMode && <td className="px-4 py-2" />}
                            <td className="px-3 py-2 pl-10">
                              <div className="flex items-center gap-2 text-mac-body text-(--text-secondary) min-w-0">
                                <NIcon className={`w-3.5 h-3.5 shrink-0 ${ns.iconColor} ${ns.fillColor} opacity-70`} />
                                <span className="truncate">{nd.name}</span>
                              </div>
                            </td>
                            {shownCols.map((c) => (
                              <td key={c.key} className={`px-3 py-2 text-mac-caption text-(--text-tertiary) truncate ${c.cls} ${c.align === "right" ? "text-right tabular-nums" : ""}`}>
                                {c.key === "created" ? fmtDate(nd.created_at)
                                  : c.key === "updated" ? fmtDate(nd.updated_at ?? nd.created_at)
                                  : c.key === "uploader" ? (nd.uploaded_by_name ?? "—")
                                  : c.key === "size" ? fmtSize(nd.size_bytes)
                                  : c.key === "kind" ? kindLabel(nd.name)
                                  : <OcrIcon status={nd.ocr_status} />}
                              </td>
                            ))}
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
                  const grupo = groupBy ? groupLabel(d) : null;
                  const prev = idx > 0 ? items[idx - 1] : null;
                  const novoGrupo = grupo !== null && (!prev || prev.kind !== "document" || groupLabel(prev.data) !== grupo);
                  return (
                    <Fragment key={`doc-${d.id}`}>
                    {novoGrupo && (
                      <tr className="finder-group">
                        <th scope="colgroup" colSpan={(selectionMode ? 1 : 0) + 2 + shownCols.length + resolvedFields.length}
                          className="pl-4 pr-3 pt-5 pb-1.5 text-left text-[11px] font-bold text-(--text-secondary)">
                          {grupo} <span className="font-normal text-(--text-tertiary)">· {visibleDocuments.filter((x) => groupLabel(x) === grupo).length}</span>
                        </th>
                      </tr>
                    )}
                    <tr
                      data-linha
                      ref={(el) => { if (el) rowRefs.current.set(d.id, el); else rowRefs.current.delete(d.id); }}
                      tabIndex={focusedId === d.id || (!focusedId && items[0]?.data.id === d.id) ? 0 : -1}
                      aria-selected={isSelected}
                      onFocus={() => setFocusedId(d.id)}
                      className={`group cursor-default outline-none ${isDragging ? "opacity-40" : ""}`}
                      onClick={(e) => selectDocClick(e, d.id)}
                      onDoubleClick={() => setPreviewDoc(d)}
                      onContextMenu={(e) => openContextMenu(e, "document", d)}
                      onTouchStart={(e) => handleTouchStart(e, d.id)}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleTouchEnd}
                      draggable={!isRenaming}
                      onDragStart={(e) => startItemDrag(e, d.id, d.name)}
                      onDragEnd={endItemDrag}
                    >
                      {selectionMode && (
                        <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                          <Checkbox checked={isSelected} onChange={() => toggleSelect(d.id)} aria-label={`Selecionar ${d.name}`} />
                        </td>
                      )}
                      <td className="px-3 py-2" data-col="name">
                        <div className="flex items-center gap-2">
                          {(() => { const Icon = getFileStyle(d.name).icon; return <Icon className="w-[18px] h-[18px] shrink-0" aria-hidden />; })()}
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
                                className="h-7 px-2 text-mac-body mac-field reveal rounded-(--radius-control) text-(--text-primary) flex-1 min-w-0"
                              />
                              <span className="text-mac-body text-(--text-tertiary) shrink-0">{splitExt(d.name)[1]}</span>
                            </div>
                          ) : (
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <TruncatedFileName
                                  name={d.name}
                                  className={`text-mac-body ${isSelected ? "text-white" : "text-(--text-primary)"}`}
                                  inverted={isSelected}
                                />
                                {missingRequired.has(d.id) && (
                                  <span className={`shrink-0 inline-flex ${isSelected ? "text-white" : "text-(--text-warning)"}`} title={`Falta preencher: ${missingRequired.get(d.id)!.join(", ")}`}>
                                    <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                                    <span className="sr-only">Falta preencher: {missingRequired.get(d.id)!.join(", ")}</span>
                                  </span>
                                )}
                              </div>
                              {/* Celular: data, tamanho e situação do texto sob o nome (A4-17). */}
                              <span className={`sm:hidden block text-mac-caption truncate ${isSelected ? "text-white/85" : "text-(--text-secondary)"}`}>
                                {fmtDate(d.created_at)} · {fmtSize(d.size_bytes)}{d.ocr_status === "failed" ? " · texto não lido" : ""}
                              </span>
                              {/* Falha de leitura chama atenção e oferece a ação na própria linha (A4-19). */}
                              {d.ocr_status === "failed" && canWrite && recursos.ocr && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); retryOcr(d); }}
                                  className={`hidden sm:inline-flex items-center gap-1 text-mac-caption hover:underline ${isSelected ? "text-white" : "text-(--text-danger)"}`}
                                >
                                  <AlertCircle className="w-3 h-3" aria-hidden /> Texto não lido · Ler de novo
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                      {shownCols.map((c) => (
                        <td key={c.key} data-col={c.key}
                          className={`px-3 py-2 text-mac-caption truncate ${c.cls} ${c.align === "right" ? "text-right tabular-nums" : ""} ${isSelected ? "text-white/90" : "text-(--text-secondary)"}`}
                          title={c.key === "created" && d.uploaded_by_name ? `Enviado por ${d.uploaded_by_name}` : undefined}>
                          {c.key === "created" ? fmtDate(d.created_at)
                            : c.key === "updated" ? fmtDate(d.updated_at ?? d.created_at)
                            : c.key === "uploader" ? (d.uploaded_by_name ?? "—")
                            : c.key === "size" ? fmtSize(d.size_bytes)
                            : c.key === "kind" ? kindLabel(d.name)
                            : <OcrIcon status={d.ocr_status} inverted={isSelected} />}
                        </td>
                      ))}
                      {resolvedFields.map((rf) => {
                        const value = fieldValues[d.id]?.[rf.custom_field_id];
                        return (
                          <td key={rf.custom_field_id} className="px-3 py-2 text-mac-caption truncate hidden sm:table-cell">
                            {value ? (
                              <button type="button" title={`Mostrar só ${rf.label} = ${value}`}
                                onClick={(e) => { e.stopPropagation(); setFieldFilter({ id: rf.custom_field_id, label: rf.label, value }); }}
                                className={`max-w-full truncate hover:underline focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) rounded-sm ${isSelected ? "text-white/90" : "text-(--text-secondary)"}`}>{value}</button>
                            ) : rf.required ? (
                              <span className={isSelected ? "text-white" : "text-(--text-warning)"} title="Campo obrigatório sem preenchimento">Pendente</span>
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
                    </Fragment>
                  );
                })}
                {virt && janela.end < items.length && <tr aria-hidden="true" style={{ height: (items.length - janela.end) * alturaLinha.current }} />}
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
              className="absolute border border-(--text-secondary)/50 bg-(--text-secondary)/10 pointer-events-none z-20 rounded-(--radius-hair)"
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
                  onDragOver={(e) => {
                    if (idx === breadcrumbs.length - 1 || (!dragDocIds && !dragFolderIds)) return;
                    if (idx === 0 && dragDocIds) return; // documento sempre fica numa pasta
                    e.preventDefault();
                    e.dataTransfer.dropEffect = e.altKey && !dragFolderIds ? "copy" : "move";
                    setDragOverFolderId(`crumb-${idx}`);
                  }}
                  onDragLeave={() => setDragOverFolderId((v) => (v === `crumb-${idx}` ? null : v))}
                  onDrop={(e) => { e.preventDefault(); dropOnTarget({ id: crumb.id ?? null, name: idx === 0 ? "Documentos" : crumb.name }, e.altKey); }}
                  className={`text-mac-caption hover:text-(--text-accent) transition-colors duration-fast rounded-(--radius-badge) px-0.5 ${dragOverFolderId === `crumb-${idx}` ? "bg-(--tint-accent) text-(--text-accent) outline-solid outline-1 outline-teal-400" : ""} ${
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
          {/* Pendentes de classificação (X2-20): filtra quem tem campo obrigatório vazio. */}
          {(missingRequired.size > 0 || onlyMissing) && (
            <button onClick={() => setOnlyMissing((v) => !v)} aria-pressed={onlyMissing}
              className={`shrink-0 ml-2 inline-flex items-center gap-1 rounded-full px-2 min-h-6 pointer-coarse:min-h-9 ${onlyMissing ? "bg-(--tint-warning) text-(--text-primary)" : "text-(--text-warning) hover:bg-(--bg-hover)"}`}>
              <AlertTriangle className="w-3 h-3" aria-hidden />
              {onlyMissing ? "Mostrar todos" : `${missingRequired.size} com campo obrigatório vazio`}
            </button>
          )}
          {/* Metadado navegável (B1.2.7): clicar num valor da coluna filtra; aqui limpa. */}
          {fieldFilter && (
            <button onClick={() => setFieldFilter(null)} aria-label={`Tirar o filtro ${fieldFilter.label} = ${fieldFilter.value}`}
              className="shrink-0 ml-2 inline-flex items-center gap-1 rounded-full px-2 min-h-6 pointer-coarse:min-h-9 bg-(--tint-accent) text-(--text-primary) hover:bg-(--accent)/25">
              {fieldFilter.label} = {fieldFilter.value} <X className="w-3 h-3" aria-hidden />
            </button>
          )}
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
          path={`${current.name} › ${breadcrumbs.slice(1).map((b) => b.name).join(" › ") || "Documentos"}`}
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
          onClose={() => { setShowUpload(false); setSharedFiles(undefined); }}
          onDone={load}
          initialFiles={sharedFiles}
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
      {semAcesso && (
        <Dialog onClose={() => setSemAcesso(null)} title="Pasta sem acesso" size="sm">
          <RequestAccessBanner folderId={semAcesso} onClose={() => setSemAcesso(null)} />
        </Dialog>
      )}
      {requestingFolder && current && (
        <RequestFilesModal companyId={current.id} folder={requestingFolder} onClose={() => setRequestingFolder(null)} />
      )}
      {showTreeDrawer && current && (
        <Dialog onClose={() => setShowTreeDrawer(false)} title="Pastas" size="sm" bodyClassName="px-2 py-2">
          <button
            onClick={() => { navigateHome(); setShowTreeDrawer(false); }}
            className={`w-full flex items-center gap-1.5 h-9 pointer-coarse:h-11 pl-3 pr-2 text-mac-body rounded-(--radius-control) text-left ${currentFolderId === null ? "bg-(--tint-accent) text-(--text-accent) font-medium" : "text-(--text-primary) hover:bg-(--bg-hover)"}`}
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
      {picker && current && picker.kind === "selection" && (
        <FolderPickerDialog
          companyId={current.id}
          title={`Mover ${plural(picker.docIds.length + picker.folders.length, "item", "itens")} para…`}
          confirmLabel="Mover aqui"
          allowRoot={picker.docIds.length === 0}
          excludeSubtreeOf={picker.folders.map((f) => f.id)}
          disabledIds={currentFolderId ? [currentFolderId] : []}
          initialId={currentFolderId}
          onPick={async (f) => {
            const { docIds, folders: fs } = picker;
            setPicker(null);
            if (docIds.length && f.id) await moveDocuments(docIds, f.id, f.name);
            if (fs.length) await moveFoldersTo(fs, f);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {confirmBulkDelete && (
        <ConfirmModal
          title={`Excluir ${plural(selFolders.length + selDocIds.length, "item", "itens")}?`}
          description={`${plural(selFolders.length, "pasta vai", "pastas vão")} para a lixeira com tudo o que há dentro${selDocIds.length ? `, junto com ${plural(selDocIds.length, "documento", "documentos")}` : ""}. Dá para desfazer logo em seguida ou restaurar pela Lixeira.`}
          confirmLabel="Excluir"
          danger
          onConfirm={deleteSelectedConfirmed}
          onClose={() => setConfirmBulkDelete(false)}
        />
      )}
      {picker && current && picker.kind !== "selection" && (
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
      {privacyFolder && (
        <PrivacyDialog folderId={privacyFolder.id} folderName={privacyFolder.name} onClose={() => setPrivacyFolder(null)}
          onSaved={() => { if (currentFolderId) api.get(`/folders/${currentFolderId}/privacy`).then((r) => setCurrentPrivacy(r.data.effective ?? "normal")).catch(() => {}); }} />
      )}
      {savingView && <SaveViewDialog folderName={breadcrumbs[breadcrumbs.length - 1].name} onClose={() => setSavingView(false)} onSave={saveView} />}
      {savingTemplate && current && (
        <SaveTemplateDialog companyId={current.id} folder={savingTemplate} onClose={() => setSavingTemplate(null)} />
      )}
      {applyingTemplate && current && (
        <ApplyTemplateDialog companyId={current.id} folder={applyingTemplate} onClose={() => setApplyingTemplate(null)}
          onDone={() => { setFolderTreeVersion((v) => v + 1); load(); }} />
      )}
      {newFromTemplate && current && (
        <NewFromTemplateDialog companyId={current.id} folder={newFromTemplate} onClose={() => setNewFromTemplate(null)}
          onDone={() => { if (newFromTemplate.id === currentFolderId) load(); }} />
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
          onClose={() => { setPreviewDoc(null); setPreviewQuery(null); }}
          onChanged={load}
          initialQuery={previewQuery}
          origin={(() => {
            // Quick Look cresce a partir do item clicado (A5-38).
            const r = rowRefs.current.get(previewDoc.id)?.getBoundingClientRect();
            return r && r.width ? { x: r.left + Math.min(r.width, 160) / 2, y: r.top + r.height / 2 } : null;
          })()}
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
      <div className="sr-only" aria-live="polite">{selected.size ? `${plural(selected.size, "item selecionado", "itens selecionados")}` : ""}</div>

      {/* Barra de ações em lote — flutuante; escondida, fica inerte (fora do Tab). */}
      <div
        role="toolbar"
        aria-label="Ações para os itens selecionados"
        inert={selected.size === 0}
        className={`glass-panel glass-blur-pill fixed bottom-[calc(76px+env(safe-area-inset-bottom))] md:bottom-[100px] left-1/2 flex items-center gap-1 rounded-[50px] pl-4 pr-1.5 py-1.5 shadow-(--shadow-dialog) z-30 max-w-[calc(100vw-24px)] overflow-x-auto transition-[opacity,transform] duration-normal ${
          selected.size > 0 ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        style={{ transform: selected.size > 0 ? "translateX(-50%)" : "translateX(-50%) translateY(12px)" }}
      >
        <span className="text-mac-body text-(--text-primary) mr-1 whitespace-nowrap">
          <b className="text-(--text-accent) font-semibold tabular-nums">{selected.size}</b> selecionado{selected.size !== 1 ? "s" : ""}
        </span>
        {canWrite && (selFolders.length === 0 || canAdmin) && (
          <button onClick={() => setPicker(selFolders.length ? { kind: "selection", docIds: selDocIds, folders: selFolders } : { kind: "documents", ids: selDocIds })}
            className="flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-primary) whitespace-nowrap hover:bg-(--bg-hover)">
            <FolderInput className="w-3.5 h-3.5" aria-hidden /> Mover
          </button>
        )}
        {selDocIds.length > 0 && <button onClick={() => downloadDocuments(selDocIds)}
          className="flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-primary) whitespace-nowrap hover:bg-(--bg-hover)">
          <Download className="w-3.5 h-3.5" aria-hidden /> Baixar
        </button>}
        {selDocIds.length > 0 && <button onClick={() => anchorDocuments(selDocIds)}
          className="hidden sm:flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-primary) whitespace-nowrap hover:bg-(--bg-hover)">
          <Anchor className="w-3.5 h-3.5" aria-hidden /> Ancorar
        </button>}
        {resolvedFields.length > 0 && canWrite && selDocIds.length > 0 && (
          <button onClick={() => setShowBulkMetadata(true)}
            className="flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body text-(--text-primary) whitespace-nowrap hover:bg-(--bg-hover)">
            <Pencil className="w-3.5 h-3.5" aria-hidden /> Metadados
          </button>
        )}
        {canWrite && (selFolders.length === 0 || canAdmin) && (
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
          documentIds={selDocIds}
          fields={resolvedFields}
          fieldValues={fieldValues}
          companyId={current.id}
          onClose={() => setShowBulkMetadata(false)}
          onSaved={(applied) => setFieldValues((prev) => {
            const next = { ...prev };
            for (const id of selDocIds) next[id] = { ...(next[id] ?? {}), ...applied };
            return next;
          })}
        />
      )}
    </div>
  );
}
