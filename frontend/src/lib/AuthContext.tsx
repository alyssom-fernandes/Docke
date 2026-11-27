import { createContext, useContext, ReactNode } from "react";
import { useAuth, AuthUser } from "@/hooks/useAuth";
import type { SessionTokens } from "@/lib/session";

interface AuthCtx {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  loginDemo: () => Promise<void>;
  logout: () => void;
  updateProfile: (fullName: string) => Promise<void>;
  setAvatar: (url: string | null) => void;
  passwordChanged: () => void;
  completeMfa: (tokens: SessionTokens) => Promise<void>;
  loginWithSession: (tokens: SessionTokens, remember?: boolean) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  return <Ctx.Provider value={auth}>{children}</Ctx.Provider>;
}

export function useAuthContext() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuthContext must be used inside AuthProvider");
  return ctx;
}
