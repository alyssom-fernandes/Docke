const KEY = "docke-theme";

export function getTheme(): "light" | "dark" {
  const stored = localStorage.getItem(KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem(KEY, theme);
}

export function toggleTheme(): "light" | "dark" {
  const next = getTheme() === "dark" ? "light" : "dark";
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
    localStorage.removeItem(KEY);
    applyTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  } else {
    applyTheme(pref);
  }
}
