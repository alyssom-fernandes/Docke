import { type ElementType } from "react";
import { NavLink } from "react-router-dom";
import { LayoutDashboard, FolderOpen, Search, Anchor, Link2, Activity, Trash2, Settings } from "lucide-react";

// Navegação primária do desktop (lg+), estilo dock: ícone + rótulo, flutuante,
// substitui a antiga Sidebar vertical — libera a largura que ela ocupava pro
// conteúdo (tabelas, cards) e usa o mesmo modelo mental da barra mobile.
// Desktop tem espaço de sobra (diferente do mobile), então todos os itens
// aparecem direto — sem menu "Mais" escondendo nada.
const ITEMS: Array<{ to: string; icon: ElementType; label: string }> = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Início" },
  { to: "/documents", icon: FolderOpen, label: "Docs" },
  { to: "/search", icon: Search, label: "Busca" },
  { to: "/favorites", icon: Anchor, label: "Ancorados" },
  { to: "/shares", icon: Link2, label: "Links" },
  { to: "/activity", icon: Activity, label: "Atividade" },
  { to: "/trash", icon: Trash2, label: "Lixeira" },
  { to: "/settings/profile", icon: Settings, label: "Ajustes" },
];

function DockItem({ to, icon: Icon, label }: { to: string; icon: ElementType; label: string }) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      className={({ isActive }) =>
        `flex-shrink-0 flex flex-col items-center justify-center gap-0.5 px-2.5 py-1.5 rounded-[8px] text-mac-caption transition-colors duration-fast ${
          isActive
            ? "text-teal-500 bg-teal-500/10"
            : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
        }`
      }
    >
      <Icon className="w-5 h-5" strokeWidth={1.5} />
      <span className="whitespace-nowrap leading-none">{label}</span>
    </NavLink>
  );
}

export default function Dock() {
  return (
    <nav className="hidden lg:flex fixed bottom-5 left-1/2 -translate-x-1/2 z-30 items-center gap-1 px-2 py-1.5 rounded-[var(--radius-panel)] glass-panel glass-blur-panel glass-shadow glass-highlight-line">
      {ITEMS.map((item) => (
        <DockItem key={item.to} {...item} />
      ))}
    </nav>
  );
}
