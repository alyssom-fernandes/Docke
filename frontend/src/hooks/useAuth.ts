import { useEffect, useState } from "react";
import api from "@/lib/api";

export interface AuthUser {
  id: string;
  email?: string;
  username: string;
  full_name: string;
  role: string;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginDemo: () => Promise<void>;
  logout: () => void;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const stored = localStorage.getItem("docke_user");
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(!localStorage.getItem("docke_token") ? false : true);

  useEffect(() => {
    const token = localStorage.getItem("docke_token");
    if (!token) { setIsLoading(false); return; }
    api.get("/auth/me")
      .then((res) => {
        const u: AuthUser = {
          id: res.data.user_id,
          email: res.data.email,
          username: res.data.username,
          full_name: res.data.full_name,
          role: res.data.role,
        };
        setUser(u);
        localStorage.setItem("docke_user", JSON.stringify(u));
      })
      .catch(() => {
        localStorage.removeItem("docke_token");
        localStorage.removeItem("docke_user");
        setUser(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  async function applySession(accessToken: string) {
    localStorage.setItem("docke_token", accessToken);
    const me = await api.get("/auth/me");
    const u: AuthUser = {
      id: me.data.user_id,
      email: me.data.email,
      username: me.data.username,
      full_name: me.data.full_name,
      role: me.data.role,
    };
    setUser(u);
    localStorage.setItem("docke_user", JSON.stringify(u));
  }

  async function login(email: string, password: string) {
    const res = await api.post("/auth/login", { email, password });
    await applySession(res.data.access_token);
  }

  // Modo demo: a senha nunca fica no frontend — o backend guarda como
  // segredo (Fly secret) e faz o login por trás via /auth/demo-login.
  async function loginDemo() {
    const res = await api.post("/auth/demo-login");
    await applySession(res.data.access_token);
  }

  function logout() {
    localStorage.removeItem("docke_token");
    localStorage.removeItem("docke_user");
    setUser(null);
    window.location.href = "/login";
  }

  return { user, isLoading, login, loginDemo, logout };
}
