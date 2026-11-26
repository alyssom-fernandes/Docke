import { useState, useRef, useEffect } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { MoreHorizontal, Sun, Moon, X, Upload } from "lucide-react";
import { toggleTheme, useIsDark } from "@/lib/theme";
import { NAV_ITEMS, useNavBadges } from "./navItems";
import { usePresence } from "@/hooks/usePresence";

// Quatro abas fixas; o resto na folha "Mais". Nomes e ícones vêm da mesma
// lista do Dock (A2-18, A2-50).
const TAB_PATHS = ["/dashboard", "/documents", "/search", "/favorites"];
const TABS = NAV_ITEMS.filter((i) => TAB_PATHS.includes(i.to));
const MORE_LINKS = NAV_ITEMS.filter((i) => !TAB_PATHS.includes(i.to));

export default function BottomTabBar() {
  const [moreOpen, setMoreOpen] = useState(false);
  const isDark = useIsDark();
  const navigate = useNavigate();
  const location = useLocation();
  const sheetRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const badges = useNavBadges();
  const presence = usePresence(moreOpen, 150);

  const moreActive = MORE_LINKS.some((l) => location.pathname.startsWith(l.match));
  const moreBadge = MORE_LINKS.map((l) => badges[l.to]).find(Boolean);

  useEffect(() => {
    if (!moreOpen) return;
    function handle(e: MouseEvent) {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node) && !moreButtonRef.current?.contains(e.target as Node)) setMoreOpen(false);
    }
    // Folha "Mais" (A2-17): Esc fecha e devolve o foco; o foco entra no primeiro item.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setMoreOpen(false); moreButtonRef.current?.focus(); }
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", onKey);
    window.setTimeout(() => sheetRef.current?.querySelector<HTMLButtonElement>("button[data-item]")?.focus(), 0);
    return () => { document.removeEventListener("mousedown", handle); document.removeEventListener("keydown", onKey); };
  }, [moreOpen]);

  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname, location.search]);

  return (
    <>
      {presence.mounted && (
        <div
          ref={sheetRef}
          id="folha-mais"
          role="dialog"
          aria-label="Mais opções"
          className={`${presence.leaving ? "sheet-out" : "sheet-in"} glass-dialog glass-blur-strong glass-shadow glass-highlight-line fixed bottom-[calc(86px+env(safe-area-inset-bottom))] left-4 right-4 z-30 rounded-[18px] py-2 md:hidden`}
        >
          <div className="flex items-center justify-between pl-4 pr-2 py-1">
            <span className="text-mac-caption font-medium text-(--text-secondary)">Mais</span>
            <button onClick={() => { setMoreOpen(false); moreButtonRef.current?.focus(); }} aria-label="Fechar" className="w-11 h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary)">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          {/* Enviar à mão no celular (A2-18): a barra superior não tem espaço para o botão. */}
          <button
            data-item
            onClick={() => navigate("/documents?acao=enviar")}
            className="w-full flex items-center gap-3 px-4 min-h-11 text-mac-body font-medium text-(--text-accent) hover:bg-(--bg-hover) transition-colors duration-fast"
          >
            <Upload className="w-4 h-4" aria-hidden="true" />
            Enviar documentos
          </button>
          <div className="mx-4 my-1 h-px bg-(--border-default)" aria-hidden="true" />
          {MORE_LINKS.map(({ to, icon: Icon, label, match }) => {
            const active = location.pathname.startsWith(match);
            const badge = badges[to];
            return (
              <button
                key={to}
                data-item
                onClick={() => navigate(to)}
                aria-current={active ? "page" : undefined}
                className={`w-full flex items-center gap-3 px-4 min-h-11 text-mac-body transition-colors duration-fast ${
                  active ? "text-(--text-accent) font-medium" : "text-(--text-primary) hover:bg-(--bg-hover)"
                }`}
              >
                <Icon className="w-4 h-4" strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
                <span className="flex-1 text-left">{label}</span>
                {badge && (
                  <span className={`min-w-5 h-5 px-1.5 rounded-full text-mac-caption2 leading-5 font-semibold text-white text-center ${badge.tone === "danger" ? "bg-red-600" : "bg-teal-600"}`}>
                    <span className="sr-only">{badge.label}: </span>{badge.count}
                  </span>
                )}
              </button>
            );
          })}
          <button
            data-item
            onClick={() => toggleTheme()}
            className="w-full flex items-center gap-3 px-4 min-h-11 text-mac-body text-(--text-primary) hover:bg-(--bg-hover) transition-colors duration-fast"
          >
            {isDark ? <Sun className="w-4 h-4" aria-hidden="true" /> : <Moon className="w-4 h-4" aria-hidden="true" />}
            {isDark ? "Usar o tema claro" : "Usar o tema escuro"}
          </button>
        </div>
      )}

      <nav aria-label="Navegação principal" className="glass-panel glass-blur-panel glass-shadow glass-highlight-line fixed bottom-[calc(16px+env(safe-area-inset-bottom))] left-4 right-4 z-30 flex items-center rounded-(--radius-panel) py-1 md:hidden">
        {TABS.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              // Com a folha "Mais" aberta, só "Mais" fica marcada (sem duas abas ativas).
              `flex-1 min-w-0 min-h-11 flex flex-col items-center justify-center py-1 gap-0.5 text-[11px] rounded-stat transition-colors duration-fast active:bg-(--bg-hover) ${
                isActive && !moreOpen
                  ? "text-(--text-accent) font-semibold"
                  : "text-(--text-secondary) hover:text-(--text-primary)"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon className="w-5 h-5" strokeWidth={isActive && !moreOpen ? 2.25 : 1.75} aria-hidden="true" />
                <span className="truncate max-w-full">{label}</span>
              </>
            )}
          </NavLink>
        ))}
        <button
          ref={moreButtonRef}
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          aria-controls={moreOpen ? "folha-mais" : undefined}
          aria-label={moreBadge ? `Mais opções (${moreBadge.label})` : "Mais opções"}
          className={`relative flex-1 min-w-0 min-h-11 flex flex-col items-center justify-center py-1 gap-0.5 text-[11px] rounded-stat transition-colors duration-fast active:bg-(--bg-hover) ${
            moreOpen || moreActive ? "text-(--text-accent) font-semibold" : "text-(--text-secondary) hover:text-(--text-primary)"
          }`}
        >
          <MoreHorizontal className="w-5 h-5" strokeWidth={moreOpen || moreActive ? 2.25 : 1.75} aria-hidden="true" />
          <span className="truncate max-w-full">Mais</span>
          {moreBadge && !moreOpen && (
            <span aria-hidden="true" className={`absolute top-0.5 right-[calc(50%-18px)] w-2.5 h-2.5 rounded-full ring-2 ring-(--bg-card) ${moreBadge.tone === "danger" ? "bg-red-600" : "bg-teal-600"}`} />
          )}
        </button>
      </nav>
    </>
  );
}
