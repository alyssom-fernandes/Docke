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
  updateProfile: (fullName: string) => Promise<void>;
}

const LOGIN_TIMEOUT_MS = 20_000;
const DEMO_LOGIN_TIMEOUT_MS = 45_000;

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
    // Empresa selecionada pertence à identidade anterior — trocar de conta
    // (ex.: sair da conta real e entrar no modo demo) sem que o CompanyProvider
    // desmonte/remonte deixaria a empresa antiga selecionada presa na tela,
    // mesmo com o usuário/avatar já corretos. Limpa sempre que o id muda.
    let previousUserId: string | null = null;
    try { previousUserId = JSON.parse(localStorage.getItem("docke_user") ?? "null")?.id ?? null; } catch { /* ignore */ }
    if (previousUserId !== u.id) localStorage.removeItem("docke_company");
    setUser(u);
    localStorage.setItem("docke_user", JSON.stringify(u));
  }

  // Tempo limite só nas chamadas de login — um limite global no axios
  // cortaria operações legitimamente longas (confirmar upload de 200MB,
  // conversão DOCX→PDF). A demo tem folga maior: a API na Fly desliga
  // quando ociosa (auto_stop) e a primeira requisição espera a máquina ligar.
  async function login(email: string, password: string) {
    const res = await api.post("/auth/login", { email, password }, { timeout: LOGIN_TIMEOUT_MS });
    await applySession(res.data.access_token);
  }

  // Modo demo: a senha nunca fica no frontend — o backend guarda como
  // segredo (Fly secret) e faz o login por trás via /auth/demo-login.
  async function loginDemo() {
    const res = await api.post("/auth/demo-login", undefined, { timeout: DEMO_LOGIN_TIMEOUT_MS });
    await applySession(res.data.access_token);
  }

  function logout() {
    localStorage.removeItem("docke_token");
    localStorage.removeItem("docke_user");
    setUser(null);
    window.location.href = "/login";
  }

  // Fase 10.3: atualiza o nome no backend e reflete no estado global de
  // uma vez (avatar da TopBar, menu de usuário etc. reagem sozinhos).
  async function updateProfile(fullName: string) {
    const res = await api.patch("/auth/me", { full_name: fullName });
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, full_name: res.data.full_name };
      localStorage.setItem("docke_user", JSON.stringify(next));
      return next;
    });
  }

  return { user, isLoading, login, loginDemo, logout, updateProfile };
}
