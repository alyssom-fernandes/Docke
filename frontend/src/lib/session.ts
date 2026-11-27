import { clearViews } from "@/lib/viewCache";
/**
 * Tokens da sessão (acesso + renovação) num lugar só.
 *
 * "Manter conectado neste computador" ligado: localStorage (sobrevive a fechar
 * o navegador). Desligado: sessionStorage (some ao fechar a janela — o certo
 * num micro compartilhado de posto). O token de acesso dura 1 h e é renovado
 * em silêncio com o de renovação (achado A1-01 da avaliação de 25/11/2026).
 */
const ACCESS = "docke_token";
const REFRESH = "docke_refresh";
const EXPIRES = "docke_token_expires";
const REMEMBER = "docke_remember";

export interface SessionTokens {
  access_token: string;
  refresh_token?: string | null;
  expires_in?: number;
}

function read(key: string): string | null {
  return sessionStorage.getItem(key) ?? localStorage.getItem(key);
}

export function rememberChoice(): boolean {
  return localStorage.getItem(REMEMBER) !== "0";
}

export function getAccessToken(): string | null {
  return read(ACCESS);
}

export function getRefreshToken(): string | null {
  return read(REFRESH);
}

/** Momento (ms) em que o token de acesso vence, se conhecido. */
export function accessExpiresAt(): number | null {
  const v = Number(read(EXPIRES));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * `keepChoice`: a demo entra sem "manter conectado" mas não muda a escolha
 * que a pessoa fez para a conta dela neste computador.
 */
export function saveSession(tokens: SessionTokens, remember: boolean = rememberChoice(), keepChoice = false): void {
  if (!keepChoice) localStorage.setItem(REMEMBER, remember ? "1" : "0");
  const target = remember ? localStorage : sessionStorage;
  const other = remember ? sessionStorage : localStorage;
  for (const k of [ACCESS, REFRESH, EXPIRES]) other.removeItem(k);
  target.setItem(ACCESS, tokens.access_token);
  if (tokens.refresh_token) target.setItem(REFRESH, tokens.refresh_token);
  target.setItem(EXPIRES, String(Date.now() + (tokens.expires_in ?? 3600) * 1000));
}

export function clearSession(): void {
  clearViews();
  for (const s of [localStorage, sessionStorage]) {
    for (const k of [ACCESS, REFRESH, EXPIRES]) s.removeItem(k);
  }
}
