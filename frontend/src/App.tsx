import ForcePasswordChange from "@/components/shared/ForcePasswordChange";
import MfaGate from "@/components/shared/MfaGate";
import { lazy, Suspense, useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuthContext } from "@/lib/AuthContext";
import { CompanyProvider, useCompany } from "@/lib/CompanyContext";
import AppShell from "@/components/layout/AppShell";
import Wallpaper from "@/components/layout/Wallpaper";
import { Loader } from "lucide-react";
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
const Privacy = lazy(() => import("@/pages/Settings/Privacy"));
const Features = lazy(() => import("@/pages/Settings/Features"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
import ErrorBoundary from "@/components/shared/ErrorBoundary";
import Onboarding, { isOnboardingComplete } from "@/components/shared/Onboarding";
import SessionExpiredOverlay from "@/components/shared/SessionExpiredOverlay";
const PublicShare = lazy(() => import("@/pages/PublicShare"));
const TitularChannel = lazy(() => import("@/pages/TitularChannel"));
const PublicUpload = lazy(() => import("@/pages/PublicUpload"));
import NotFound from "@/pages/NotFound";
import TitleTips from "@/components/ui/TitleTips";

// Rotas do app que exigem sessão — sem sessão, essas levam ao login; qualquer
// outro endereço mostra a página de inexistente em vez de redirecionar em silêncio.
const APP_ROUTES = ["/dashboard", "/documents", "/search", "/trash", "/activity", "/favorites", "/shares", "/obligations", "/settings"];

function isAppRoute(pathname: string) {
  return pathname === "/" || APP_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"));
}

// Esqueleto de página no lugar do spinner solto (A1-35).
// Esqueleto com a forma da tela que vai abrir (B4.6.3, A2-41): lista,
// ajustes ou painel, para a página não pular quando o conteúdo chega.
const sk = "rounded-(--radius-control) bg-(--bg-hover) animate-pulse";
function PageFallback() {
  const path = typeof window !== "undefined" ? window.location.pathname : "";
  const linhas = (n: number, h = "h-12") => (
    <div className="glass-panel rounded-(--radius-panel) divide-y divide-(--border-default) overflow-hidden">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className={`flex items-center gap-3 px-4 ${h}`}>
          <div className={`w-8 h-8 shrink-0 ${sk}`} />
          <div className="flex-1 space-y-1.5"><div className={`h-3.5 ${sk}`} style={{ width: `${55 - (i % 3) * 12}%` }} /><div className={`h-3 w-1/3 ${sk}`} /></div>
        </div>
      ))}
    </div>
  );
  if (path.startsWith("/documents")) {
    return (
      <div className="space-y-3 w-full" role="status" aria-label="Carregando">
        <div className="flex items-center gap-2"><div className={`h-8 w-40 ${sk}`} /><div className="flex-1" /><div className={`h-8 w-24 ${sk}`} /><div className={`h-8 w-8 ${sk}`} /></div>
        <div className={`h-9 ${sk}`} />
        {linhas(10, "h-12")}
      </div>
    );
  }
  if (path.startsWith("/settings")) {
    return (
      <div className="flex gap-6 w-full max-w-[1100px] mx-auto" role="status" aria-label="Carregando">
        <div className="hidden md:block w-56 shrink-0 space-y-2">{Array.from({ length: 9 }).map((_, i) => <div key={i} className={`h-7 ${sk}`} />)}</div>
        <div className="flex-1 space-y-4"><div className={`h-7 w-48 ${sk}`} /><div className={`h-40 rounded-(--radius-panel) ${sk}`} /><div className={`h-40 rounded-(--radius-panel) ${sk}`} /></div>
      </div>
    );
  }
  if (["/search", "/activity", "/shares", "/favorites", "/trash"].some((p) => path.startsWith(p))) {
    return (
      <div className="space-y-4 max-w-[1100px] w-full mx-auto" role="status" aria-label="Carregando">
        <div className={`h-7 w-48 ${sk}`} />
        <div className={`h-9 ${sk}`} />
        {linhas(8, "h-14")}
      </div>
    );
  }
  return (
    <div className="space-y-4 max-w-[1100px] w-full mx-auto" role="status" aria-label="Carregando">
      <div className={`h-7 w-48 ${sk}`} />
      <div className={`h-4 w-72 max-w-full ${sk}`} />
      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="min-h-[68px] sm:min-h-[96px] rounded-(--radius-panel) bg-(--bg-hover) animate-pulse" />)}</div>
      <div className="h-64 rounded-(--radius-panel) bg-(--bg-hover) animate-pulse" />
    </div>
  );
}

/** Carregando uma página pública: o papel de parede já aparece, sem o esqueleto do app. */
function PublicFallback() {
  return (
    <div className="wallpaper-screen relative isolate min-h-dvh flex items-center justify-center p-4" role="status" aria-label="Carregando">
      <Wallpaper fixed />
      <div className="glass-panel w-full max-w-[440px] rounded-(--radius-panel) p-6 space-y-3">
        <div className={`h-12 w-12 mx-auto ${sk}`} />
        <div className={`h-4 w-2/3 mx-auto ${sk}`} />
        <div className={`h-3 w-1/2 mx-auto ${sk}`} />
        <div className={`h-10 mt-4 ${sk}`} />
      </div>
    </div>
  );
}

/** Validação da sessão: depois de 3 s explica a espera (partida a frio do servidor). */
function SessionCheck() {
  const [slow, setSlow] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setSlow(true), 3000); return () => window.clearTimeout(t); }, []);
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-(--window-bg) px-6 text-center" role="status">
      <div className="brand-wordmark w-[150px] h-[43px]" role="img" aria-label="Docke" />
      <Loader className="w-5 h-5 animate-spin text-(--text-secondary)" aria-hidden="true" />
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

  // Falta o código do app autenticador (ou o cadastro dele): nada do app carrega antes.
  if (user.mfa_pendente) return <MfaGate modo={user.mfa_pendente} />;

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
              <Route path="features" element={<Features />} />
              <Route path="users" element={<Users />} />
              <Route path="metadata" element={<Metadata />} />
              <Route path="security" element={<Security />} />
              <Route path="preferences" element={<Preferences />} />
              <Route path="privacy" element={<Privacy />} />
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
          <Route path="/redefinir-senha" element={<Suspense fallback={<PublicFallback />}><ResetPassword /></Suspense>} />
          <Route path="/s/:token" element={<Suspense fallback={<PublicFallback />}><PublicShare /></Suspense>} />
          <Route path="/titular/:companyId" element={<Suspense fallback={<PublicFallback />}><TitularChannel /></Suspense>} />
          <Route path="/enviar/:token" element={<Suspense fallback={<PublicFallback />}><PublicUpload /></Suspense>} />
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
        <TitleTips />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
