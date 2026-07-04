import { NavLink } from "react-router-dom";
import { LayoutDashboard, FolderOpen, Search, Star, Activity, Settings } from "lucide-react";

const TABS = [
  { to: "/dashboard",         icon: LayoutDashboard, label: "Início" },
  { to: "/documents",         icon: FolderOpen,       label: "Docs" },
  { to: "/search",            icon: Search,           label: "Busca" },
  { to: "/favorites",         icon: Star,             label: "Favoritos" },
  { to: "/activity",          icon: Activity,         label: "Atividade" },
  { to: "/settings/profile",  icon: Settings,         label: "Ajustes" },
];

export default function BottomTabBar() {
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 bg-[var(--bg-card)] border-t border-[var(--border-default)] flex md:hidden">
      {TABS.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center py-2 gap-0.5 text-[10px] transition-colors duration-fast ${
              isActive
                ? "text-teal-600"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
            }`
          }
        >
          <Icon className="w-5 h-5" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
