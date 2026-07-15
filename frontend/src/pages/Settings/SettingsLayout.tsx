import { Outlet, NavLink } from "react-router-dom";
import { User, Building2, Users as UsersIcon, Lock, Sliders, Archive, Tags } from "lucide-react";
import { useAuthContext } from "@/lib/AuthContext";
import { useCompany } from "@/lib/CompanyContext";

const TABS = [
  { to: "/settings/profile", icon: User, label: "Perfil", adminOnly: false, supremoOnly: false },
  { to: "/settings/organization", icon: Building2, label: "Organização", adminOnly: true, supremoOnly: false },
  { to: "/settings/users", icon: UsersIcon, label: "Usuários & Papéis", adminOnly: true, supremoOnly: false },
  { to: "/settings/metadata", icon: Tags, label: "Metadados", adminOnly: true, supremoOnly: false },
  { to: "/settings/security", icon: Lock, label: "Segurança", adminOnly: false, supremoOnly: false },
  { to: "/settings/preferences", icon: Sliders, label: "Preferências", adminOnly: false, supremoOnly: false },
  { to: "/settings/retention", icon: Archive, label: "Retenção", adminOnly: false, supremoOnly: true },
];

export default function SettingsLayout() {
  const { user } = useAuthContext();
  const { current } = useCompany();
  // "admin" aqui é por empresa (current.permission_level), não o papel global —
  // um admin comum de empresa tem papel global "usuario". supremo sempre vê tudo.
  const isSupremo = user?.role === "supremo";
  const canManage = isSupremo || current?.permission_level === "admin";
  const visibleTabs = TABS.filter((t) => {
    if (t.supremoOnly) return isSupremo;
    if (t.adminOnly) return canManage;
    return true;
  });

  return (
    <div>
      <h1 className="text-mac-title2 font-semibold text-[var(--text-primary)] mb-6">Configurações</h1>
      <div className="flex flex-col md:flex-row gap-6 max-w-[1100px] mx-auto">
        <nav className="flex md:flex-col gap-1 md:w-[200px] flex-shrink-0 overflow-x-auto">
          {visibleTabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                `flex items-center gap-2.5 h-9 px-3 rounded-full text-mac-body whitespace-nowrap transition-colors duration-fast ${
                  isActive
                    ? "bg-teal-500/10 text-teal-500 font-medium"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                }`
              }
            >
              <tab.icon className="w-4 h-4 flex-shrink-0" />
              {tab.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex-1 min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
