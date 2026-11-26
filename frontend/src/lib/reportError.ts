/*
 * Erros de JavaScript do app vão ao Sentry pelo backend (X3-11): sem script de
 * terceiro no navegador e sem dado pessoal (só mensagem, pilha e a rota sem
 * os parâmetros). No máximo 10 por página aberta.
 */
const API = (import.meta.env.VITE_API_URL ?? "http://localhost:8000") + "/api/v1";
let enviados = 0;
const vistos = new Set<string>();

export function reportError(err: unknown, contexto?: string) {
  if (!import.meta.env.PROD || enviados >= 10) return;
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Erro sem mensagem");
  const chave = `${e.message}|${(e.stack ?? "").split("\n")[1] ?? ""}`;
  if (vistos.has(chave)) return;
  vistos.add(chave);
  enviados++;
  fetch(`${API}/client-errors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({ message: `${contexto ? `[${contexto}] ` : ""}${e.name}: ${e.message}`.slice(0, 1000), stack: (e.stack ?? "").slice(0, 8000), path: window.location.pathname }),
  }).catch(() => {});
}

export function installErrorReporting() {
  window.addEventListener("error", (ev) => reportError(ev.error ?? ev.message, "janela"));
  window.addEventListener("unhandledrejection", (ev) => {
    const r = ev.reason;
    // Respostas de erro da API (axios) já aparecem para a pessoa; não são falha do app.
    if (r && typeof r === "object" && "isAxiosError" in r) return;
    reportError(r, "promessa");
  });
}
