import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { emitSessionExpired } from "@/lib/sessionEvents";

const API_ORIGIN = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

const api = axios.create({
  baseURL: API_ORIGIN + "/api/v1",
});

/** Acorda a API (a máquina na Fly desliga quando ociosa) enquanto o visitante
 * ainda está lendo a tela de login. Melhor esforço: erro aqui não importa. */
export function prewarmApi() {
  fetch(API_ORIGIN + "/health", { method: "GET", mode: "no-cors", cache: "no-store" }).catch(() => {});
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("docke_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

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

// Track whether we're already showing the session-expired overlay to avoid
// flooding the event bus when multiple concurrent requests all return 401.
let sessionExpiredFired = false;

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (axios.isAxiosError(err) && shouldRetryColdStart(err)) {
      const config = err.config as RetryConfig;
      config._coldStartRetried = true;
      await new Promise((resolve) => setTimeout(resolve, COLD_START_RETRY_DELAY_MS));
      return api.request(config);
    }
    if (err.response?.status === 401 && !sessionExpiredFired) {
      sessionExpiredFired = true;
      emitSessionExpired();
      // Reset flag after a delay so re-auth attempts can trigger it again if needed
      setTimeout(() => { sessionExpiredFired = false; }, 3000);
    }
    return Promise.reject(err);
  }
);

export default api;
