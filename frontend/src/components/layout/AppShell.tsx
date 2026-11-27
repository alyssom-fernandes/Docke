import { ReactNode, useCallback, useRef, useEffect, useState } from "react";
import { useUndoShortcut } from "@/lib/undo";
import { useNavigate, useLocation } from "react-router-dom";
import { PanelLeft, Search } from "lucide-react";
import Footer from "./Footer";
import CommandPalette from "@/components/shared/CommandPalette";
import KeyboardShortcuts from "@/components/shared/KeyboardShortcuts";
import FirstTimeTip from "@/components/shared/FirstTimeTip";
import ErrorBoundary from "@/components/shared/ErrorBoundary";
import TaskCenter from "@/components/shared/TaskCenter";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { prefetchCommonRoutes } from "@/lib/routePrefetch";
import { watchSegmented } from "@/lib/segmented";
import BottomTabBar from "./BottomTabBar";
import MobileTopBar from "./MobileTopBar";
import Sidebar from "./Sidebar";
import { NAV_ITEMS } from "./navItems";
import { WindowProvider, useWindow, ToolbarButton } from "./window";

interface AppShellProps {
  children: ReactNode;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Telas que ocupam a janela inteira e rolam por dentro (como o Finder). */
function isFullBleed(pathname: string) {
  return pathname.startsWith("/documents") || (pathname.startsWith("/settings") && window.matchMedia("(min-width: 768px)").matches);
}

function GlobalSearchPill() {
  const { open } = useCommandPalette();
  return (
    <button
      type="button"
      onClick={open}
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
      title={isMac ? "Buscar (⌘K)" : "Buscar (Ctrl+K)"}
      className="glass-capsule flex h-9 w-[200px] shrink-0 items-center gap-1.5 px-2.5 text-left hover:brightness-[0.98] dark:hover:brightness-125 focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)"
    >
      <Search className="size-[14px] shrink-0 text-(--text-secondary)" aria-hidden />
      <span className="truncate text-[13px] font-medium text-(--text-secondary)">Buscar</span>
    </button>
  );
}

function WindowToolbar({ scrolled }: { scrolled: boolean }) {
  const { setSlot, sidebarOpen, setSidebarOpen, headers, customSearch } = useWindow();
  const location = useLocation();
  const fallback = NAV_ITEMS.find((i) => location.pathname.startsWith(i.match))?.label ?? "Docke";
  // Callbacks estáveis: um ref novo a cada renderização soltava e prendia o espaço de novo (laço).
  const toolbarRef = useCallback((el: HTMLDivElement | null) => setSlot("toolbar", el), [setSlot]);
  const searchRef = useCallback((el: HTMLDivElement | null) => setSlot("search", el), [setSlot]);
  return (
    <header className={`window-toolbar ${scrolled ? "is-scrolled" : ""}`}>
      {!sidebarOpen && (
        <ToolbarButton label="Mostrar a barra lateral" onClick={() => setSidebarOpen(true)}>
          <PanelLeft aria-hidden />
        </ToolbarButton>
      )}
      {headers === 0 && <h1 className="toolbar-title truncate pl-1">{fallback}</h1>}
      <div ref={toolbarRef} className="flex min-w-0 flex-1 items-center gap-2" />
      <TaskCenter />
      <div ref={searchRef} className="contents" />
      {customSearch === 0 && <GlobalSearchPill />}
    </header>
  );
}

function Shell({ children }: AppShellProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { desktop, sidebarOpen, setSidebarOpen } = useWindow();
  const mainRef = useRef<HTMLElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const fullBleed = isFullBleed(location.pathname);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
    setScrolled(false);
  }, [location.pathname]);

  // Documentos e Busca pré-carregados com o navegador ocioso (A1-35).
  useEffect(() => { prefetchCommonRoutes(); }, []);
  // Segmentados mais largos que a tela rolam de lado, com a borda esmaecida.
  useEffect(() => watchSegmented(), []);

  // Ctrl/⌘ + Z desfaz a última ação em qualquer tela (FA-A2-03).
  useUndoShortcut();

  // Ctrl/⌘ + vírgula abre os Ajustes, como em todo app do Mac.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") { e.preventDefault(); navigate("/settings"); }
      if ((e.ctrlKey || e.metaKey) && e.altKey && e.key.toLowerCase() === "s") { e.preventDefault(); setSidebarOpen(!sidebarOpen); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navigate, sidebarOpen, setSidebarOpen]);

  const skipLink = (
    <a href="#conteudo" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[90] focus:rounded-full focus:bg-(--accent) focus:px-4 focus:py-2 focus:text-mac-body focus:text-white">
      Pular para o conteúdo
    </a>
  );

  const page = (
    <ErrorBoundary key={location.pathname}>
      <div className={fullBleed ? "page-enter flex h-full min-h-0 flex-col" : "page-enter flex-1"}>
        {children}
      </div>
    </ErrorBoundary>
  );

  if (!desktop) {
    return (
      <div className="relative h-dvh overflow-hidden bg-(--window-bg)">
        {skipLink}
        <MobileTopBar />
        <BottomTabBar />
        <main
          ref={mainRef}
          id="conteudo"
          tabIndex={-1}
          className={`h-full flex flex-col focus:outline-hidden ${fullBleed ? "overflow-hidden pt-[calc(60px+env(safe-area-inset-top))] pb-[calc(84px+env(safe-area-inset-bottom))]" : "overflow-y-auto px-4 pt-[calc(64px+env(safe-area-inset-top))] pb-[calc(104px+env(safe-area-inset-bottom))]"}`}
        >
          {page}
          {location.pathname.startsWith("/settings") && <Footer />}
        </main>
        <CommandPalette />
        <KeyboardShortcuts />
      </div>
    );
  }

  return (
    <div className="mac-window relative flex h-dvh overflow-hidden bg-(--window-bg)">
      {skipLink}
      {sidebarOpen && (
        <>
          {/* No tablet (768–1023 px) a barra lateral flutua sobre o conteúdo. */}
          <div aria-hidden onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-30 bg-black/20 lg:hidden" />
          <div className="sidebar-shell fixed inset-y-0 left-0 z-40 lg:static lg:z-auto">
            <Sidebar />
          </div>
        </>
      )}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <WindowToolbar scrolled={scrolled || fullBleed} />
        <main
          ref={mainRef}
          id="conteudo"
          tabIndex={-1}
          onScroll={fullBleed ? undefined : (e) => setScrolled(e.currentTarget.scrollTop > 2)}
          className={`min-h-0 flex-1 flex flex-col focus:outline-hidden ${fullBleed ? "overflow-hidden" : "overflow-y-auto px-6 pt-2 pb-10"}`}
        >
          {page}
          {location.pathname.startsWith("/settings") && !fullBleed && <Footer />}
        </main>
      </div>
      <CommandPalette />
      <KeyboardShortcuts />
      <FirstTimeTip />
    </div>
  );
}

export default function AppShell({ children }: AppShellProps) {
  return (
    <WindowProvider>
      <Shell>{children}</Shell>
    </WindowProvider>
  );
}
