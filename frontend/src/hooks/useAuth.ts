import { useEffect, useState } from "react";
import api, { cancelWaitingRequests, refreshAccessToken, resumeAfterReauth, scheduleRefresh } from "@/lib/api";
import { clearSession, getAccessToken, getRefreshToken, saveSession, SessionTokens } from "@/lib/session";

export interface AuthUser {
  id: string;
  email?: string;
  username: string;
  full_name: string;
  role: string;
  /** Senha provisória dada por um admin: troca no primeiro acesso (A9-16). */
  must_change_password?: boolean;
  /** Verificação em duas etapas: falta o código nesta sessão ou o cadastro do app. */
  mfa_pendente?: "verificar" | "cadastrar" | null;
}

interface AuthState {
  user: AuthUser | null;
  isLoading: boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  loginDemo: () => Promise<void>;
  logout: () => void;
  updateProfile: (fullName: string) => Promise<void>;
  passwordChanged: () => void;
  completeMfa: (tokens: SessionTokens) => Promise<void>;
  loginWithSession: (tokens: SessionTokens, remember?: boolean) => Promise<void>;
}

const LOGIN_TIMEOUT_MS = 20_000;
const DEMO_LOGIN_TIMEOUT_MS = 45_000;

function toUser(data: any): AuthUser {
  return {
    id: data.user_id,
    email: data.email,
    username: data.username,
    full_name: data.full_name,
    role: data.role,
    must_change_password: !!data.must_change_password,
    mfa_pendente: data.mfa_pendente ?? null,
  };
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const stored = localStorage.getItem("docke_user");
      return stored && getAccessToken() ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(!!getAccessToken());

  // A API recusou por falta do código (sessão renovada sem aal2, app ativado
  // em outro aparelho): mostra a tela do código sem esperar recarregar.
  useEffect(() => {
    function onMfa(e: Event) {
      const modo = (e as CustomEvent<string>).detail === "mfa_cadastrar" ? "cadastrar" : "verificar";
      setUser((prev) => (prev && prev.mfa_pendente !== modo ? { ...prev, mfa_pendente: modo } : prev));
    }
    window.addEventListener("docke:mfa", onMfa);
    return () => window.removeEventListener("docke:mfa", onMfa);
  }, []);

  useEffect(() => {
    if (!getAccessToken()) { setIsLoading(false); return; }
    (async () => {
      // Token vencido na abertura (aba fechada por horas): renova antes de
      // perguntar quem é — sem isso, quem voltava no dia seguinte caía no login.
      if (getRefreshToken()) {
        const exp = Number(localStorage.getItem("docke_token_expires") ?? sessionStorage.getItem("docke_token_expires"));
        if (exp && exp - Date.now() < 60_000) await refreshAccessToken();
      }
      try {
        const res = await api.get("/auth/me", { skipReauthWait: true } as any);
        const u = toUser(res.data);
        setUser(u);
        localStorage.setItem("docke_user", JSON.stringify(u));
        scheduleRefresh();
      } catch {
        clearSession();
        localStorage.removeItem("docke_user");
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  async function applySession(tokens: SessionTokens, remember?: boolean, keepChoice = false) {
    saveSession(tokens, remember, keepChoice);
    const me = await api.get("/auth/me");
    const u = toUser(me.data);
    // Empresa selecionada pertence à identidade anterior — trocar de conta
    // (ex.: sair da conta real e entrar no modo demo) sem que o CompanyProvider
    // desmonte/remonte deixaria a empresa antiga selecionada presa na tela,
    // mesmo com o usuário/avatar já corretos. Limpa sempre que o id muda.
    let previousUserId: string | null = null;
    try { previousUserId = JSON.parse(localStorage.getItem("docke_user") ?? "null")?.id ?? null; } catch { /* ignore */ }
    if (previousUserId !== u.id) {
      localStorage.removeItem("docke_company");
      cancelWaitingRequests();  // pedidos da conta anterior não seguem com a nova
    } else {
      resumeAfterReauth();  // mesma pessoa: refaz o que esbarrou na sessão vencida
    }
    setUser(u);
    localStorage.setItem("docke_user", JSON.stringify(u));
    scheduleRefresh();
  }

  // Tempo limite só nas chamadas de login — um limite global no axios
  // cortaria operações legitimamente longas (confirmar upload de 200MB,
  // conversão DOCX→PDF). A demo tem folga maior: a API na Fly desliga
  // quando ociosa (auto_stop) e a primeira requisição espera a máquina ligar.
  async function login(email: string, password: string, remember?: boolean) {
    const res = await api.post("/auth/login", { email, password }, { timeout: LOGIN_TIMEOUT_MS });
    await applySession(res.data, remember);
  }

  // Modo demo: a senha nunca fica no frontend — o backend guarda como
  // segredo (Fly secret) e faz o login por trás via /auth/demo-login.
  // Passkey (B4.5.8): o servidor já conferiu a assinatura e devolveu a sessão.
  async function loginWithSession(tokens: SessionTokens, remember?: boolean) {
    await applySession(tokens, remember);
  }

  async function loginDemo() {
    const res = await api.post("/auth/demo-login", undefined, { timeout: DEMO_LOGIN_TIMEOUT_MS });
    await applySession(res.data, false, true);
  }

  function logout() {
    // Revoga o token de renovação no servidor; a navegação não espera.
    if (getAccessToken()) api.post("/auth/logout").catch(() => {});
    window.setTimeout(() => {
      clearSession();
      localStorage.removeItem("docke_user");
      setUser(null);
      window.location.href = "/login";
    }, 150);
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

  // Código conferido: guarda a sessão verificada no mesmo lugar da atual
  // ("manter conectado" ou não) e relê quem sou.
  async function completeMfa(tokens: SessionTokens) {
    saveSession(tokens, !!localStorage.getItem("docke_token"), true);
    const me = await api.get("/auth/me");
    const u = toUser(me.data);
    setUser(u);
    localStorage.setItem("docke_user", JSON.stringify(u));
    scheduleRefresh();
    resumeAfterReauth();
  }

  function passwordChanged() {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, must_change_password: false };
      localStorage.setItem("docke_user", JSON.stringify(next));
      return next;
    });
  }

  return { user, isLoading, login, loginDemo, logout, updateProfile, passwordChanged, completeMfa, loginWithSession };
}
