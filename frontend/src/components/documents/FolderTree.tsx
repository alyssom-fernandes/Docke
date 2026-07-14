import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  FolderOpen,
  Folder,
  FolderPlus,
  Loader2,
} from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";

export interface FolderNode {
  id: string;
  name: string;
  parent_id: string | null;
  children?: FolderNode[];
}

interface FolderTreeProps {
  companyId: string;
  /** Currently active folder id */
  activeFolderId: string | null;
  /** Called when a folder is selected */
  onSelect: (folder: FolderNode) => void;
  /** If true, shows "Nova pasta" button at root */
  allowCreate?: boolean;
  /** Called after a folder is moved (drag-and-drop) */
  onMove?: (folderId: string, newParentId: string | null) => void;
  /** Called quando documento(s) arrastados de fora (ex: tabela principal) são
   *  soltos sobre um nó — recebe o folder de destino, os ids dos documentos e
   *  o nome do folder (útil pra mensagens de feedback sem precisar de lookup). */
  onDropDocuments?: (folderId: string, documentIds: string[], folderName: string) => void;
}

// ─── Tree builder ─────────────────────────────────────────────────────────────

function buildTree(flat: FolderNode[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  flat.forEach((f) => byId.set(f.id, { ...f, children: [] }));
  const roots: FolderNode[] = [];
  byId.forEach((node) => {
    if (node.parent_id && byId.has(node.parent_id)) {
      byId.get(node.parent_id)!.children!.push(node);
    } else {
      roots.push(node);
    }
  });
  return roots;
}

// ─── Single node ─────────────────────────────────────────────────────────────

interface NodeProps {
  node: FolderNode;
  depth: number;
  activeFolderId: string | null;
  onSelect: (f: FolderNode) => void;
  dragOverId: string | null;
  onDragStart: (id: string) => void;
  onDragOver: (id: string) => void;
  onDragLeave: () => void;
  onDrop: (targetId: string) => void;
  onDropDocuments?: (folderId: string, documentIds: string[], folderName: string) => void;
  focusedId: string | null;
  setFocusedId: (id: string) => void;
  expandedIds: Set<string>;
  toggleExpanded: (id: string) => void;
  allNodes: Map<string, FolderNode>;
}

// MIME type custom usado pra marcar um drag de documento(s) vindo da tabela
// principal — distingue de um drag de pasta-pra-pasta interno do próprio
// FolderTree, que não seta esse tipo.
const DOCUMENT_DRAG_MIME = "application/x-docke-document-ids";

function TreeNode({
  node,
  depth,
  activeFolderId,
  onSelect,
  dragOverId,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDropDocuments,
  focusedId,
  setFocusedId,
  expandedIds,
  toggleExpanded,
  allNodes,
}: NodeProps) {
  const isExpanded = expandedIds.has(node.id);
  const isActive = activeFolderId === node.id;
  const isFocused = focusedId === node.id;
  const isDragOver = dragOverId === node.id;
  const hasChildren = (node.children?.length ?? 0) > 0;
  const btnRef = useRef<HTMLButtonElement>(null);
  // Spring-loaded folders: segurar um item arrastado sobre uma pasta fechada
  // por um tempo a expande automaticamente (padrão Finder/Explorer).
  const springTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearSpringTimer() {
    if (springTimerRef.current) {
      clearTimeout(springTimerRef.current);
      springTimerRef.current = null;
    }
  }

  useEffect(() => {
    if (isFocused) btnRef.current?.focus();
  }, [isFocused]);

  useEffect(() => () => clearSpringTimer(), []);

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        if (!isExpanded && hasChildren) toggleExpanded(node.id);
        else if (hasChildren && node.children?.[0]) setFocusedId(node.children[0].id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (isExpanded) toggleExpanded(node.id);
        else if (node.parent_id) setFocusedId(node.parent_id);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect(node);
        break;
    }
  }

  const FolderIcon = hasChildren && isExpanded ? FolderOpen : Folder;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined}>
      <button
        ref={btnRef}
        tabIndex={isFocused || isActive ? 0 : -1}
        onFocus={() => setFocusedId(node.id)}
        onKeyDown={handleKeyDown}
        onClick={() => { onSelect(node); if (hasChildren) toggleExpanded(node.id); }}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(node.id); }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          onDragOver(node.id);
          if (hasChildren && !isExpanded && !springTimerRef.current) {
            springTimerRef.current = setTimeout(() => {
              toggleExpanded(node.id);
              springTimerRef.current = null;
            }, 1200);
          }
        }}
        onDragLeave={() => { onDragLeave(); clearSpringTimer(); }}
        onDrop={(e) => {
          e.preventDefault();
          clearSpringTimer();
          const docIds = e.dataTransfer.getData(DOCUMENT_DRAG_MIME);
          if (docIds && onDropDocuments) {
            onDropDocuments(node.id, docIds.split(","), node.name);
          } else {
            onDrop(node.id);
          }
        }}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        className={`w-full flex items-center gap-1.5 h-8 pr-2 text-mac-body rounded-[6px] transition-colors duration-fast text-left ${
          isActive
            ? "bg-teal-500/10 text-teal-500 font-medium"
            : isDragOver
            ? "bg-teal-50 dark:bg-teal-900/20 border border-teal-400"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        }`}
        aria-label={node.name}
      >
        <span className="w-4 flex-shrink-0 flex items-center justify-center">
          {hasChildren ? (
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform duration-fast ${isExpanded ? "rotate-90" : ""}`}
              onClick={(e) => { e.stopPropagation(); toggleExpanded(node.id); }}
            />
          ) : null}
        </span>
        <FolderIcon
          className={`w-4 h-4 flex-shrink-0 ${isActive ? "text-teal-500" : "text-teal-500"}`}
        />
        <span className="truncate flex-1">{node.name}</span>
      </button>

      {isExpanded && hasChildren && (
        <ul role="group" className="pl-0">
          {node.children!.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              activeFolderId={activeFolderId}
              onSelect={onSelect}
              dragOverId={dragOverId}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onDropDocuments={onDropDocuments}
              focusedId={focusedId}
              setFocusedId={setFocusedId}
              expandedIds={expandedIds}
              toggleExpanded={toggleExpanded}
              allNodes={allNodes}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function FolderTree({
  companyId,
  activeFolderId,
  onSelect,
  allowCreate = false,
  onMove,
  onDropDocuments,
}: FolderTreeProps) {
  const { success, error: showError } = useToast();
  const [roots, setRoots] = useState<FolderNode[]>([]);
  const [allNodes, setAllNodes] = useState<Map<string, FolderNode>>(new Map());
  const [loading, setLoading] = useState(true);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dragSrcId, setDragSrcId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [newName, setNewName] = useState("");
  const newInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      // flat=true: sem isso, o backend devolve só as pastas raiz
      // (parent_id=null é o default), e a árvore fica truncada no 1º nível.
      const { data } = await api.get<FolderNode[]>("/folders", {
        params: { company_id: companyId, flat: true },
      });
      const flat = Array.isArray(data) ? data : [];
      const map = new Map<string, FolderNode>();
      flat.forEach((f) => map.set(f.id, f));
      setAllNodes(map);
      setRoots(buildTree(flat));
    } catch {
      // silent — tree just shows empty
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (creatingRoot) newInputRef.current?.focus();
  }, [creatingRoot]);

  function toggleExpanded(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleDrop(targetId: string) {
    if (!dragSrcId || dragSrcId === targetId) { setDragOverId(null); return; }

    // Prevent dropping a folder into its own descendant
    function isDescendant(nodeId: string, ancestorId: string): boolean {
      const node = allNodes.get(nodeId);
      if (!node) return false;
      if (node.parent_id === ancestorId) return true;
      if (node.parent_id) return isDescendant(node.parent_id, ancestorId);
      return false;
    }
    if (isDescendant(targetId, dragSrcId)) {
      setDragSrcId(null); setDragOverId(null); return;
    }

    try {
      // Rota real é /folders/:id/move (PATCH /folders/:id sozinho não existe
      // — só /rename e /move — usar o endpoint errado dá 405).
      await api.patch(`/folders/${dragSrcId}/move`, { parent_id: targetId });
      success("Pasta movida.");
      onMove?.(dragSrcId, targetId);
      load();
    } catch {
      showError("Não foi possível mover a pasta.");
    }
    setDragSrcId(null);
    setDragOverId(null);
  }

  async function createRootFolder() {
    if (!newName.trim()) { setCreatingRoot(false); return; }
    try {
      await api.post("/folders", {
        name: newName.trim(),
        company_id: companyId,
        parent_id: null,
      });
      success(`Pasta "${newName.trim()}" criada.`);
      setNewName("");
      setCreatingRoot(false);
      load();
    } catch {
      showError("Não foi possível criar a pasta.");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--text-placeholder)]" />
      </div>
    );
  }

  return (
    <div className="py-1">
      <ul
        role="tree"
        aria-label="Árvore de pastas"
        className="space-y-px"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          // Drop on root area → move to root
          if (dragSrcId) {
            api.patch(`/folders/${dragSrcId}/move`, { parent_id: null })
              .then(() => { success("Pasta movida para raiz."); onMove?.(dragSrcId!, null); load(); })
              .catch(() => showError("Não foi possível mover."))
              .finally(() => { setDragSrcId(null); setDragOverId(null); });
          }
        }}
      >
        {roots.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            activeFolderId={activeFolderId}
            onSelect={onSelect}
            dragOverId={dragOverId}
            onDragStart={(id) => setDragSrcId(id)}
            onDragOver={(id) => setDragOverId(id)}
            onDragLeave={() => setDragOverId(null)}
            onDrop={handleDrop}
            onDropDocuments={onDropDocuments}
            focusedId={focusedId}
            setFocusedId={setFocusedId}
            expandedIds={expandedIds}
            toggleExpanded={toggleExpanded}
            allNodes={allNodes}
          />
        ))}
      </ul>

      {allowCreate && (
        <div className="mt-1 px-2">
          {creatingRoot ? (
            <input
              ref={newInputRef}
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createRootFolder();
                if (e.key === "Escape") { setCreatingRoot(false); setNewName(""); }
              }}
              onBlur={createRootFolder}
              placeholder="Nome da pasta"
              className="w-full h-7 px-2 text-mac-caption bg-[var(--bg-page)] border border-teal-400 rounded-[6px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none"
            />
          ) : (
            <button
              onClick={() => setCreatingRoot(true)}
              className="flex items-center gap-1.5 h-7 px-2 text-mac-caption text-[var(--text-tertiary)] hover:text-teal-500 hover:bg-[var(--bg-hover)] rounded-[6px] transition-colors duration-fast w-full"
            >
              <FolderPlus className="w-3.5 h-3.5" />
              Nova pasta
            </button>
          )}
        </div>
      )}
    </div>
  );
}
