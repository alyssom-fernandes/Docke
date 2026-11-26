import ForcePasswordChange from "@/components/shared/ForcePasswordChange";
import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuthContext } from "@/lib/AuthContext";
import { CompanyProvider, useCompany } from "@/lib/CompanyContext";
import AppShell from "@/components/layout/AppShell";
import Login from "@/pages/Login";
// Code splitting por rota: só o login entra no bundle inicial. Cada página
// interna vira um chunk próprio, baixado quando a rota é visitada — antes era
// um JS único com o app inteiro (pdf.js incluso) mesmo pra quem só via o login.
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Documents = lazy(() => import("@/pages/Documents"));
const Search = lazy(() => import("@/pages/Search"));
const Trash = lazy(() => import("@/pages/Trash"));
const Activity = lazy(() => import("@/pages/Activity"));
const Favorites = lazy(() => import("@/pages/Favorites"));
const Shares = lazy(() => import("@/pages/Shares"));
const Obligations = lazy(() => import("@/pages/Obligations"));
const SettingsLayout = lazy(() => import("@/pages/Settings/SettingsLayout"));
const SettingsIndex = lazy(() => import("@/pages/Settings/SettingsLayout").then((m) => ({ default: m.SettingsIndex })));
const Profile = lazy(() => import("@/pages/Settings/Profile"));
const Organization = lazy(() => import("@/pages/Settings/Organization"));
const Users = lazy(() => import("@/pages/Settings/Users"));
const Metadata = lazy(() => import("@/pages/Settings/Metadata"));
const Security = lazy(() => import("@/pages/Settings/Security"));
const Preferences = lazy(() => import("@/pages/Settings/Preferences"));
const Retention = lazy(() => import("@/pages/Settings/Retention"));
const AdminHome = lazy(() => import("@/pages/Settings/AdminHome"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
import ErrorBoundary from "@/components/shared/ErrorBoundary";
import Onboarding, { isOnboardingComplete } from "@/components/shared/Onboarding";
import SessionExpiredOverlay from "@/components/shared/SessionExpiredOverlay";
const PublicShare = lazy(() => import("@/pages/PublicShare"));
import NotFound from "@/pages/NotFound";

// Rotas do app que exigem sessão — sem sessão, essas levam ao login; qualquer
// outro endereço mostra a página de inexistente em vez de redirecionar em silêncio.
const APP_ROUTES = ["/dashboard", "/documents", "/search", "/trash", "/activity", "/favorites", "/shares", "/obligations", "/settings"];

function isAppRoute(pathname: string) {
  return pathname === "/" || APP_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
}

// Esqueleto de página no lugar do spinner solto (A1-35).
function PageFallback() {
  return (
    <div className="space-y-4 max-w-[1100px] w-full mx-auto" role="status" aria-label="Carregando">
      <div className="h-7 w-48 rounded-[6px] bg-(--bg-hover) animate-pulse" />
      <div className="h-4 w-72 max-w-full rounded-[6px] bg-(--bg-hover) animate-pulse" />
      <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 rounded-(--radius-panel) bg-(--bg-hover) animate-pulse" />)}</div>
      <div className="h-64 rounded-(--radius-panel) bg-(--bg-hover) animate-pulse" />
    </div>
  );
}

/** Validação da sessão: depois de 3 s explica a espera (partida a frio do servidor). */
function SessionCheck() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setSlow(true), 3000); return () => window.clearTimeout(t); }, []);
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-(--bg-page) px-6 text-center" role="status">
      <div className="brand-wordmark w-[150px] h-[43px]" role="img" aria-label="Docke" />
      <div className="w-5 h-5 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" aria-hidden="true" />
      <p className={`text-mac-caption text-(--text-secondary) transition-opacity duration-300 ${slow ? "opacity-100" : "opacity-0"}`}>
        Conectando ao servidor… depois de um tempo parado ele leva alguns segundos para acordar.
      </p>
    </div>
  );
}

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { companies, loading } = useCompany();
  const [done, setDone] = useState(isOnboardingComplete);

  // Espera o carregamento real terminar — sem isso, o assistente de primeiro
  // acesso pisca na tela pra QUALQUER usuário (companies começa vazio antes
  // do fetch resolver), sumindo assim que a lista real chega.
  const needsOnboarding = !done && !loading && companies.length === 0;

  return (
    <>
      {children}
      {needsOnboarding && <Onboarding onComplete={() => setDone(true)} />}
    </>
  );
}

function ProtectedRoutes() {
  const { user, isLoading } = useAuthContext();
  const location = useLocation();
  const { pathname } = location;

  if (isLoading) {
    return <SessionCheck />;
  }

  // Guarda o endereço pedido: depois de entrar, a pessoa volta para ele (achado A1-02).
  if (!user) return isAppRoute(pathname) ? <Navigate to="/login" replace state={{ from: location }} /> : <NotFound standalone />;

  return (
    <CompanyProvider enabled={!!user}>
      <SessionExpiredOverlay />
      {user.must_change_password && <ForcePasswordChange />}
      <OnboardingGate>
        <AppShell>
          <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/documents" element={<Documents />} />
            <Route path="/search" element={<Search />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/shares" element={<Shares />} />
            <Route path="/obligations" element={<Obligations />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<SettingsIndex />} />
              <Route path="profile" element={<Profile />} />
              <Route path="admin" element={<AdminHome />} />
              <Route path="organization" element={<Organization />} />
              <Route path="users" element={<Users />} />
              <Route path="metadata" element={<Metadata />} />
              <Route path="security" element={<Security />} />
              <Route path="preferences" element={<Preferences />} />
              <Route path="retention" element={<Retention />} />
              {/* Rotas antigas — mantidas para links/favoritos existentes */}
              <Route path="companies" element={<Navigate to="/settings/organization" replace />} />
              <Route path="permissions" element={<Navigate to="/settings/users" replace />} />
            </Route>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </AppShell>
      </OnboardingGate>
    </CompanyProvider>
  );
}

// O link de recuperação do Supabase pode cair em qualquer endereço do site
// (o "Site URL" configurado no painel); onde cair, leva para a tela certa.
if (typeof window !== "undefined" && /(^|[#&])type=recovery(&|$)/.test(window.location.hash) && window.location.pathname !== "/redefinir-senha") {
  window.history.replaceState(null, "", "/redefinir-senha" + window.location.hash);
}

export default function App() {
  return (
    <ErrorBoundary root>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/redefinir-senha" element={<Suspense fallback={<PageFallback />}><ResetPassword /></Suspense>} />
          <Route path="/s/:token" element={<Suspense fallback={<PageFallback />}><PublicShare /></Suspense>} />
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
