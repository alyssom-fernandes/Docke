import { NavLink } from "react-router-dom";
import { LayoutDashboard, FolderOpen, Search, Link2, Activity } from "lucide-react";

// Ancorados e Configurações moraram aqui antes — agora vivem como ícones na
// TopBar (lg:hidden), pra essa barra caber em 5 itens (o máximo recomendado
// pras diretrizes de navegação mobile do iOS/Android) sem precisar de um
// "Mais"/overflow. Compartilhados entrou no lugar, por ser uma superfície
// de segurança (links externos ativos) que vale ter à mão no celular.
const TABS = [
  { to: "/dashboard", icon: LayoutDashboard, label: "Início" },
  { to: "/documents", icon: FolderOpen, label: "Docs" },
  { to: "/search", icon: Search, label: "Busca" },
  { to: "/shares", icon: Link2, label: "Links" },
  { to: "/activity", icon: Activity, label: "Atividade" },
];

export default function BottomTabBar() {
  return (
    <nav className="glass-panel glass-blur-panel glass-shadow glass-highlight-line fixed bottom-3 left-3 right-3 z-30 flex items-center rounded-[22px] py-1.5 md:hidden">
      {TABS.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `flex-1 flex flex-col items-center justify-center py-1.5 gap-0.5 text-[10px] rounded-[16px] transition-colors duration-fast ${
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
