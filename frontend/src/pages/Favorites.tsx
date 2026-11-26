import { useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Folder, Anchor, X, AlertTriangle, RefreshCw, Search } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { pushUndo, takeUndo } from "@/lib/undo";
import EmptyState from "@/components/shared/EmptyState";
import Button from "@/components/ui/Button";

interface Favorite {
  id: string;
  item_type: "document" | "folder";
  document_id: string | null;
  folder_id: string | null;
  document_folder_id: string | null;
  item_name: string;
  location?: string | null;
  created_at: string;
}

type Tipo = "todos" | "folder" | "document";

/**
 * Ancorados (A6-12..A6-15, A6-T1, A6-T2): mostra onde cada item está,
 * filtra por tipo e nome, ordena, e desancorar é imediato com Desfazer.
 * Erro de carga é erro, não "nada ancorado".
 */
export default function Favorites() {
  usePageTitle("Ancorados");
  const { current } = useCompany();
  const { toast, error: showError } = useToast();
  const uid = useId();
  const [items, setItems] = useState<Favorite[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tipo, setTipo] = useState<Tipo>("todos");
  const [filtro, setFiltro] = useState("");
  const [ordem, setOrdem] = useState<"recentes" | "nome">("recentes");

  function load() {
    if (!current) return;
    setFailed(false);
    api.get<Favorite[]>("/favorites", { params: { company_id: current.id } })
      .then((r) => setItems(Array.isArray(r.data) ? r.data : []))
      .catch(() => setFailed(true));
  }
  useEffect(load, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function anchorAgain(fav: Favorite) {
    await api.post("/favorites", fav.item_type === "folder" ? { folder_id: fav.folder_id } : { document_id: fav.document_id });
    load();
  }

  async function remove(fav: Favorite) {
    setItems((prev) => prev?.filter((f) => f.id !== fav.id) ?? null);
    try {
      await api.delete(`/favorites/${fav.id}`);
      const entry = pushUndo(`Ancorar “${fav.item_name}” de novo`, () => anchorAgain(fav));
      toast({ type: "success", message: `“${fav.item_name}” saiu dos ancorados.`, action: { label: "Desfazer", onClick: () => { takeUndo(entry.id)?.undo(); } } });
    } catch {
      setItems((prev) => (prev ? [fav, ...prev] : [fav]));
      showError("Não foi possível desancorar. Tente de novo.");
    }
  }

  const visible = useMemo(() => {
    let list = items ?? [];
    if (tipo !== "todos") list = list.filter((f) => f.item_type === tipo);
    const q = filtro.trim().toLocaleLowerCase("pt-BR");
    if (q) list = list.filter((f) => f.item_name.toLocaleLowerCase("pt-BR").includes(q) || (f.location ?? "").toLocaleLowerCase("pt-BR").includes(q));
    return [...list].sort((a, b) => (ordem === "nome" ? a.item_name.localeCompare(b.item_name, "pt-BR") : b.created_at.localeCompare(a.created_at)));
  }, [items, tipo, filtro, ordem]);

  const href = (f: Favorite) => (f.item_type === "folder" ? `/documents?folder_id=${f.folder_id}` : `/documents?folder_id=${f.document_folder_id ?? ""}&doc=${f.document_id}`);
  const counts = { todos: items?.length ?? 0, folder: items?.filter((f) => f.item_type === "folder").length ?? 0, document: items?.filter((f) => f.item_type === "document").length ?? 0 };

  return (
    <div className="space-y-5 max-w-[1100px] w-full mx-auto">
      <div>
        <h1 className="text-mac-title2 font-semibold text-(--text-primary)">Ancorados</h1>
        <p className="text-mac-caption text-(--text-secondary) mt-0.5">Os documentos e pastas que você usa todo dia, a um clique. Só você vê os seus.</p>
      </div>

      {failed ? (
        <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) flex flex-wrap items-center gap-3 px-5 py-4">
          <AlertTriangle className="w-4 h-4 text-(--text-warning)" aria-hidden="true" />
          <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar os ancorados.</p>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
        </div>
      ) : !items ? (
        <div className="space-y-2" aria-label="Carregando">{[0, 1, 2, 3].map((i) => <div key={i} className="h-14 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Nada ancorado ainda"
          description="No menu de qualquer documento ou pasta, escolha “Ancorar” para trazê-lo para cá e para o Início."
          icon={<Anchor className="w-6 h-6" />}
          action={<Link to="/documents" className="inline-flex items-center h-9 pointer-coarse:h-11 px-4 text-mac-body font-medium text-white bg-teal-600 rounded-full hover:bg-teal-700">Ir para Documentos</Link>}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Tipo" className="flex items-center gap-0.5 p-0.5 rounded-full bg-(--bg-hover)">
              {([["todos", "Tudo"], ["folder", "Pastas"], ["document", "Documentos"]] as const).map(([v, l]) => (
                <button key={v} aria-pressed={tipo === v} onClick={() => setTipo(v)}
                  className={`px-3 h-8 pointer-coarse:h-10 rounded-full text-mac-body font-medium transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${tipo === v ? "bg-(--bg-card) text-(--text-primary) shadow-sm" : "text-(--text-secondary) hover:text-(--text-primary)"}`}>
                  {l} <span className="text-(--text-secondary)">{counts[v]}</span>
                </button>
              ))}
            </div>
            <div className="relative flex-1 min-w-48 max-w-72">
              <label htmlFor={`${uid}-f`} className="sr-only">Filtrar ancorados</label>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-secondary)" aria-hidden="true" />
              <input id={`${uid}-f`} value={filtro} onChange={(e) => setFiltro(e.target.value)} placeholder="Filtrar por nome ou pasta"
                className="h-8 pointer-coarse:h-10 w-full rounded-full border border-(--border-control) bg-(--bg-card) pl-8 pr-3 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
            </div>
            <button onClick={() => setOrdem((o) => (o === "recentes" ? "nome" : "recentes"))} className="h-8 pointer-coarse:h-10 px-3 rounded-full text-mac-body text-(--text-accent) hover:bg-(--bg-hover)">
              Ordem: {ordem === "recentes" ? "mais recentes" : "nome"}
            </button>
          </div>
          <p className="sr-only" role="status" aria-live="polite">{visible.length} itens</p>
          {visible.length === 0 ? (
            <p className="text-mac-body text-(--text-secondary)">Nenhum ancorado com esse filtro.</p>
          ) : (
            <ul className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden">
              {visible.map((fav) => {
                const s = getFileStyle(fav.item_name);
                const Icon = fav.item_type === "folder" ? Folder : s.icon;
                return (
                  <li key={fav.id} className="group flex items-center border-b border-(--border-default) last:border-0">
                    <Link to={href(fav)} className="flex-1 min-w-0 flex items-center gap-3 px-4 sm:px-5 py-2.5 min-h-14 hover:bg-(--bg-hover) transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)">
                      <span className={`w-8 h-8 rounded-badge flex items-center justify-center shrink-0 ${fav.item_type === "folder" ? "bg-(--tint-accent)" : s.bgColor}`} aria-hidden="true">
                        <Icon className={`w-4 h-4 ${fav.item_type === "folder" ? "text-(--text-accent) fill-teal-500/25" : `${s.iconColor} ${s.fillColor}`}`} />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-mac-body text-(--text-primary) truncate">{fav.item_name}</span>
                        <span className="block text-mac-caption text-(--text-secondary) truncate">
                          {fav.item_type === "folder" ? "Pasta" : "Documento"}{fav.location ? ` em ${fav.location}` : ""}
                        </span>
                      </span>
                    </Link>
                    <button onClick={() => remove(fav)} aria-label={`Desancorar ${fav.item_name}`} title="Desancorar"
                      className="shrink-0 mr-2 p-2 pointer-coarse:p-3 rounded-full text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover) sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 sm:group-focus-within:opacity-100 pointer-coarse:opacity-100 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) transition-opacity duration-fast">
                      <X className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
