import { useState, useRef, useEffect } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { LayoutDashboard, FolderOpen, Search, Anchor, MoreHorizontal, Link2, Activity, Trash2, Settings, Sun, Moon, X } from "lucide-react";
import { toggleTheme, getTheme } from "@/lib/theme";

const TABS = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Início" },
  { to: "/documents", icon: FolderOpen, label: "Docs" },
  { to: "/search", icon: Search, label: "Busca" },
  { to: "/favorites", icon: Anchor, label: "Ancorados" },
];

const MORE_LINKS = [
  { to: "/shares", icon: Link2, label: "Compartilhados" },
  { to: "/activity", icon: Activity, label: "Atividade" },
  { to: "/trash", icon: Trash2, label: "Lixeira" },
  { to: "/settings", icon: Settings, label: "Configurações" },
];

export default function BottomTabBar() {
  const [moreOpen, setMoreOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => getTheme() === "dark");
  const navigate = useNavigate();
  const location = useLocation();
  const sheetRef = useRef<HTMLDivElement>(null);

  const moreActive = MORE_LINKS.some((l) => location.pathname.startsWith(l.to.split("/").slice(0, 2).join("/")));

  useEffect(() => {
    if (!moreOpen) return;
    function handle(e: MouseEvent) {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node)) setMoreOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [moreOpen]);

  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  return (
    <>
      {moreOpen && (
        <div
          ref={sheetRef}
          className="glass-panel glass-blur-panel glass-shadow glass-highlight-line fixed bottom-[86px] left-4 right-4 z-30 rounded-[18px] py-2 md:hidden"
        >
          <div className="flex items-center justify-between px-4 py-1.5">
            <span className="text-mac-caption font-medium text-[var(--text-secondary)]">Mais</span>
            <button onClick={() => setMoreOpen(false)} aria-label="Fechar" className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {MORE_LINKS.map(({ to, icon: Icon, label }) => (
            <button
              key={to}
              onClick={() => navigate(to)}
              className={`w-full flex items-center gap-3 px-4 py-2.5 text-mac-body transition-colors duration-fast ${
                location.pathname.startsWith(to)
                  ? "text-teal-500"
                  : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
          <button
            onClick={() => setIsDark(toggleTheme() === "dark")}
            className="w-full flex items-center gap-3 px-4 py-2.5 text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            {isDark ? "Modo claro" : "Modo escuro"}
          </button>
        </div>
      )}

      <nav className="glass-panel glass-blur-panel glass-shadow glass-highlight-line fixed bottom-4 left-4 right-4 z-30 flex items-center rounded-[var(--radius-panel)] py-1.5 md:hidden">
        {TABS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              // moreOpen desmarca as outras abas enquanto a folha "Mais" está
              // aberta — do contrário a aba de origem (ex: Docs) continua
              // teal ao mesmo tempo que "Mais" também fica teal, parecendo
              // duas abas "ativas" simultâneas (bug reportado: "Mais" parecia
              // só uma caixa flutuante, não uma aba de verdade).
              `flex-1 min-w-0 flex flex-col items-center justify-center py-1.5 gap-0.5 text-[10px] rounded-[16px] transition-colors duration-fast ${
                isActive && !moreOpen
                  ? "text-teal-500"
                  : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
              }`
            }
          >
            <Icon className="w-5 h-5" />
            <span className="truncate max-w-full">{label}</span>
          </NavLink>
        ))}
        <button
          onClick={() => setMoreOpen((v) => !v)}
          className={`flex-1 min-w-0 flex flex-col items-center justify-center py-1.5 gap-0.5 text-[10px] rounded-[16px] transition-colors duration-fast ${
            moreOpen || moreActive ? "text-teal-500" : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
          }`}
          aria-label="Mais opções"
        >
          <MoreHorizontal className="w-5 h-5" />
          <span className="truncate max-w-full">Mais</span>
        </button>
      </nav>
    </>
  );
}
