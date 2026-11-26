/*
 * Service worker do Docke: só recebe o "Compartilhar" do celular (Web Share
 * Target, B4.5.7). Não guarda páginas nem respostas da API em cache: o app
 * continua sempre na versão publicada. Os arquivos compartilhados ficam num
 * cache próprio até a tela de envio lê-los (e apagá-los).
 */
const CACHE = "docke-compartilhado";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "POST" || url.origin !== self.location.origin || url.pathname !== "/compartilhar") return;
  event.respondWith((async () => {
    let n = 0;
    try {
      const form = await event.request.formData();
      const cache = await caches.open(CACHE);
      for (const req of await cache.keys()) await cache.delete(req);
      for (const f of form.getAll("arquivos")) {
        if (typeof f === "string" || !f.size) continue;
        await cache.put(`/compartilhado/${n++}`, new Response(f, {
          headers: { "Content-Type": f.type || "application/octet-stream", "X-Nome": encodeURIComponent(f.name || "arquivo") },
        }));
      }
    } catch {
      n = 0;
    }
    return Response.redirect(n ? "/documents?acao=compartilhado" : "/documents", 303);
  })());
});
