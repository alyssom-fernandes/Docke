import { ReactNode, useState, useRef, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import CommandPalette from "@/components/shared/CommandPalette";
import ErrorBoundary from "@/components/shared/ErrorBoundary";
import BottomTabBar from "./BottomTabBar";

interface AppShellProps {
  children: ReactNode;
}

export default function AppShell({ children }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // Close drawer on navigation
  useEffect(() => {
    setDrawerOpen(false);
    mainRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-page)]">
      {/* Drawer overlay (tablet/mobile) */}
      {drawerOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-30 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      {/* Sidebar: static on lg+, drawer on tablet/mobile */}
      <div
        className={`
          fixed lg:static inset-y-0 left-0 z-40 lg:z-auto
          transition-transform duration-normal
          ${drawerOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
      >
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          onClose={() => setDrawerOpen(false)}
        />
      </div>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar
          onUploadClick={() => navigate("/documents")}
          onMenuClick={() => setDrawerOpen((v) => !v)}
        />
        <main ref={mainRef} className="flex-1 overflow-y-auto p-6 pb-20 md:pb-6">
          <ErrorBoundary key={location.pathname}>
            <div className="page-enter">
              {children}
            </div>
          </ErrorBoundary>
        </main>
      </div>

      {/* Bottom tab bar (mobile only) */}
      <BottomTabBar />

      <CommandPalette />
    </div>
  );
}
