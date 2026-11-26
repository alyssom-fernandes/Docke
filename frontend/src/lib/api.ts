import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
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

// Partida a frio: ao religar a máquina na Fly, o proxy pode chegar antes de o
// uvicorn abrir a porta. O erro volta sem cabeçalho de CORS, e o navegador o
// entrega como "Network Error". Uma nova tentativa, depois de uma pausa,
// costuma pegar a API já de pé. Só repete o que é seguro repetir: leituras e
// os dois logins, que não mudam nada além de emitir um token.
const COLD_START_RETRY_DELAY_MS = 3_000;
const RETRYABLE_POSTS = new Set(["/auth/login", "/auth/demo-login"]);

type RetryConfig = InternalAxiosRequestConfig & { _coldStartRetried?: boolean };

function shouldRetryColdStart(err: AxiosError): boolean {
  const config = err.config as RetryConfig | undefined;
  if (!config || config._coldStartRetried) return false;
  const method = (config.method ?? "get").toLowerCase();
  const safe =
    method === "get" || method === "head" || (method === "post" && RETRYABLE_POSTS.has(config.url ?? ""));
  if (!safe) return false;
  // Sem resposta nenhuma (conexão recusada) ou um 502/503 que o navegador conseguiu ler.
  if (err.response) return err.response.status === 502 || err.response.status === 503;
  return err.code === AxiosError.ERR_NETWORK;
}

let sessionExpiredFired = false;

api.interceptors.response.use(
  (res) => res,
  async (err: AxiosError) => {
    if (axios.isAxiosError(err) && shouldRetryColdStart(err)) {
      const config = err.config as RetryConfig;
      config._coldStartRetried = true;
      await new Promise((resolve) => setTimeout(resolve, COLD_START_RETRY_DELAY_MS));
      return api.request(config);
    }
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
