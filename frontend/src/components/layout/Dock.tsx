import { NavLink } from "react-router-dom";
import { NAV_ITEMS, useNavBadges, type NavItem, type NavBadge } from "./navItems";
import { prefetchRoute } from "@/lib/routePrefetch";

// Navegação principal a partir de 768 px, como o Dock do macOS: só ícone,
// rótulo no hover e no foco. Todos os destinos à vista (sem "Mais").
function DockItem({ to, icon: Icon, label, badge }: NavItem & { badge?: NavBadge }) {
  return (
    <NavLink
      to={to}
      onMouseEnter={() => prefetchRoute(to)}
      onFocus={() => prefetchRoute(to)}
      aria-label={badge ? `${label} (${badge.label})` : label}
      className={({ isActive }) =>
        `group relative shrink-0 flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 rounded-[10px] transition-[background-color,color,transform] duration-150 active:scale-90 active:bg-(--bg-pressed,var(--bg-hover)) motion-reduce:active:scale-100 ${
          isActive
            ? "text-(--text-accent) bg-teal-500/12"
            : "text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover)"
        }`
      }
    >
      {({ isActive }) => (
        <>
          <Icon className="w-5 h-5" strokeWidth={isActive ? 2 : 1.5} aria-hidden />
          {badge && (
            <span aria-hidden className={`absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full text-[10px] leading-4 font-semibold text-white text-center ring-2 ring-(--bg-card) ${badge.tone === "danger" ? "bg-red-600" : "bg-teal-600"}`}>
              {badge.count > 99 ? "99+" : badge.count}
            </span>
          )}
          {/* Rótulo como no Dock do macOS: aparece no hover e também no foco do teclado. */}
          <span aria-hidden className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full glass-dialog glass-blur-strong shadow-dropdown px-2.5 py-1 text-mac-caption text-(--text-primary) opacity-0 translate-y-1 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-hover:translate-y-0 group-focus-visible:opacity-100 group-focus-visible:translate-y-0">
            {badge ? `${label} · ${badge.label}` : label}
          </span>
        </>
      )}
    </NavLink>
  );
}

export default function Dock() {
  const badges = useNavBadges();
  return (
    // A partir de 768 px (antes só ≥1024 px: no tablet não havia navegação — A2-01).
    <nav data-dock aria-label="Navegação principal" className="hidden md:flex fixed bottom-[calc(20px+env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 z-30 items-center gap-1 px-2 py-1.5 rounded-(--radius-panel) glass-panel glass-blur-panel glass-shadow glass-highlight-line">
      {NAV_ITEMS.map((item) => (
        <DockItem key={item.to} {...item} badge={badges[item.to]} />
      ))}
    </nav>
  );
}
