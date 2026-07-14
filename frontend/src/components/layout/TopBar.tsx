import { useState, useRef, useEffect } from "react";
import { Search, Upload, ChevronsUpDown, LogOut, User, Sun, Moon, Anchor, Settings, Building2 } from "lucide-react";
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
}

export default function TopBar({ onUploadClick }: TopBarProps) {
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
    <header className="glass-panel glass-blur-panel glass-shadow glass-highlight-line fixed top-3 md:top-5 left-3 md:left-5 right-3 md:right-5 z-40 h-[48px] flex items-center gap-3 px-4 rounded-[14px]">
      {/* Logo — morava na Sidebar; precisa de um lugar fixo agora que ela virou Dock.
          Só a marca (não o wordmark inteiro) pra não reabrir o problema de espaço
          que já resolvemos na TopBar mobile. */}
      <div className="brand-mark w-6 h-6 flex-shrink-0" role="img" aria-label="Docke" />
      <div className="w-px h-6 bg-[var(--border-default)] flex-shrink-0 hidden sm:block" />

      {/* Company selector */}
      {companies.length > 0 && (
        <div className="relative" ref={companyRef}>
          <button
            onClick={() => setCompanyOpen((v) => !v)}
            className="flex items-center gap-1.5 h-7 px-3 rounded-[6px] text-mac-body font-medium text-[var(--text-primary)] bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors duration-fast flex-1 min-w-0 max-w-[clamp(100px,calc(100vw_-_236px),280px)] md:flex-initial md:max-w-[320px]"
          >
            <Building2 className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-secondary)]" />
            <span className="truncate">{current?.name ?? "Selecionar empresa"}</span>
            <ChevronsUpDown className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-secondary)]" />
          </button>

          {companyOpen && (
            <div className="absolute top-full left-0 mt-1 w-56 glass-panel glass-blur-strong rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50">
              {companies.map((c) => (
                <button
                  key={c.id}
                  onClick={() => { setCurrent(c); setCompanyOpen(false); }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-mac-body text-left transition-colors duration-fast hover:bg-[var(--bg-hover)] rounded-[4px] mx-1 w-[calc(100%-8px)] ${
                    current?.id === c.id ? "text-teal-500 font-medium" : "text-[var(--text-primary)]"
                  }`}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Search trigger → opens Command Palette (busca já acessível via aba "Busca" na barra inferior no mobile) */}
      <button
        onClick={openPalette}
        className="hidden md:flex flex-1 max-w-[360px] items-center gap-2 h-7 pl-3.5 pr-2 bg-[var(--bg-hover)] rounded-full text-mac-body text-[var(--text-placeholder)] hover:bg-[rgba(0,0,0,0.06)] dark:hover:bg-[rgba(255,255,255,0.08)] transition-colors duration-fast"
      >
        <Search className="w-4 h-4 flex-shrink-0" />
        <span className="flex-1 text-left">Buscar documentos…</span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-mac-caption2 bg-[var(--bg-hover)] text-[var(--text-tertiary)] rounded-[4px]">
          Ctrl K
        </kbd>
      </button>

      {/* Busca — ícone isolado abaixo de md, abre o mesmo Command Palette */}
      <button
        onClick={openPalette}
        className="md:hidden w-7 h-7 flex items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
        aria-label="Buscar"
      >
        <Search className="w-4 h-4" />
      </button>

      <div className="flex-1" />

      {/* Upload — oculto na página Documentos (que já tem seu próprio botão) e abaixo de sm (espaço reservado pro avatar) */}
      {!onDocumentsPage && (
        <Button size="sm" onClick={onUploadClick} className="hidden sm:flex">
          <Upload className="w-3.5 h-3.5" />
          Upload
        </Button>
      )}

      {/* Cápsula de controles — agrupa ações secundárias num só bloco de vidro,
          estilo toolbar do macOS (Mail agrupa reply/archive/trash juntos em
          vez de espalhar ícones soltos pela barra). */}
      <div className="flex items-center gap-0.5 p-1 rounded-full bg-[var(--bg-hover)]">
        {/* Ancorados e Configurações — só na faixa md–lg (tablet), onde nem a barra
            inferior mobile (<md) nem o Dock desktop (lg+) estão visíveis. */}
        <button
          onClick={() => navigate("/favorites")}
          className={`hidden md:flex lg:hidden w-7 h-7 items-center justify-center rounded-full transition-colors duration-fast ${
            location.pathname.startsWith("/favorites")
              ? "text-teal-500 bg-teal-500/10"
              : "text-[var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/10"
          }`}
          aria-label="Ancorados"
          title="Ancorados"
        >
          <Anchor className="w-4 h-4" />
        </button>
        <span className="hidden md:block lg:hidden w-px h-4 bg-[var(--border-default)]" />
        <button
          onClick={() => navigate("/settings/profile")}
          className={`hidden md:flex lg:hidden w-7 h-7 items-center justify-center rounded-full transition-colors duration-fast ${
            location.pathname.startsWith("/settings")
              ? "text-teal-500 bg-teal-500/10"
              : "text-[var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/10"
          }`}
          aria-label="Configurações"
          title="Configurações"
        >
          <Settings className="w-4 h-4" />
        </button>
        <span className="hidden md:block lg:hidden w-px h-4 bg-[var(--border-default)]" />

        {/* Theme toggle — no mobile mora no menu "Mais" da barra inferior */}
        <button
          onClick={() => setIsDark(toggleTheme() === "dark")}
          className="hidden md:flex w-7 h-7 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-fast"
          title={isDark ? "Modo claro (Alt+D)" : "Modo escuro (Alt+D)"}
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
        <span className="hidden md:block w-px h-4 bg-[var(--border-default)]" />

        {/* Task Center */}
        <TaskCenter />
      </div>

      {/* Avatar menu */}
      <div className="relative" ref={avatarRef}>
        <button
          onClick={() => setAvatarOpen((v) => !v)}
          className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400"
        >
          <Avatar name={user?.full_name ?? user?.username ?? "?"} size="sm" />
        </button>

        {avatarOpen && (
          <div className="absolute top-full right-0 mt-1 w-48 glass-panel glass-blur-strong rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50">
            <div className="px-3 py-2 border-b border-[var(--border-default)]">
              <p className="text-mac-body font-medium text-[var(--text-primary)] truncate">{user?.full_name}</p>
              <p className="text-mac-caption text-[var(--text-secondary)] truncate">{user?.email}</p>
            </div>
            <button
              onClick={() => { setAvatarOpen(false); navigate("/settings/profile"); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-mac-body text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
            >
              <User className="w-4 h-4" />
              Perfil
            </button>
            <button
              onClick={() => { setAvatarOpen(false); logout(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-mac-body text-red-500 hover:bg-[var(--bg-hover)] transition-colors duration-fast"
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
