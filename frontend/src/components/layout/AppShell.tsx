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

const SIDEBAR_COLLAPSED_KEY = "docke-sidebar-collapsed";

export default function AppShell({ children }: AppShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1");
  const navigate = useNavigate();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-page)] p-3 md:p-5 gap-4">
      {/* Sidebar: só desktop (lg+) — navegação mobile é a BottomTabBar, sem drawer duplicado */}
      <div className="hidden lg:block">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => {
            setSidebarCollapsed((v) => {
              const next = !v;
              localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
              return next;
            });
          }}
        />
      </div>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden gap-4">
        <TopBar onUploadClick={() => navigate("/documents")} />
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
