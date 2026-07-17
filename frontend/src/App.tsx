import { useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { useAuthContext } from "@/lib/AuthContext";
import { CompanyProvider, useCompany } from "@/lib/CompanyContext";
import AppShell from "@/components/layout/AppShell";
import Login from "@/pages/Login";
import Dashboard from "@/pages/Dashboard";
import Documents from "@/pages/Documents";
import Search from "@/pages/Search";
import Trash from "@/pages/Trash";
import Activity from "@/pages/Activity";
import Favorites from "@/pages/Favorites";
import Shares from "@/pages/Shares";
import SettingsLayout, { SettingsIndex } from "@/pages/Settings/SettingsLayout";
import Profile from "@/pages/Settings/Profile";
import Organization from "@/pages/Settings/Organization";
import Users from "@/pages/Settings/Users";
import Metadata from "@/pages/Settings/Metadata";
import Security from "@/pages/Settings/Security";
import Preferences from "@/pages/Settings/Preferences";
import Retention from "@/pages/Settings/Retention";
import Onboarding, { isOnboardingComplete } from "@/components/shared/Onboarding";
import SessionExpiredOverlay from "@/components/shared/SessionExpiredOverlay";
import PublicShare from "@/pages/PublicShare";

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

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-[var(--bg-page)]">
        <div className="brand-wordmark w-[150px] h-[43px]" role="img" aria-label="Docke" />
        <div className="w-5 h-5 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return (
    <CompanyProvider enabled={!!user}>
      <SessionExpiredOverlay />
      <OnboardingGate>
        <AppShell>
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/documents" element={<Documents />} />
            <Route path="/search" element={<Search />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/favorites" element={<Favorites />} />
            <Route path="/shares" element={<Shares />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<SettingsIndex />} />
              <Route path="profile" element={<Profile />} />
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
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </AppShell>
      </OnboardingGate>
    </CompanyProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/s/:token" element={<PublicShare />} />
        <Route path="/*" element={<ProtectedRoutes />} />
      </Routes>
    </BrowserRouter>
  );
}
