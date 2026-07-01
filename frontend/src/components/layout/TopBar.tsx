import { useState, useRef, useEffect } from "react";
import { Search, Upload, ChevronDown, LogOut, User, Sun, Moon, Menu } from "lucide-react";
import { toggleTheme, getTheme } from "@/lib/theme";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuthContext } from "@/lib/AuthContext";
import { useCompany } from "@/lib/CompanyContext";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import Avatar from "@/components/ui/Avatar";
import Button from "@/components/ui/Button";
import TaskCenter from "@/components/shared/TaskCenter";

interface TopBarProps {
  onUploadClick?: () => void;
  onMenuClick?: () => void;
}

export default function TopBar({ onUploadClick, onMenuClick }: TopBarProps) {
  const { user, logout } = useAuthContext();
  const { companies, current, setCurrent } = useCompany();
  const { open: openPalette } = useCommandPalette();
  const navigate = useNavigate();
  const location = useLocation();
  const onDocumentsPage = location.pathname.startsWith("/documents");

  const [companyOpen, setCompanyOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => getTheme() === "dark");

  const companyRef = useRef<HTMLDivElement>(null);
  const avatarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (companyRef.current && !companyRef.current.contains(e.target as Node)) setCompanyOpen(false);
      if (avatarRef.current && !avatarRef.current.contains(e.target as Node)) setAvatarOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.altKey && e.key === "d") setIsDark(toggleTheme() === "dark");
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  return (
    <header className="h-[56px] flex-shrink-0 flex items-center gap-3 px-4 bg-[var(--bg-card)] border-b border-[var(--border-default)]">
      {/* Hamburger — tablet/mobile only */}
      <button
        onClick={onMenuClick}
        className="lg:hidden w-8 h-8 flex items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
        aria-label="Abrir menu"
      >
        <Menu className="w-4 h-4" />
      </button>

      {/* Company selector */}
      {companies.length > 0 && (
        <div className="relative" ref={companyRef}>
          <button
            onClick={() => setCompanyOpen((v) => !v)}
            className="flex items-center gap-1.5 h-8 px-2.5 rounded-[8px] text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast max-w-[180px]"
          >
            <span className="truncate">{current?.name ?? "Selecionar empresa"}</span>
            <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-secondary)]" />
          </button>

          {companyOpen && (
            <div className="absolute top-full left-0 mt-1 w-56 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] shadow-dropdown py-1 z-50">
              {companies.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { setCurrent(c); setCompanyOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors duration-fast hover:bg-[var(--bg-hover)] ${
                    current?.id === c.id ? "text-teal-600 font-medium" : "text-[var(--text-primary)]"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search trigger → opens Command Palette */}
      <button
        onClick={openPalette}
        className="flex-1 max-w-[420px] flex items-center gap-2 h-8 pl-3 pr-2 bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-sm text-[var(--text-placeholder)] hover:border-teal-400 transition-colors duration-fast"
      >
        <Search className="w-4 h-4 flex-shrink-0" />
        <span className="flex-1 text-left">Buscar documentos…</span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs bg-[var(--bg-hover)] text-[var(--text-tertiary)] rounded border border-[var(--border-default)]">
          Ctrl K
        </kbd>
      </button>

      <div className="flex-1" />

      {/* Upload — oculto na página Documentos, que já tem seu próprio botão */}
      {!onDocumentsPage && (
        <Button size="sm" onClick={onUploadClick}>
          <Upload className="w-3.5 h-3.5" />
          Upload
        </Button>
      )}

      {/* Theme toggle */}
      <button
        onClick={() => setIsDark(toggleTheme() === "dark")}
        className="w-8 h-8 flex items-center justify-center rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
        title={isDark ? "Modo claro (Alt+D)" : "Modo escuro (Alt+D)"}
      >
        {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
      </button>

      {/* Task Center */}
      <TaskCenter />

      {/* Avatar menu */}
      <div className="relative" ref={avatarRef}>
        <button
          onClick={() => setAvatarOpen((v) => !v)}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
        >
          <Avatar name={user?.full_name ?? user?.username ?? "?"} size="sm" />
        </button>

        {avatarOpen && (
          <div className="absolute top-full right-0 mt-1 w-48 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] shadow-dropdown py-1 z-50">
            <div className="px-3 py-2 border-b border-[var(--border-default)]">
              <p className="text-sm font-medium text-[var(--text-primary)] truncate">{user?.full_name}</p>
              <p className="text-xs text-[var(--text-secondary)] truncate">{user?.email}</p>
            </div>
            <button
              onClick={() => { setAvatarOpen(false); navigate("/settings/profile"); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
            >
              <User className="w-4 h-4" />
              Perfil
            </button>
            <button
              onClick={() => { setAvatarOpen(false); logout(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-500 hover:bg-[var(--bg-hover)] transition-colors duration-fast"
            >
              <LogOut className="w-4 h-4" />
              Sair
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
