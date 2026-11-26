/*
 * Service worker do Docke: recebe o "Compartilhar" do celular (Web Share
 * Target, B4.5.7) e mostra os avisos por push (B4.4.5). Não guarda páginas
 * nem respostas da API em cache: o app
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

// Avisos no celular (B4.4.5): o conteúdo chega cifrado e o navegador decifra.
self.addEventListener("push", (event) => {
  let dados = {};
  try { dados = event.data ? event.data.json() : {}; } catch { dados = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(dados.title || "Docke", {
    body: dados.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: dados.tag,
    data: { url: dados.url || "/dashboard" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/dashboard", self.location.origin).href;
  event.waitUntil((async () => {
    const janelas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const aberta = janelas.find((c) => c.url.startsWith(self.location.origin));
    if (aberta) { await aberta.focus(); return aberta.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
