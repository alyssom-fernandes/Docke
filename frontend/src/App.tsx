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
import SettingsLayout from "@/pages/Settings/SettingsLayout";
import Profile from "@/pages/Settings/Profile";
import Organization from "@/pages/Settings/Organization";
import Users from "@/pages/Settings/Users";
import Security from "@/pages/Settings/Security";
import Preferences from "@/pages/Settings/Preferences";
import Onboarding, { isOnboardingComplete } from "@/components/shared/Onboarding";
import SessionExpiredOverlay from "@/components/shared/SessionExpiredOverlay";

function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { companies } = useCompany();
  const [done, setDone] = useState(isOnboardingComplete);

  const needsOnboarding = !done && companies.length === 0;

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
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 bg-teal-600 rounded-[8px] flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
              <circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="17"/><path d="M7 12a5 5 0 0 0 10 0"/><line x1="5" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="19" y2="12"/>
            </svg>
          </div>
          <span className="text-xl font-semibold text-[var(--text-primary)]">Docke</span>
        </div>
        <div className="w-5 h-5 border-2 border-teal-600 border-t-transparent rounded-full animate-spin" />
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
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="/settings/profile" replace />} />
              <Route path="profile" element={<Profile />} />
              <Route path="organization" element={<Organization />} />
              <Route path="users" element={<Users />} />
              <Route path="security" element={<Security />} />
              <Route path="preferences" element={<Preferences />} />
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
        <Route path="/*" element={<ProtectedRoutes />} />
      </Routes>
    </BrowserRouter>
  );
}
