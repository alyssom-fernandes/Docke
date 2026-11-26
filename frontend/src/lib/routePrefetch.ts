/**
 * Pré-carga do código das telas (A1-35, A2-14): ao passar o mouse num item
 * do Dock e, depois de entrar, com o navegador ocioso para as mais usadas.
 * O import() é o mesmo dos lazy() do App, então o navegador reaproveita.
 */
const LOADERS: Record<string, () => Promise<unknown>> = {
  "/dashboard": () => import("@/pages/Dashboard"),
  "/documents": () => import("@/pages/Documents"),
  "/search": () => import("@/pages/Search"),
  "/favorites": () => import("@/pages/Favorites"),
  "/shares": () => import("@/pages/Shares"),
  "/activity": () => import("@/pages/Activity"),
  "/obligations": () => import("@/pages/Obligations"),
  "/trash": () => import("@/pages/Trash"),
  "/settings": () => import("@/pages/Settings/SettingsLayout"),
};

const done = new Set<string>();

export function prefetchRoute(path: string) {
  const key = Object.keys(LOADERS).find((k) => path === k || path.startsWith(k + "/") || path.startsWith(k + "?"));
  if (!key || done.has(key)) return;
  done.add(key);
  LOADERS[key]().catch(() => done.delete(key));
}

/** Depois de entrar: Documentos e Busca com o navegador ocioso. */
export function prefetchCommonRoutes() {
  const run = () => { prefetchRoute("/documents"); prefetchRoute("/search"); };
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(run, { timeout: 4000 }); else window.setTimeout(run, 2500);
}
