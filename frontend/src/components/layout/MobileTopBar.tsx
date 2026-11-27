import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { User, SlidersHorizontal, Settings, LogOut } from "lucide-react";
import { useAuthContext } from "@/lib/AuthContext";
import Avatar from "@/components/ui/Avatar";
import Menu from "@/components/ui/Menu";
import TaskCenter from "@/components/shared/TaskCenter";
import CompanySwitcher from "./CompanySwitcher";

/**
 * Topo do celular no estilo do iOS 26: botões de vidro flutuando sobre o
 * conteúdo (empresa à esquerda; avisos e conta à direita), com o conteúdo
 * sumindo num degradê por baixo deles ao rolar.
 */
export default function MobileTopBar() {
  const { user, logout } = useAuthContext();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const nome = user?.full_name || user?.username || "Conta";

  return (
    <div className="fixed inset-x-0 top-0 z-30 pt-[env(safe-area-inset-top)]">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[calc(76px+env(safe-area-inset-top))] bg-linear-to-b from-(--window-bg) via-(--window-bg)/85 to-transparent" />
      <div className="relative flex items-center gap-2 px-4 pt-2.5">
        <CompanySwitcher variant="mobile" />
        <div className="flex-1" />
        <TaskCenter />
        <button
          ref={ref}
          type="button"
          onClick={() => setMenu((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label={`Conta de ${nome}`}
          className="glass-capsule flex size-9 items-center justify-center rounded-full focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
        >
          <Avatar name={nome} size="sm" />
        </button>
        {menu && ref.current && (
          <Menu
            anchor={ref.current}
            align="end"
            label={nome}
            onClose={() => setMenu(false)}
            items={[
              { label: "Perfil e conta", icon: <User />, onSelect: () => navigate("/settings/profile") },
              { label: "Ajustes", icon: <Settings />, onSelect: () => navigate("/settings") },
              { label: "Preferências", icon: <SlidersHorizontal />, onSelect: () => navigate("/settings/preferences") },
              { label: "Sair", icon: <LogOut />, danger: true, separatorBefore: true, onSelect: () => logout() },
            ]}
          />
        )}
      </div>
    </div>
  );
}
