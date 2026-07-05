import { type ElementType } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  FolderOpen,
  Search,
  Trash2,
  Activity,
  Settings,
  ChevronLeft,
  Anchor,
} from "lucide-react";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const NAV = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Início" },
  { to: "/documents", icon: FolderOpen, label: "Documentos" },
  { to: "/search", icon: Search, label: "Busca" },
  { to: "/favorites", icon: Anchor, label: "Ancorados" },
  { to: "/activity", icon: Activity, label: "Atividade" },
  { to: "/trash", icon: Trash2, label: "Lixeira" },
];

const BOTTOM = [
  { to: "/settings/profile", icon: Settings, label: "Configurações" },
];

function NavItem({ to, icon: Icon, label, collapsed }: { to: string; icon: ElementType; label: string; collapsed: boolean }) {
  return (
    <NavLink
      to={to}
      title={collapsed ? label : undefined}
      aria-label={label}
      className={({ isActive }) =>
        `flex items-center gap-2.5 h-9 px-2 rounded-[8px] text-sm transition-colors duration-fast whitespace-nowrap ${
          collapsed ? "justify-center" : ""
        } ${
          isActive
            ? "bg-teal-600/10 text-teal-600 font-medium"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
        }`
      }
    >
      <Icon className="w-4 h-4 flex-shrink-0" />
      {!collapsed && <span>{label}</span>}
    </NavLink>
  );
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className={`glass-panel glass-blur-panel glass-shadow glass-highlight-line relative ${
        collapsed ? "w-[76px] px-[10px]" : "w-[220px] px-3.5"
      } h-full py-5 flex flex-col transition-[width,padding] duration-normal overflow-hidden flex-shrink-0 rounded-[22px]`}
    >
      {/* Logo */}
      <div className={`flex items-center gap-2 flex-shrink-0 mb-4 ${collapsed ? "justify-center" : ""}`}>
        <div className="w-7 h-7 bg-teal-600 rounded-[6px] flex items-center justify-center flex-shrink-0">
          <Anchor className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap flex-1">
            Docke
          </span>
        )}
      </div>

      {/* Main nav */}
      <nav className="flex-1 flex flex-col gap-0.5 overflow-y-auto">
        {NAV.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} />
        ))}
      </nav>

      {/* Bottom */}
      <div className="pt-2 flex flex-col gap-0.5 border-t border-[var(--border-default)]">
        {BOTTOM.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} />
        ))}
        <button
          onClick={onToggle}
          className={`flex items-center gap-2.5 h-9 px-2 rounded-[8px] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast w-full ${collapsed ? "justify-center" : ""}`}
          title={collapsed ? "Expandir menu" : "Recolher menu"}
        >
          <ChevronLeft className={`w-4 h-4 flex-shrink-0 transition-transform duration-normal ${collapsed ? "rotate-180" : ""}`} />
          {!collapsed && <span className="whitespace-nowrap">Recolher</span>}
        </button>
      </div>
    </aside>
  );
}
