/**
 * Controle segmentado mais largo que a tela (celular): ele rola de lado, e a
 * borda esmaece do lado em que há mais segmentos, como nas listas roláveis do
 * iOS. O segmento escolhido sempre fica à vista. Vale para todo .mac-segmented
 * que aparecer na página, sem cada tela precisar fazer nada.
 */
const seen = new WeakSet<Element>();

function updateFade(el: HTMLElement) {
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 2) {
    el.removeAttribute("data-fade");
    return;
  }
  const atStart = el.scrollLeft <= 2;
  const atEnd = el.scrollLeft >= max - 2;
  el.setAttribute("data-fade", atStart ? "end" : atEnd ? "start" : "both");
}

function revealSelected(el: HTMLElement) {
  const sel = el.querySelector<HTMLElement>('[aria-selected="true"],[aria-checked="true"],[aria-pressed="true"]');
  if (!sel) return;
  // Pela posição na tela: a borda esmaecida (32 px) não pode cobrir o escolhido.
  const er = el.getBoundingClientRect();
  const sr = sel.getBoundingClientRect();
  if (sr.right > er.right - 8) el.scrollLeft += sr.right - er.right + 36;
  else if (sr.left < er.left + 8) el.scrollLeft -= er.left - sr.left + 36;
}

function attach(el: HTMLElement) {
  if (seen.has(el)) return;
  seen.add(el);
  el.addEventListener("scroll", () => updateFade(el), { passive: true });
  new ResizeObserver(() => updateFade(el)).observe(el);
  // A largura certa dos segmentos só existe depois das fontes: aí, sim, o
  // escolhido vem para a vista (e de novo um instante depois, por garantia).
  const reveal = () => { revealSelected(el); updateFade(el); };
  document.fonts?.ready.then(reveal).catch(() => {});
  window.setTimeout(reveal, 350);
  updateFade(el);
}

export function watchSegmented(): () => void {
  let frame = 0;
  const scan = () => {
    frame = 0;
    document.querySelectorAll<HTMLElement>(".mac-segmented").forEach(attach);
  };
  scan();
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      // Segmento escolhido mudou: traz para a vista.
      if (r.type === "attributes" && r.target instanceof HTMLElement) {
        const parent = r.target.closest<HTMLElement>(".mac-segmented");
        if (parent) { revealSelected(parent); updateFade(parent); }
      }
    }
    if (!frame) frame = window.setTimeout(scan, 60);
  });
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-selected", "aria-checked", "aria-pressed"] });
  return () => { mo.disconnect(); if (frame) window.clearTimeout(frame); };
}
