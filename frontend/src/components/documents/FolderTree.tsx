import { KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FolderOpen, Folder, FolderPlus, RefreshCw } from "lucide-react";
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
  /** Pasta aberta no momento: a árvore se abre até ela. */
  activeFolderId: string | null;
  onSelect: (folder: FolderNode) => void;
  /** Muda quando pastas são criadas, renomeadas ou movidas fora da árvore: recarrega sem fechar nada. */
  version?: number;
  allowCreate?: boolean;
  /** Pasta movida pela árvore (arrastar): para recarregar e oferecer Desfazer. */
  onMove?: (folderId: string, newParentId: string | null, oldParentId: string | null, name: string) => void;
  /** Documentos arrastados da lista e soltos numa pasta. */
  onDropDocuments?: (folderId: string, documentIds: string[], folderName: string) => void;
}

const DOCUMENT_DRAG_MIME = "application/x-docke-document-ids";

function buildTree(flat: FolderNode[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  flat.forEach((f) => byId.set(f.id, { ...f, children: [] }));
  const roots: FolderNode[] = [];
  byId.forEach((node) => {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id)!.children!.push(node);
    else roots.push(node);
  });
  // Por nome, como no Finder (antes vinha pela ordem interna do caminho — A4-09).
  const sort = (list: FolderNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { sensitivity: "base", numeric: true }));
    list.forEach((n) => n.children && sort(n.children));
  };
  sort(roots);
  return roots;
}

/**
 * Árvore de pastas no padrão "tree" do WAI-ARIA (achado A4-08): um item por vez
 * no Tab; setas para cima e para baixo andam pelos itens visíveis, direita abre
 * ou desce, esquerda fecha ou sobe, Home/End, letra inicial, "*" abre os irmãos.
 * Abre sozinha até a pasta atual e não fecha nada ao recarregar (A4-09).
 * Arrastar uma pasta sobre outra move só uma vez (antes também ia para a raiz — A4-07).
 */
export default function FolderTree({
  companyId, activeFolderId, onSelect, version = 0, allowCreate = false, onMove, onDropDocuments,
}: FolderTreeProps) {
  const { success, error: showError } = useToast();
  const [flat, setFlat] = useState<FolderNode[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dragSrcId, setDragSrcId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [creatingRoot, setCreatingRoot] = useState(false);
  const [newName, setNewName] = useState("");
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const springTimer = useRef<number | null>(null);
  const typeahead = useRef({ text: "", timer: 0 });

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const { data } = await api.get<FolderNode[]>("/folders", { params: { company_id: companyId, flat: true } });
      setFlat(Array.isArray(data) ? data : []);
      setFailed(false);
    } catch {
      setFailed(true);
      setFlat((prev) => prev ?? []);
    }
  }, [companyId]);

  useEffect(() => { load(); }, [load, version]);

  const byId = useMemo(() => new Map((flat ?? []).map((f) => [f.id, f])), [flat]);
  const roots = useMemo(() => buildTree(flat ?? []), [flat]);

  // Abre os ancestrais da pasta atual.
  useEffect(() => {
    if (!activeFolderId || !byId.size) return;
    const chain: string[] = [];
    let cur = byId.get(activeFolderId)?.parent_id ?? null;
    while (cur) { chain.push(cur); cur = byId.get(cur)?.parent_id ?? null; }
    if (chain.length) setExpandedIds((prev) => (chain.every((c) => prev.has(c)) ? prev : new Set([...prev, ...chain])));
  }, [activeFolderId, byId]);

  // Itens visíveis, na ordem da tela (base da navegação por setas).
  const visible = useMemo(() => {
    const out: { node: FolderNode; depth: number }[] = [];
    const walk = (list: FolderNode[], depth: number) => {
      for (const n of list) {
        out.push({ node: n, depth });
        if (expandedIds.has(n.id) && n.children?.length) walk(n.children, depth + 1);
      }
    };
    walk(roots, 0);
    return out;
  }, [roots, expandedIds]);

  const tabStop = focusedId && visible.some((v) => v.node.id === focusedId)
    ? focusedId
    : activeFolderId && visible.some((v) => v.node.id === activeFolderId) ? activeFolderId : visible[0]?.node.id;

  function focusItem(id: string | undefined) {
    if (!id) return;
    setFocusedId(id);
    itemRefs.current.get(id)?.focus();
  }

  function toggle(id: string, open?: boolean) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      const willOpen = open ?? !next.has(id);
      if (willOpen) next.add(id); else next.delete(id);
      return next;
    });
  }

  function onKeyDown(e: KeyboardEvent, node: FolderNode) {
    const i = visible.findIndex((v) => v.node.id === node.id);
    const hasChildren = !!node.children?.length;
    const open = expandedIds.has(node.id);
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focusItem(visible[i + 1]?.node.id); break;
      case "ArrowUp": e.preventDefault(); focusItem(visible[i - 1]?.node.id); break;
      case "Home": e.preventDefault(); focusItem(visible[0]?.node.id); break;
      case "End": e.preventDefault(); focusItem(visible[visible.length - 1]?.node.id); break;
      case "ArrowRight":
        e.preventDefault();
        if (hasChildren && !open) toggle(node.id, true);
        else if (hasChildren) focusItem(node.children![0].id);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (hasChildren && open) toggle(node.id, false);
        else if (node.parent_id) focusItem(node.parent_id);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect(node);
        break;
      case "*": {
        e.preventDefault();
        const siblings = visible.filter((v) => v.node.parent_id === node.parent_id);
        setExpandedIds((prev) => new Set([...prev, ...siblings.filter((s) => s.node.children?.length).map((s) => s.node.id)]));
        break;
      }
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
          window.clearTimeout(typeahead.current.timer);
          typeahead.current.text += e.key.toLowerCase();
          typeahead.current.timer = window.setTimeout(() => { typeahead.current.text = ""; }, 700);
          const q = typeahead.current.text;
          const order = [...visible.slice(i + 1), ...visible.slice(0, i + 1)];
          const hit = order.find((v) => v.node.name.toLowerCase().startsWith(q)) ?? visible.find((v) => v.node.name.toLowerCase().startsWith(q));
          if (hit) focusItem(hit.node.id);
        }
    }
  }

  function isDescendant(nodeId: string, ancestorId: string): boolean {
    let cur = byId.get(nodeId)?.parent_id ?? null;
    while (cur) { if (cur === ancestorId) return true; cur = byId.get(cur)?.parent_id ?? null; }
    return false;
  }

  async function moveFolder(srcId: string, targetId: string | null) {
    const src = byId.get(srcId);
    if (!src || srcId === targetId || src.parent_id === targetId || (targetId && isDescendant(targetId, srcId))) return;
    try {
      await api.patch(`/folders/${srcId}/move`, { parent_id: targetId });
      onMove?.(srcId, targetId, src.parent_id, src.name);
      if (!onMove) success("Pasta movida.");
      load();
    } catch (err: any) {
      showError(err?.response?.data?.detail ?? "Não foi possível mover a pasta.");
    }
  }

  function clearSpring() {
    if (springTimer.current) { window.clearTimeout(springTimer.current); springTimer.current = null; }
  }

  async function createRootFolder() {
    const name = newName.trim();
    if (!name) { setCreatingRoot(false); return; }
    try {
      await api.post("/folders", { name, company_id: companyId, parent_id: null });
      success(`Pasta "${name}" criada.`);
      setNewName("");
      setCreatingRoot(false);
      load();
    } catch (err: any) {
      showError(err?.response?.data?.detail ?? "Não foi possível criar a pasta.");
    }
  }

  if (flat === null) {
    return (
      <div className="py-1 space-y-1" aria-label="Carregando pastas">
        {[72, 58, 64, 50].map((w, i) => (
          <div key={i} className="h-7 rounded-[6px] bg-(--bg-hover) animate-pulse" style={{ width: `${w}%`, marginLeft: 12 + (i % 2) * 12 }} />
        ))}
      </div>
    );
  }

  return (
    <div className="py-1">
      {failed && (
        <div role="alert" className="mx-1 mb-1 rounded-[6px] bg-amber-500/10 px-2.5 py-2 text-mac-caption text-(--text-primary)">
          Não carregou a árvore de pastas.{" "}
          <button onClick={load} className="inline-flex items-center gap-1 font-medium text-(--text-accent) underline-offset-2 hover:underline">
            <RefreshCw className="w-3 h-3" aria-hidden /> Tentar de novo
          </button>
        </div>
      )}
      <div role="tree" aria-label="Árvore de pastas">
        {visible.map(({ node, depth }) => {
          const hasChildren = !!node.children?.length;
          const isOpen = expandedIds.has(node.id);
          const isActive = activeFolderId === node.id;
          const isDragOver = dragOverId === node.id;
          const Icon = hasChildren && isOpen ? FolderOpen : Folder;
          return (
            <div
              key={node.id}
              ref={(el) => { if (el) itemRefs.current.set(node.id, el); else itemRefs.current.delete(node.id); }}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={hasChildren ? isOpen : undefined}
              aria-selected={isActive}
              aria-current={isActive ? "page" : undefined}
              tabIndex={tabStop === node.id ? 0 : -1}
              onFocus={() => setFocusedId(node.id)}
              onKeyDown={(e) => onKeyDown(e, node)}
              onClick={() => { onSelect(node); if (hasChildren && !isOpen) toggle(node.id, true); }}
              draggable
              onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("application/x-docke-folder-id", node.id); setDragSrcId(node.id); }}
              onDragEnd={() => { setDragSrcId(null); setDragOverId(null); clearSpring(); }}
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                if (dragOverId !== node.id) {
                  setDragOverId(node.id);
                  clearSpring();
                  if (hasChildren && !isOpen) springTimer.current = window.setTimeout(() => toggle(node.id, true), 900);
                }
              }}
              onDragLeave={() => { setDragOverId((p) => (p === node.id ? null : p)); clearSpring(); }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation(); // sem isso o soltar também chegava à lista e movia para a raiz (A4-07)
                clearSpring();
                setDragOverId(null);
                const docIds = e.dataTransfer.getData(DOCUMENT_DRAG_MIME);
                if (docIds && onDropDocuments) onDropDocuments(node.id, docIds.split(","), node.name);
                else if (dragSrcId) moveFolder(dragSrcId, node.id);
                setDragSrcId(null);
              }}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
              className={`relative flex items-center gap-1.5 h-8 pointer-coarse:h-11 pr-2 text-mac-body rounded-[6px] cursor-pointer select-none outline-none transition-colors duration-fast
                focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)
                ${isActive ? "bg-teal-500/12 text-(--text-accent) font-medium" : "text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary)"}
                ${isDragOver ? "ring-2 ring-inset ring-teal-500 bg-teal-500/10" : ""}`}
            >
              <span
                className="w-4 h-4 shrink-0 flex items-center justify-center"
                onClick={(e) => { if (hasChildren) { e.stopPropagation(); toggle(node.id); } }}
                aria-hidden
              >
                {hasChildren && <ChevronRight className={`w-3.5 h-3.5 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />}
              </span>
              <Icon className="w-4 h-4 shrink-0 text-teal-600 dark:text-teal-400 fill-teal-500/20" aria-hidden />
              <span className="truncate flex-1">{node.name}</span>
            </div>
          );
        })}
      </div>
      {dragSrcId && byId.get(dragSrcId)?.parent_id && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOverId("__raiz__"); }}
          onDragLeave={() => setDragOverId(null)}
          onDrop={(e) => { e.preventDefault(); setDragOverId(null); if (dragSrcId) moveFolder(dragSrcId, null); setDragSrcId(null); }}
          className={`mt-1 mx-1 rounded-[6px] border border-dashed px-2 py-2 text-center text-mac-caption ${dragOverId === "__raiz__" ? "border-teal-500 bg-teal-500/10 text-(--text-accent)" : "border-(--border-control) text-(--text-secondary)"}`}
        >
          Soltar aqui para levar ao início
        </div>
      )}
      {allowCreate && (
        <div className="mt-1 px-2">
          {creatingRoot ? (
            <input
              autoFocus
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createRootFolder();
                if (e.key === "Escape") { setCreatingRoot(false); setNewName(""); }
              }}
              onBlur={createRootFolder}
              placeholder="Nome da pasta"
              aria-label="Nome da nova pasta"
              className="w-full h-7 px-2 text-mac-caption bg-(--bg-card) border border-(--border-control) rounded-[6px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
            />
          ) : (
            <button
              onClick={() => setCreatingRoot(true)}
              className="flex items-center gap-1.5 h-7 px-2 text-mac-caption text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover) rounded-[6px] transition-colors duration-fast w-full"
            >
              <FolderPlus className="w-3.5 h-3.5" aria-hidden />
              Nova pasta
            </button>
          )}
        </div>
      )}
    </div>
  );
}
