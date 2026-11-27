import { useCallback, useEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  House, FolderClosed, Search, CalendarClock, Activity, Link2, Trash2, Settings, ChevronRight,
  PanelLeft, Anchor, FileText, Folder, User, SlidersHorizontal, Keyboard, LogOut,
} from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useAuthContext } from "@/lib/AuthContext";
import { prefetchRoute } from "@/lib/routePrefetch";
import FolderTree from "@/components/documents/FolderTree";
import Avatar from "@/components/ui/Avatar";
import Menu from "@/components/ui/Menu";
import { openKeyboardShortcuts } from "@/components/shared/KeyboardShortcuts";
import CompanySwitcher from "./CompanySwitcher";
import { useNavBadges } from "./navItems";
import { useWindow, ToolbarButton } from "./window";

/**
 * Barra lateral da janela, como a do Finder no macOS 27: cinza #E6E6E6
 * (#161616 no escuro), itens de 28 px com ícone na cor do acento, cabeçalhos
 * de seção em 11 px negrito sem caixa alta, seleção em cápsula cinza.
 * "Ancorados" é o Favoritos do Docke; "Pastas" é a árvore da empresa, que
 * conversa com a tela de Documentos pelo endereço (?pasta=) e por eventos.
 */

interface Favorite {
  id: string;
  item_type: "document" | "folder";
  document_id: string | null;
  folder_id: string | null;
  document_folder_id: string | null;
  item_name: string;
}

const FAV_LIMIT = 8;
const COLLAPSE_KEY = "docke_secoes_recolhidas";

function readCollapsed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]")); } catch { return new Set(); }
}

export function SidebarItem({ to, icon: Icon, label, count, countTone, end = false }: {
  to: string; icon: ElementType; label: string; count?: number; countTone?: "danger" | "accent"; end?: boolean;
}) {
  const match = to.split("?")[0];
  return (
    <NavLink
      to={to}
      end={end}
      onMouseEnter={() => prefetchRoute(match)}
      onFocus={() => prefetchRoute(match)}
      className={({ isActive }) => `sidebar-item ${isActive ? "is-selected" : ""}`}
    >
      <span className="sidebar-icon"><Icon aria-hidden /></span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count ? (
        <span className={`shrink-0 text-[12px] font-medium tabular-nums ${countTone === "danger" ? "text-(--text-danger)" : "text-(--text-secondary)"}`}>
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </NavLink>
  );
}

function Section({ id, title, collapsed, onToggle, children, action }: {
  id: string; title: string; collapsed: boolean; onToggle: (id: string) => void; children: ReactNode; action?: ReactNode;
}) {
  return (
    <section aria-labelledby={`secao-${id}`} className="group/secao">
      <div className="flex items-center pt-[17px] pb-[6px] pl-1 pr-1">
        <button
          id={`secao-${id}`}
          type="button"
          onClick={() => onToggle(id)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-bold leading-[14px] text-(--sidebar-header) outline-hidden focus-visible:underline"
        >
          <span className="truncate">{title}</span>
          <ChevronRight
            aria-hidden
            className={`size-3 shrink-0 opacity-0 transition-[opacity,transform] duration-fast group-hover/secao:opacity-100 group-focus-within/secao:opacity-100 ${collapsed ? "" : "rotate-90"}`}
          />
        </button>
        {action}
      </div>
      {!collapsed && children}
    </section>
  );
}

export default function Sidebar() {
  const { current } = useCompany();
  const { user, logout } = useAuthContext();
  const { setSidebarOpen } = useWindow();
  const navigate = useNavigate();
  const location = useLocation();
  const badges = useNavBadges();
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  const [accountMenu, setAccountMenu] = useState(false);
  const accountRef = useRef<HTMLButtonElement>(null);
  const onDocuments = location.pathname.startsWith("/documents");
  const activeFolderId = onDocuments ? new URLSearchParams(location.search).get("pasta") : null;
  const nome = user?.full_name || user?.username || "Conta";

  const toggleSection = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  const loadFavorites = useCallback(() => {
    if (!current) { setFavorites([]); return; }
    api.get<Favorite[]>("/favorites", { params: { company_id: current.id } })
      .then((r) => setFavorites(Array.isArray(r.data) ? r.data : []))
      .catch(() => setFavorites([]));
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadFavorites(); }, [loadFavorites]);

  // A tela de Documentos avisa quando pastas ou ancorados mudam.
  useEffect(() => {
    const onFolders = () => setTreeVersion((v) => v + 1);
    window.addEventListener("docke:pastas", onFolders);
    window.addEventListener("docke:ancorados", loadFavorites);
    return () => {
      window.removeEventListener("docke:pastas", onFolders);
      window.removeEventListener("docke:ancorados", loadFavorites);
    };
  }, [loadFavorites]);

  // No tablet a barra lateral flutua sobre o conteúdo: fecha ao navegar.
  useEffect(() => {
    if (!window.matchMedia("(min-width: 1024px)").matches) setSidebarOpen(false);
  }, [location.pathname, location.search, setSidebarOpen]);

  function openFavorite(f: Favorite) {
    if (f.item_type === "folder" && f.folder_id) navigate(`/documents?pasta=${f.folder_id}`);
    else if (f.document_id) navigate(`/documents?folder_id=${f.document_folder_id ?? ""}&doc=${f.document_id}`);
  }

  const obligations = badges["/obligations"];

  return (
    <aside aria-label="Barra lateral" className="sidebar flex h-full w-[240px] shrink-0 flex-col">
      {/* Cabeçalho (52 px, como o da janela): marca, empresa e o botão de recolher. */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 pl-4 pr-2">
        <span className="brand-mark size-[18px] shrink-0" role="img" aria-label="Docke" />
        <div className="min-w-0 flex-1"><CompanySwitcher variant="sidebar" /></div>
        <ToolbarButton label="Esconder a barra lateral" onClick={() => setSidebarOpen(false)}>
          <PanelLeft aria-hidden />
        </ToolbarButton>
      </div>

      <nav aria-label="Navegação principal" className="min-h-0 flex-1 overflow-y-auto px-[10px] pb-3">
        <SidebarItem to="/dashboard" icon={House} label="Início" />
        <SidebarItem to="/documents" icon={FolderClosed} label="Documentos" />
        <SidebarItem to="/search" icon={Search} label="Busca" />
        <SidebarItem to="/obligations" icon={CalendarClock} label="Obrigações" count={obligations?.count} countTone={obligations?.tone} />
        <SidebarItem to="/activity" icon={Activity} label="Atividade" />
        <SidebarItem to="/shares" icon={Link2} label="Links" />

        <Section id="ancorados" title="Ancorados" collapsed={collapsed.has("ancorados")} onToggle={toggleSection}>
          {favorites.length === 0 ? (
            <p className="px-1.5 pb-1 text-[12px] leading-4 text-(--text-secondary)">Ancore pastas e documentos para tê-los aqui.</p>
          ) : (
            <>
              {favorites.slice(0, FAV_LIMIT).map((f) => {
                const Icon = f.item_type === "folder" ? Folder : FileText;
                return (
                  <button key={f.id} type="button" onClick={() => openFavorite(f)} className="sidebar-item w-full" title={f.item_name}>
                    <span className="sidebar-icon"><Icon aria-hidden /></span>
                    <span className="min-w-0 flex-1 truncate text-left">{f.item_name}</span>
                  </button>
                );
              })}
              <SidebarItem to="/favorites" icon={Anchor} label={favorites.length > FAV_LIMIT ? `Todos os ancorados (${favorites.length})` : "Todos os ancorados"} />
            </>
          )}
        </Section>

        {current && (
          <Section id="pastas" title="Pastas" collapsed={collapsed.has("pastas")} onToggle={toggleSection}>
            <div className="sidebar-tree">
              <FolderTree
                version={treeVersion}
                companyId={current.id}
                activeFolderId={activeFolderId}
                onSelect={(f) => navigate(`/documents?pasta=${f.id}`)}
                onDropDocuments={(folderId, ids, folderName) => {
                  window.dispatchEvent(new CustomEvent("docke:soltar-documentos", { detail: { folderId, ids, folderName } }));
                }}
                onMove={onDocuments ? (folderId, newParent, oldParent, name) => {
                  window.dispatchEvent(new CustomEvent("docke:pasta-movida", { detail: { folderId, newParent, oldParent, name } }));
                } : undefined}
              />
            </div>
          </Section>
        )}

        <div className="pt-[17px]">
          <SidebarItem to="/trash" icon={Trash2} label="Lixeira" />
        </div>
      </nav>

      {/* Conta: menu com perfil, ajustes, atalhos e sair. */}
      <div className="shrink-0 px-[10px] pb-2.5 pt-1.5">
        <button
          ref={accountRef}
          type="button"
          onClick={() => setAccountMenu((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={accountMenu}
          title={user?.email ? `${nome} · ${user.email}` : nome}
          className={`sidebar-item w-full ${location.pathname.startsWith("/settings") ? "is-selected" : ""}`}
        >
          <Avatar name={nome} size="xs" />
          <span className="min-w-0 flex-1 truncate text-left">{nome}</span>
          <Settings className="size-[15px] shrink-0 text-(--text-secondary)" aria-hidden />
        </button>
        {accountMenu && accountRef.current && (
          <Menu
            anchor={accountRef.current}
            label={`Conta de ${nome}`}
            onClose={() => setAccountMenu(false)}
            items={[
              { label: "Perfil e conta", icon: <User />, onSelect: () => navigate("/settings/profile") },
              { label: "Ajustes", icon: <Settings />, shortcut: "Ctrl ,", onSelect: () => navigate("/settings") },
              { label: "Preferências", icon: <SlidersHorizontal />, onSelect: () => navigate("/settings/preferences") },
              { label: "Atalhos do teclado", icon: <Keyboard />, shortcut: "?", onSelect: () => openKeyboardShortcuts() },
              { label: "Sair", icon: <LogOut />, danger: true, separatorBefore: true, onSelect: () => logout() },
            ]}
          />
        )}
      </div>
    </aside>
  );
}
