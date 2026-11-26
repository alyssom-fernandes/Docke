import { useEffect, useState } from "react";

const KEY = "docke-theme";
const EVENT = "docke:tema";

export function getTheme(): "light" | "dark" {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark" || stored === "light") return stored;
  // ADR-021: primeira sessão (sem preferência salva) sempre abre em modo
  // escuro — prefers-color-scheme do sistema não sobrepõe esse padrão.
  if (stored === null && localStorage.getItem(KEY + "-system") !== "1") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Aplica o tema na página. Avisa as barras (superior, inferior, ⌘K) para o
 * ícone não ficar desencontrado depois de trocar em Preferências (A2-11).
 */
export function applyTheme(theme: "light" | "dark", persist = true) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  if (persist) {
    localStorage.setItem(KEY, theme);
    localStorage.removeItem(KEY + "-system");
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: theme }));
}

export function toggleTheme(): "light" | "dark" {
  const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
  applyTheme(next);
  return next;
}

/** Preferência salva pelo usuário: "system" quando nada foi escolhido explicitamente. */
export function getThemePreference(): "light" | "dark" | "system" {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark" || stored === "light") return stored;
  return "system";
}

export function setThemePreference(pref: "light" | "dark" | "system") {
  if (pref === "system") {
    // Antes, "seguir o sistema" voltava a gravar o tema resolvido e na próxima
    // visita a preferência aparecia como explícita.
    localStorage.removeItem(KEY);
    localStorage.setItem(KEY + "-system", "1");
    applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", false);
  } else {
    applyTheme(pref);
  }
}

/** Tema atual, sempre em dia com qualquer troca feita em outro lugar. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const on = (e: Event) => setDark((e as CustomEvent).detail === "dark");
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return dark;
}
