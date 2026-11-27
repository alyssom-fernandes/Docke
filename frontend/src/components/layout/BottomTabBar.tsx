import { useState, useRef, useEffect } from "react";
import { NavLink, useNavigate, useLocation } from "react-router-dom";
import { MoreHorizontal, Sun, Moon, Upload, Search, House, FolderClosed, CalendarClock, Anchor, Activity, Link2, Trash2, Settings, type LucideIcon } from "lucide-react";
import { toggleTheme, useIsDark } from "@/lib/theme";
import { useNavBadges } from "./navItems";
import { usePresence } from "@/hooks/usePresence";
import { useFeatures } from "@/lib/CompanyContext";

/**
 * Barra de abas do iOS 26: cápsula de vidro flutuante com três abas e
 * "Mais", e a busca num círculo de vidro separado à direita. A aba ativa
 * ganha a lente (cápsula clara por trás) e a cor do acento.
 */
interface Tab { to: string; icon: LucideIcon; label: string; match: string }
const TABS: Tab[] = [
  { to: "/dashboard", icon: House, label: "Início", match: "/dashboard" },
  { to: "/documents", icon: FolderClosed, label: "Documentos", match: "/documents" },
  { to: "/obligations", icon: CalendarClock, label: "Obrigações", match: "/obligations" },
];
const MORE: Tab[] = [
  { to: "/favorites", icon: Anchor, label: "Ancorados", match: "/favorites" },
  { to: "/activity", icon: Activity, label: "Atividade", match: "/activity" },
  { to: "/shares", icon: Link2, label: "Links", match: "/shares" },
  { to: "/trash", icon: Trash2, label: "Lixeira", match: "/trash" },
  { to: "/settings", icon: Settings, label: "Ajustes", match: "/settings" },
];

export default function BottomTabBar() {
  const [moreOpen, setMoreOpen] = useState(false);
  const isDark = useIsDark();
  const navigate = useNavigate();
  const location = useLocation();
  const sheetRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const badges = useNavBadges();
  const presence = usePresence(moreOpen, 150);
  const recursos = useFeatures();
  // Obrigações desligadas: Ancorados ocupa a terceira aba. Links some do "Mais" sem o recurso.
  const tabs = recursos.obrigacoes ? TABS : [TABS[0], TABS[1], MORE[0]];
  const more = MORE.filter((l) => (l.to !== "/shares" || recursos.links) && !tabs.includes(l));
  const moreActive = more.some((l) => location.pathname.startsWith(l.match));
  const searchActive = location.pathname.startsWith("/search");

  useEffect(() => {
    if (!moreOpen) return;
    function handle(e: MouseEvent) {
      if (sheetRef.current && !sheetRef.current.contains(e.target as Node) && !moreButtonRef.current?.contains(e.target as Node)) setMoreOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setMoreOpen(false); moreButtonRef.current?.focus(); }
    }
    document.addEventListener("mousedown", handle);
    document.addEventListener("keydown", onKey);
    window.setTimeout(() => sheetRef.current?.querySelector<HTMLButtonElement>("button[data-item]")?.focus(), 0);
    return () => { document.removeEventListener("mousedown", handle); document.removeEventListener("keydown", onKey); };
  }, [moreOpen]);

  useEffect(() => { setMoreOpen(false); }, [location.pathname, location.search]);

  const tabClass = (active: boolean) =>
    `relative flex min-w-0 flex-1 flex-col items-center justify-center gap-[3px] h-[52px] rounded-full text-[10px] font-semibold tracking-[0.01em] transition-colors duration-fast ${
      active ? "text-(--accent-vibrant) bg-(--control-fill)" : "text-(--text-primary)"
    }`;

  return (
    <>
      {presence.mounted && (
        <div
          ref={sheetRef}
          id="folha-mais"
          role="dialog"
          aria-label="Mais"
          className={`${presence.leaving ? "sheet-out" : "sheet-in"} glass-dialog glass-blur-strong shadow-modal fixed bottom-[calc(84px+env(safe-area-inset-bottom))] left-3 right-3 z-30 rounded-[26px] p-2`}
        >
          <div className="mac-group overflow-hidden">
            <button
              data-item
              onClick={() => navigate("/documents?acao=enviar")}
              className="flex w-full items-center gap-3 px-3.5 min-h-12 text-[17px] text-(--text-accent) active:bg-(--control-fill)"
            >
              <Upload className="size-5" aria-hidden="true" />
              Enviar documentos
            </button>
          </div>
          <div className="mac-group mt-2 overflow-hidden divide-y divide-(--separator-subtle)">
            {more.map(({ to, icon: Icon, label, match }) => {
              const active = location.pathname.startsWith(match);
              const badge = badges[to];
              return (
                <button
                  key={to}
                  data-item
                  onClick={() => navigate(to)}
                  aria-current={active ? "page" : undefined}
                  className="flex w-full items-center gap-3 px-3.5 min-h-12 text-[17px] text-(--text-primary) active:bg-(--control-fill)"
                >
                  <Icon className="size-5 text-(--accent-vibrant)" aria-hidden="true" />
                  <span className="flex-1 text-left">{label}</span>
                  {badge && <span className="text-[15px] text-(--text-secondary)"><span className="sr-only">{badge.label}: </span>{badge.count}</span>}
                </button>
              );
            })}
            <button
              data-item
              onClick={() => toggleTheme()}
              className="flex w-full items-center gap-3 px-3.5 min-h-12 text-[17px] text-(--text-primary) active:bg-(--control-fill)"
            >
              {isDark ? <Sun className="size-5 text-(--accent-vibrant)" aria-hidden="true" /> : <Moon className="size-5 text-(--accent-vibrant)" aria-hidden="true" />}
              {isDark ? "Usar o tema claro" : "Usar o tema escuro"}
            </button>
          </div>
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 flex items-end gap-2.5 px-3 pb-[calc(10px+env(safe-area-inset-bottom))]">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-[calc(96px+env(safe-area-inset-bottom))] bg-linear-to-t from-(--window-bg) via-(--window-bg)/80 to-transparent" />
        <nav aria-label="Navegação principal" className="glass-capsule relative flex h-[62px] min-w-0 flex-1 items-center px-1.5">
          {tabs.map(({ to, icon: Icon, label, match }) => {
            const badge = badges[to];
            return (
              <NavLink key={to} to={to} className={({ isActive }) => tabClass(isActive && !moreOpen && location.pathname.startsWith(match))}>
                <Icon className="size-[22px]" strokeWidth={1.75} aria-hidden="true" />
                <span className="max-w-full truncate px-0.5">{label}</span>
                {badge && <span aria-hidden className={`absolute right-[calc(50%-18px)] top-1.5 size-2 rounded-full ${badge.tone === "danger" ? "bg-red-600" : "bg-(--accent)"}`} />}
              </NavLink>
            );
          })}
          <button
            ref={moreButtonRef}
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            aria-controls={moreOpen ? "folha-mais" : undefined}
            className={tabClass(moreOpen || moreActive)}
          >
            <MoreHorizontal className="size-[22px]" strokeWidth={1.75} aria-hidden="true" />
            <span>Mais</span>
          </button>
        </nav>
        <NavLink
          to="/search"
          aria-label="Busca"
          className={`glass-capsule relative flex size-[62px] shrink-0 items-center justify-center rounded-full ${searchActive ? "text-(--accent-vibrant)" : "text-(--text-primary)"}`}
        >
          <Search className="size-6" strokeWidth={1.75} aria-hidden="true" />
        </NavLink>
      </div>
    </>
  );
}
