import { useState, useRef, useEffect } from "react";
import { Search, Upload, LogOut, User, Sun, Moon, Anchor, Settings, SlidersHorizontal, Keyboard } from "lucide-react";
import { toggleTheme, useIsDark } from "@/lib/theme";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuthContext } from "@/lib/AuthContext";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import Avatar from "@/components/ui/Avatar";
import Button from "@/components/ui/Button";
import Tooltip from "@/components/ui/Tooltip";
import Menu from "@/components/ui/Menu";
import TaskCenter from "@/components/shared/TaskCenter";
import { openKeyboardShortcuts } from "@/components/shared/KeyboardShortcuts";
import CompanySwitcher from "./CompanySwitcher";

interface TopBarProps {
  onUploadClick?: () => void;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export default function TopBar({ onUploadClick }: TopBarProps) {
  const { user, logout } = useAuthContext();
  const { open: openPalette } = useCommandPalette();
  const navigate = useNavigate();
  const location = useLocation();
  const onDocumentsPage = location.pathname.startsWith("/documents");
  const isDark = useIsDark();
  const [avatarOpen, setAvatarOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      // Alt+D sozinho abre a barra de endereço no Chrome/Edge (A2-10): o tema usa Alt+Shift+D.
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === "d") { e.preventDefault(); toggleTheme(); }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  const nome = user?.full_name || user?.username || "Conta";

  return (
    <header className="glass-panel glass-blur-panel glass-shadow glass-highlight-line fixed top-3 md:top-5 left-3 md:left-5 right-3 md:right-5 z-40 h-[48px] flex items-center gap-3 px-4 rounded-[14px]">
      {/* Só a marca (não o wordmark inteiro) para caber no celular. */}
      <div className="brand-mark w-6 h-6 shrink-0" role="img" aria-label="Docke" />
      <div className="w-px h-6 bg-(--border-default) shrink-0 hidden sm:block" aria-hidden="true" />

      <CompanySwitcher />

      {/* Gatilho da paleta ⌘K (no celular, o ícone ao lado). */}
      <button
        onClick={openPalette}
        aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
        className="hidden md:flex flex-1 max-w-[360px] items-center gap-2 h-7 pl-3.5 pr-2 bg-(--bg-hover) rounded-full text-mac-body hover:bg-[rgba(0,0,0,0.06)] dark:hover:bg-[rgba(255,255,255,0.08)] transition-colors duration-fast"
      >
        <Search className="w-4 h-4 shrink-0 text-(--text-secondary)" aria-hidden="true" />
        <span className="flex-1 text-left text-(--text-secondary) truncate">Buscar documentos, pastas e ações…</span>
        <kbd className="hidden lg:inline text-mac-caption2 text-(--text-secondary) border border-(--border-default) rounded px-1" aria-hidden="true">{isMac ? "⌘ K" : "Ctrl K"}</kbd>
      </button>

      <button
        onClick={openPalette}
        className="md:hidden w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 flex items-center justify-center rounded-[6px] text-(--text-secondary) hover:bg-(--bg-hover) transition-colors duration-fast shrink-0"
        aria-label="Buscar documentos, pastas e ações"
      >
        <Search className="w-4 h-4" aria-hidden="true" />
      </button>

      <div className="flex-1" />

      {/* Enviar: fora de Documentos (que tem o próprio botão) e acima de sm. */}
      {/* O Button tem inline-flex próprio, que vencia o "hidden": o botão
          aparecia no celular e espremia o seletor de empresa. */}
      {!onDocumentsPage && (
        <span className="hidden sm:block shrink-0">
          <Button size="sm" onClick={onUploadClick}>
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            Enviar
          </Button>
        </span>
      )}

      {/* Cápsula de controles, como a barra de ferramentas do macOS. */}
      <div className="flex items-center gap-0.5 p-1 pointer-coarse:p-0 rounded-full bg-(--bg-hover) shrink-0">
        {/* Ancorados e Ajustes só na faixa md–lg, onde não há Dock nem barra inferior. */}
        <Tooltip label="Ancorados">
          <button
            onClick={() => navigate("/favorites")}
            aria-label="Ancorados"
            aria-current={location.pathname.startsWith("/favorites") ? "page" : undefined}
            className={`hidden md:flex lg:hidden w-7 h-7 items-center justify-center rounded-full transition-colors duration-fast ${
              location.pathname.startsWith("/favorites")
                ? "text-(--text-accent) bg-(--tint-accent)"
                : "text-(--text-secondary) hover:bg-black/5 dark:hover:bg-white/10"
            }`}
          >
            <Anchor className="w-4 h-4" aria-hidden="true" />
          </button>
        </Tooltip>
        <span className="hidden md:block lg:hidden w-px h-4 bg-(--border-default)" aria-hidden="true" />
        <Tooltip label="Ajustes">
          <button
            onClick={() => navigate("/settings/profile")}
            aria-label="Ajustes"
            aria-current={location.pathname.startsWith("/settings") ? "page" : undefined}
            className={`hidden md:flex lg:hidden w-7 h-7 items-center justify-center rounded-full transition-colors duration-fast ${
              location.pathname.startsWith("/settings")
                ? "text-(--text-accent) bg-(--tint-accent)"
                : "text-(--text-secondary) hover:bg-black/5 dark:hover:bg-white/10"
            }`}
          >
            <Settings className="w-4 h-4" aria-hidden="true" />
          </button>
        </Tooltip>
        <span className="hidden md:block lg:hidden w-px h-4 bg-(--border-default)" aria-hidden="true" />

        {/* Tema: no celular mora no "Mais" da barra inferior. */}
        <Tooltip label={isDark ? "Tema claro (Alt+Shift+D)" : "Tema escuro (Alt+Shift+D)"}>
          <button
            onClick={() => toggleTheme()}
            aria-label={isDark ? "Usar o tema claro" : "Usar o tema escuro"}
            aria-keyshortcuts="Alt+Shift+D"
            className="hidden md:flex w-7 h-7 items-center justify-center rounded-full text-(--text-secondary) hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-fast"
          >
            {isDark ? <Sun className="w-4 h-4" aria-hidden="true" /> : <Moon className="w-4 h-4" aria-hidden="true" />}
          </button>
        </Tooltip>
        <span className="hidden md:block w-px h-4 bg-(--border-default)" aria-hidden="true" />

        <TaskCenter />
      </div>

      {/* Menu da conta (A2-08, A2-09): role=menu, setas, Esc, Preferências e Atalhos. */}
      <button
        ref={avatarRef}
        onClick={() => setAvatarOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={avatarOpen}
        aria-label={`Conta de ${nome}`}
        title={user?.email ? `${nome} · ${user.email}` : nome}
        className="rounded-full shrink-0 pointer-coarse:p-1.5 pointer-coarse:-m-1.5 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
      >
        <Avatar name={nome} size="sm" />
      </button>
      {avatarOpen && avatarRef.current && (
        <Menu
          anchor={avatarRef.current}
          align="end"
          label={`Conta de ${nome}`}
          onClose={() => setAvatarOpen(false)}
          items={[
            { label: "Perfil e conta", icon: <User />, onSelect: () => navigate("/settings/profile") },
            { label: "Preferências", icon: <SlidersHorizontal />, onSelect: () => navigate("/settings/preferences") },
            { label: "Atalhos do teclado", icon: <Keyboard />, shortcut: "?", onSelect: () => openKeyboardShortcuts() },
            { label: "Sair", icon: <LogOut />, danger: true, separatorBefore: true, onSelect: () => logout() },
          ]}
        />
      )}
    </header>
  );
}
