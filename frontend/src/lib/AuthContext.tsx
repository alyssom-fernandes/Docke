import { createContext, useContext, ReactNode } from "react";
import { useAuth, AuthUser } from "@/hooks/useAuth";

interface AuthCtx {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
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
