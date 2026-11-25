import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import { emitSessionExpired } from "@/lib/sessionEvents";
import { accessExpiresAt, clearSession, getAccessToken, getRefreshToken, saveSession } from "@/lib/session";

const API_ORIGIN = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

const api = axios.create({
  baseURL: API_ORIGIN + "/api/v1",
});

/** Acorda a API (a máquina na Fly desliga quando ociosa) enquanto o visitante
 * ainda está lendo a tela de login. Melhor esforço: erro aqui não importa. */
export function prewarmApi() {
  fetch(API_ORIGIN + "/health", { method: "GET", mode: "no-cors", cache: "no-store" }).catch(() => {});
}

// Rotas de entrada: um 401 nelas é senha errada, não sessão vencida.
const AUTH_ENTRY = ["/auth/login", "/auth/demo-login", "/auth/refresh", "/auth/forgot-password", "/auth/reset-password", "/auth/mfa/verify"];

let refreshing: Promise<string | null> | null = null;

/** Renova o token de acesso com o de renovação (uma renovação por vez). */
export function refreshAccessToken(): Promise<string | null> {
  if (!refreshing) {
    refreshing = (async () => {
      const refresh = getRefreshToken();
      if (!refresh) return null;
      try {
        const r = await axios.post(`${API_ORIGIN}/api/v1/auth/refresh`, { refresh_token: refresh }, { timeout: 20_000 });
        saveSession(r.data);
        scheduleRefresh();
        return r.data.access_token as string;
      } catch (e) {
        // Renovação recusada (revogada, conta desativada): a sessão acabou.
        if ((e as AxiosError).response) clearSession();
        return null;
      } finally {
        window.setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

let refreshTimer: number | undefined;

/** Renova 2 min antes de vencer, para nenhuma ação esbarrar no token velho. */
export function scheduleRefresh() {
  window.clearTimeout(refreshTimer);
  const at = accessExpiresAt();
  if (!at || !getRefreshToken()) return;
  const wait = Math.max(5_000, at - Date.now() - 120_000);
  refreshTimer = window.setTimeout(() => { refreshAccessToken(); }, Math.min(wait, 2 ** 31 - 1));
}

// Ao voltar para a aba depois de horas, renova antes da primeira ação.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    const at = accessExpiresAt();
    if (document.visibilityState === "visible" && at && at - Date.now() < 180_000) refreshAccessToken();
  });
}

api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

/**
 * Pedidos que esbarraram em sessão vencida sem renovação possível esperam a
 * pessoa digitar a senha de novo (SessionExpiredOverlay) e são reenviados —
 * antes a ação se perdia (achado A1-27).
 */
type Waiting = { retry: () => void; cancel: () => void };
const waiting: Waiting[] = [];

export function resumeAfterReauth() {
  waiting.splice(0).forEach((w) => w.retry());
}

export function cancelWaitingRequests() {
  waiting.splice(0).forEach((w) => w.cancel());
}

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean; skipReauthWait?: boolean };

let sessionExpiredFired = false;

api.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    const cfg = err.config as RetriableConfig | undefined;
    const isEntry = AUTH_ENTRY.some((p) => cfg?.url?.startsWith(p));
    if (err.response?.status !== 401 || !cfg || isEntry) return Promise.reject(err);

    if (!cfg._retried) {
      cfg._retried = true;
      const token = await refreshAccessToken();
      if (token) {
        cfg.headers.Authorization = `Bearer ${token}`;
        return api(cfg);
      }
    }

    if (cfg.skipReauthWait) return Promise.reject(err);

    if (!sessionExpiredFired) {
      sessionExpiredFired = true;
      emitSessionExpired();
      window.setTimeout(() => { sessionExpiredFired = false; }, 3000);
    }
    return new Promise((resolve, reject) => {
      waiting.push({
        retry: () => {
          cfg.headers.Authorization = `Bearer ${getAccessToken()}`;
          resolve(api(cfg));
        },
        cancel: () => reject(err),
      });
    });
  }
);

export default api;
