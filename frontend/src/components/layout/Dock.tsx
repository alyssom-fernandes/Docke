import { type ElementType } from "react";
import { NavLink } from "react-router-dom";
import { LayoutDashboard, FolderOpen, Search, Anchor, Link2, Activity, ShieldQuestion, Trash2, Settings } from "lucide-react";

// Navegação primária do desktop (lg+), estilo Dock do macOS: só ícone,
// flutuante — o Dock real nunca mostra rótulo de texto fixo sob o ícone,
// só tooltip no hover (título nativo do <NavLink>). Substitui a antiga
// Sidebar vertical — libera a largura que ela ocupava pro conteúdo
// (tabelas, cards) e usa o mesmo modelo mental da barra mobile.
// Desktop tem espaço de sobra (diferente do mobile), então todos os itens
// aparecem direto — sem menu "Mais" escondendo nada.
const ITEMS: Array<{ to: string; icon: ElementType; label: string }> = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Início" },
  { to: "/documents", icon: FolderOpen, label: "Docs" },
  { to: "/search", icon: Search, label: "Busca" },
  { to: "/favorites", icon: Anchor, label: "Ancorados" },
  { to: "/shares", icon: Link2, label: "Links" },
  { to: "/activity", icon: Activity, label: "Atividade" },
  { to: "/obligations", icon: ShieldQuestion, label: "Obrigações" },
  { to: "/trash", icon: Trash2, label: "Lixeira" },
  { to: "/settings/profile", icon: Settings, label: "Ajustes" },
];

function DockItem({ to, icon: Icon, label }: { to: string; icon: ElementType; label: string }) {
  return (
    <NavLink
      to={to}
      aria-label={label}
      className={({ isActive }) =>
        `group relative shrink-0 flex items-center justify-center w-10 h-10 pointer-coarse:w-11 pointer-coarse:h-11 rounded-[10px] transition-[background-color,color,transform] duration-150 active:scale-95 motion-reduce:active:scale-100 ${
          isActive
            ? "text-(--text-accent) bg-teal-500/12"
            : "text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover)"
        }`
      }
    >
      <Icon className="w-5 h-5" strokeWidth={1.5} aria-hidden />
      {/* Rótulo como no Dock do macOS: aparece no hover e também no foco do teclado. */}
      <span aria-hidden className="pointer-events-none absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full glass-panel glass-blur-strong shadow-dropdown px-2.5 py-1 text-mac-caption text-(--text-primary) opacity-0 translate-y-1 transition-[opacity,transform] duration-150 group-hover:opacity-100 group-hover:translate-y-0 group-focus-visible:opacity-100 group-focus-visible:translate-y-0">
        {label}
      </span>
    </NavLink>
  );
}

export default function Dock() {
  return (
    // A partir de 768 px (antes só ≥1024 px: no tablet não havia navegação — A2-01).
    <nav data-dock aria-label="Navegação principal" className="hidden md:flex fixed bottom-5 left-1/2 -translate-x-1/2 z-30 items-center gap-1 px-2 py-1.5 rounded-(--radius-panel) glass-panel glass-blur-panel glass-shadow glass-highlight-line">
      {ITEMS.map((item) => (
        <DockItem key={item.to} {...item} />
      ))}
    </nav>
  );
}
