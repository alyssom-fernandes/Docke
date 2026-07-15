import { useEffect, useState } from "react";
import { FolderOpen, Anchor, Trash2 } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import { Link, useNavigate } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import EmptyState from "@/components/shared/EmptyState";

interface Favorite {
  id: string;
  item_type: "document" | "folder";
  document_id: string | null;
  folder_id: string | null;
  document_folder_id: string | null;
  item_name: string;
  created_at: string;
}

export default function Favorites() {
  usePageTitle("Ancorados");
  const { current } = useCompany();
  const navigate = useNavigate();
  const { success, error: showError } = useToast();
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [loading, setLoading] = useState(true);

  function load() {
    if (!current) return;
    setLoading(true);
    api
      .get<Favorite[]>("/favorites", { params: { company_id: current.id } })
      .then((r) => setFavorites(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, [current?.id]);

  async function removeFavorite(fav: Favorite) {
    try {
      await api.delete(`/favorites/${fav.id}`);
      setFavorites((prev) => prev.filter((f) => f.id !== fav.id));
      success(`"${fav.item_name}" removido dos ancorados.`);
    } catch {
      showError("Não foi possível remover a ancoragem.");
    }
  }

  function openFavorite(fav: Favorite) {
    if (fav.item_type === "folder") {
      navigate(`/documents?folder_id=${fav.folder_id}`);
    } else {
      navigate(`/documents?folder_id=${fav.document_folder_id ?? ""}&doc=${fav.document_id}`);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-mac-title2 font-semibold text-[var(--text-primary)]">Ancorados</h1>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
          ))}
        </div>
      ) : favorites.length === 0 ? (
        <EmptyState
          title="Nada ancorado ainda"
          description="Clique no ícone de âncora em qualquer documento ou pasta para fixá-lo aqui."
          icon={<Anchor className="w-6 h-6" />}
          action={
            <Link
              to="/documents"
              className="px-4 py-2 text-mac-body font-medium text-white bg-teal-600 rounded-full hover:bg-teal-500 transition-colors duration-fast"
            >
              Explorar documentos
            </Link>
          }
        />
      ) : (
        <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
          <ul>
            {favorites.map((fav) => (
              <li
                key={fav.id}
                role="button"
                tabIndex={0}
                onClick={() => openFavorite(fav)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openFavorite(fav);
                  }
                }}
                className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0 group cursor-pointer"
              >
                {fav.item_type === "folder" ? (
                  <FolderOpen className="w-4 h-4 text-teal-500 flex-shrink-0" />
                ) : (
                  (() => { const s = getFileStyle(fav.item_name); const Icon = s.icon; return (
                    <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-3.5 h-3.5 ${s.iconColor}`} />
                    </div>
                  ); })()
                )}
                <span className="flex-1 min-w-0 text-mac-body text-[var(--text-primary)] truncate">{fav.item_name}</span>
                <span className="hidden md:inline text-mac-caption text-[var(--text-tertiary)] mr-2">
                  {fav.item_type === "folder" ? "Pasta" : "Documento"}
                </span>
                <button
                  onClick={(e) => { e.stopPropagation(); removeFavorite(fav); }}
                  className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-1.5 rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-fast flex-shrink-0"
                  title="Remover ancoragem"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
