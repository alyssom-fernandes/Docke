import { type ElementType } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  FolderOpen,
  Search,
  Star,
  Trash2,
  Activity,
  Settings,
  ChevronLeft,
  ChevronRight,
  Anchor,
  X,
} from "lucide-react";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  onClose?: () => void;
}

const NAV = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Início" },
  { to: "/documents", icon: FolderOpen, label: "Documentos" },
  { to: "/search", icon: Search, label: "Busca" },
  { to: "/favorites", icon: Star, label: "Favoritos" },
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

export default function Sidebar({ collapsed, onToggle, onClose }: SidebarProps) {
  return (
    <aside
      className={`${collapsed ? "w-[56px]" : "w-[220px]"} h-full bg-[var(--bg-card)] border-r border-[var(--border-default)] flex flex-col transition-[width] duration-normal overflow-hidden flex-shrink-0`}
    >
      {/* Logo */}
      <div className="h-[56px] flex items-center px-3 gap-2 flex-shrink-0">
        <div className="w-7 h-7 bg-teal-600 rounded-[6px] flex items-center justify-center flex-shrink-0">
          <Anchor className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <span className="text-sm font-semibold text-[var(--text-primary)] whitespace-nowrap flex-1">
            Docke
          </span>
        )}
        {/* Close button — only visible in drawer mode (lg hidden) */}
        {onClose && !collapsed && (
          <button
            onClick={onClose}
            className="lg:hidden w-7 h-7 flex items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
            aria-label="Fechar menu"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Main nav */}
      <nav className="flex-1 py-2 flex flex-col gap-0.5 px-2 overflow-y-auto">
        {NAV.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} />
        ))}
      </nav>

      {/* Bottom */}
      <div className="py-2 px-2 flex flex-col gap-0.5 border-t border-[var(--border-default)]">
        {BOTTOM.map((item) => (
          <NavItem key={item.to} {...item} collapsed={collapsed} />
        ))}
        <button
          onClick={onToggle}
          className="flex items-center gap-2.5 h-9 px-2 rounded-[8px] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast w-full"
          title={collapsed ? "Expandir menu" : "Recolher menu"}
        >
          {collapsed ? (
            <ChevronRight className="w-4 h-4 flex-shrink-0" />
          ) : (
            <>
              <ChevronLeft className="w-4 h-4 flex-shrink-0" />
              <span className="whitespace-nowrap">Recolher</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
