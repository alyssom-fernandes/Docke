import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCw, AlertCircle, PanelLeft, Maximize2, Printer, Loader2, MapPin } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();

/** Normaliza para busca sem acento nem caixa (achado X2-18 / A5-60). */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface PdfViewerHandle {
  /** Texto de cada página (camada nativa), para a busca interna. */
  pageTexts: () => Promise<string[]>;
  goToPage: (n: number) => void;
}

interface Props {
  url: string;
  /** Busca ativa: os trechos que batem são realçados na camada de texto. */
  query?: string;
  /** Página do resultado ativo da busca (rola até ela). */
  focusPage?: number | null;
  onLoaded?: (numPages: number) => void;
  /** Anotações (B2.4.6): pinos numa camada por cima da página, em coordenadas de 0 a 1. */
  pins?: { id: string; page: number; x: number; y: number; label: string; active?: boolean }[];
  /** Modo anotar: o próximo clique na página devolve o ponto. */
  annotating?: boolean;
  onPagePoint?: (page: number, x: number, y: number) => void;
  onPinClick?: (id: string) => void;
  /** Lembrar a página (B2.4.8): chave do documento/versão; reabrir volta onde parou. */
  rememberKey?: string;
}

type Fit = "largura" | "pagina";

/**
 * Visualizador de PDF no nível do Preview (achados A5-43..A5-50): páginas em
 * rolagem contínua (renderizadas quando aparecem), camada de texto
 * selecionável e lida pelo leitor de tela, realce da busca, miniaturas,
 * girar, ajustar à largura ou à página, zoom e atalhos (PageUp/PageDown,
 * Home/End, Ctrl + e Ctrl -). Redesenha ao redimensionar a janela.
 */
const PdfViewer = forwardRef<PdfViewerHandle, Props>(function PdfViewer({ url, query = "", focusPage = null, onLoaded, pins, annotating = false, onPagePoint, onPinClick, rememberKey }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<{ w: number; h: number }[]>([]);
  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(600);
  const [zoom, setZoom] = useState(1);
  // A cápsula de controles sai do caminho ao rolar para baixo e volta ao rolar
  // para cima, ao mexer o mouse ou ao focar pelo teclado (A5-47).
  const [controlsHidden, setControlsHidden] = useState(false);
  const lastScrollTop = useRef(0);
  const [fit, setFit] = useState<Fit>("largura");
  const [rotation, setRotation] = useState(0);
  const [page, setPage] = useState(1);
  const [thumbs, setThumbs] = useState(false);
  const [pageInput, setPageInput] = useState("1");
  // Imprimir (FA-A5-02): o PDF vira um blob do próprio site num quadro escondido e o navegador abre a impressão.
  const [imprimindo, setImprimindo] = useState(false);
  async function imprimir() {
    setImprimindo(true);
    try {
      const blob = await (await fetch(url)).blob();
      const href = URL.createObjectURL(blob);
      const quadro = document.createElement("iframe");
      quadro.style.position = "fixed";
      quadro.style.width = "0";
      quadro.style.height = "0";
      quadro.style.border = "0";
      quadro.src = href;
      quadro.onload = () => {
        try { quadro.contentWindow?.focus(); quadro.contentWindow?.print(); } catch { window.open(href, "_blank"); }
        window.setTimeout(() => { quadro.remove(); URL.revokeObjectURL(href); }, 60_000);
      };
      document.body.appendChild(quadro);
    } catch {
      window.open(url, "_blank");
    } finally {
      setImprimindo(false);
    }
  }
  const textCache = useRef<Map<number, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setPdf(null);
    setError(null);
    textCache.current.clear();
    const task = pdfjsLib.getDocument({ url });
    task.promise
      .then(async (doc) => {
        if (cancelled) return;
        const list: { w: number; h: number }[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const p = await doc.getPage(i);
          const v = p.getViewport({ scale: 1 });
          list.push({ w: v.width, h: v.height });
        }
        if (cancelled) return;
        setSizes(list);
        setPdf(doc);
        setPage(1);
        onLoaded?.(doc.numPages);
        // Volta à página em que a pessoa parou da última vez (B2.4.8).
        const salva = rememberKey ? Number(localStorage.getItem(`docke_pdf_pagina:${rememberKey}`)) : 0;
        if (salva > 1 && salva <= doc.numPages && !focusPage) {
          window.setTimeout(() => scrollRef.current?.querySelector<HTMLElement>(`[data-page="${salva}"]`)?.scrollIntoView({ block: "start" }), 120);
        }
      })
      .catch(() => { if (!cancelled) setError("Não foi possível abrir este PDF. Baixe o arquivo para conferir."); });
    return () => { cancelled = true; task.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // Redesenha ao redimensionar (A5-46).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); setHeight(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pdf]);

  const rotated = rotation % 180 !== 0;
  const scaleFor = useCallback((i: number) => {
    const s = sizes[i];
    if (!s) return 1;
    const pw = rotated ? s.h : s.w;
    const ph = rotated ? s.w : s.h;
    const base = fit === "largura" ? (width - 48) / pw : Math.min((width - 48) / pw, (height - 48) / ph);
    return Math.max(0.2, base * zoom);
  }, [sizes, rotated, fit, width, height, zoom]);

  const goToPage = useCallback((n: number) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-page="${n}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  useImperativeHandle(ref, () => ({
    goToPage,
    pageTexts: async () => {
      if (!pdf) return [];
      const out: string[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        if (!textCache.current.has(i)) {
          const tc = await (await pdf.getPage(i)).getTextContent();
          textCache.current.set(i, tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
        }
        out.push(textCache.current.get(i)!);
      }
      return out;
    },
  }), [pdf, goToPage]);

  useEffect(() => { if (focusPage) goToPage(focusPage); }, [focusPage, goToPage]);

  // Página atual pela rolagem.
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const delta = el.scrollTop - lastScrollTop.current;
    if (delta > 6 && el.scrollTop > 40) setControlsHidden(true);
    else if (delta < -6) setControlsHidden(false);
    lastScrollTop.current = el.scrollTop;
    const mid = el.scrollTop + el.clientHeight / 3;
    let current = 1;
    el.querySelectorAll<HTMLElement>("[data-page]").forEach((p) => {
      if (p.offsetTop <= mid) current = Number(p.dataset.page);
    });
    if (current !== page) {
      setPage(current); setPageInput(String(current));
      if (rememberKey) {
        try { if (current > 1) localStorage.setItem(`docke_pdf_pagina:${rememberKey}`, String(current)); else localStorage.removeItem(`docke_pdf_pagina:${rememberKey}`); } catch { /* sem espaço */ }
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "PageDown") { e.preventDefault(); goToPage(Math.min(sizes.length, page + 1)); }
    else if (e.key === "PageUp") { e.preventDefault(); goToPage(Math.max(1, page - 1)); }
    else if (e.key === "Home" && !mod) { e.preventDefault(); goToPage(1); }
    else if (e.key === "End" && !mod) { e.preventDefault(); goToPage(sizes.length); }
    else if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2))); }
    else if (mod && e.key === "-") { e.preventDefault(); setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2))); }
    else if (mod && e.key === "0") { e.preventDefault(); setZoom(1); }
  }

  if (error) {
    return (
      <div role="alert" className="w-full h-full flex flex-col items-center justify-center gap-3 text-center px-8">
        <AlertCircle className="w-10 h-10 text-(--text-tertiary)" aria-hidden />
        <p className="text-mac-body text-(--text-secondary)">{error}</p>
      </div>
    );
  }

  const btn = "h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) disabled:opacity-(--opacity-disabled) disabled:pointer-events-none";

  return (
    <div className="w-full h-full flex bg-(--bg-page)">
      {thumbs && pdf && (
        <nav aria-label="Miniaturas das páginas" className="hidden sm:block w-[132px] shrink-0 overflow-y-auto border-r border-(--border-default) p-2 space-y-2">
          {sizes.map((_, i) => (
            <button key={i} onClick={() => goToPage(i + 1)} aria-label={`Ir para a página ${i + 1}`} aria-current={page === i + 1 ? "page" : undefined}
              className={`block w-full rounded-(--radius-control) p-1 ${page === i + 1 ? "ring-2 ring-(--focus-ring)" : "hover:bg-(--bg-hover)"}`}>
              <PdfPage pdf={pdf} index={i} scale={100 / (rotated ? sizes[i].h : sizes[i].w)} rotation={rotation} thumbnail />
              <span className="block text-center text-mac-caption text-(--text-secondary) mt-0.5">{i + 1}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="relative flex-1 min-w-0 flex flex-col" onMouseMove={() => { if (controlsHidden) setControlsHidden(false); }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          tabIndex={0}
          role="document"
          aria-label="Páginas do PDF"
          className="flex-1 overflow-auto px-6 pt-6 pb-24 focus:outline-hidden"
        >
          {!pdf ? (
            <div className="mx-auto max-w-[720px] space-y-6" aria-label="Carregando PDF">
              {[0, 1].map((i) => <div key={i} className="aspect-[1/1.414] rounded-(--radius-badge) bg-(--bg-hover) animate-pulse" />)}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-6">
              {sizes.map((_, i) => (
                <div key={i} data-page={i + 1} aria-label={`Página ${i + 1} de ${sizes.length}`} role="region"
                  className={`relative ${annotating && rotation === 0 ? "cursor-crosshair" : ""}`}
                  onClick={annotating && rotation === 0 && onPagePoint ? (e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    onPagePoint(i + 1, Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
                  } : undefined}>
                  <PdfPage pdf={pdf} index={i} scale={scaleFor(i)} rotation={rotation} query={query} />
                  {/* Camada de anotações: o PDF não muda. Com a página girada na tela, os pinos ficam ocultos. */}
                  {rotation === 0 && pins?.filter((p) => p.page === i + 1).map((p) => (
                    <button key={p.id} type="button" title={p.label} aria-label={`Anotação na página ${i + 1}: ${p.label}`}
                      onClick={(e) => { e.stopPropagation(); onPinClick?.(p.id); }}
                      className={`absolute -translate-x-1/2 -translate-y-full drop-shadow-md focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) rounded-full ${p.active ? "text-amber-500 scale-125" : "text-teal-600"}`}
                      style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
                      <MapPin className="w-6 h-6 fill-white" aria-hidden />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Cápsula de controles (Preview.app). */}
        <div
          className={`absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none transition-[opacity,transform] duration-200 ${controlsHidden ? "opacity-0 translate-y-2" : ""}`}
          onFocusCapture={() => setControlsHidden(false)}
        >
          <div className={`${controlsHidden ? "pointer-events-none" : "pointer-events-auto"} glass-capsule rounded-full flex items-center gap-0.5 px-1.5 py-1`}>
            <button className={`${btn} hidden sm:flex`} onClick={() => setThumbs((v) => !v)} aria-label="Miniaturas" aria-pressed={thumbs}><PanelLeft className="w-4 h-4" aria-hidden /></button>
            <button className={btn} onClick={() => goToPage(Math.max(1, page - 1))} disabled={page <= 1} aria-label="Página anterior"><ChevronLeft className="w-4 h-4" aria-hidden /></button>
            <form onSubmit={(e) => { e.preventDefault(); const n = Number(pageInput); if (n >= 1 && n <= sizes.length) goToPage(n); }} className="flex items-center gap-1 text-mac-caption text-(--text-secondary)">
              <label htmlFor="pdf-pagina" className="sr-only">Página</label>
              <input id="pdf-pagina" value={pageInput} onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ""))} inputMode="numeric"
                className="w-9 h-7 rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) text-center text-(--text-primary) tabular-nums focus:outline-hidden focus:ring-2 focus:ring-(--focus-ring)" />
              <span aria-live="polite" className="tabular-nums pr-1">de {sizes.length || "…"}</span>
            </form>
            <button className={btn} onClick={() => goToPage(Math.min(sizes.length, page + 1))} disabled={page >= sizes.length} aria-label="Próxima página"><ChevronRight className="w-4 h-4" aria-hidden /></button>
            <span className="w-px h-4 bg-(--border-default) mx-1" aria-hidden />
            <button className={btn} onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))} aria-label="Diminuir zoom (Ctrl -)"><ZoomOut className="w-4 h-4" aria-hidden /></button>
            <span className="text-mac-caption text-(--text-secondary) min-w-[40px] text-center tabular-nums" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <button className={btn} onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} aria-label="Aumentar zoom (Ctrl +)"><ZoomIn className="w-4 h-4" aria-hidden /></button>
            <button className={`${btn} hidden sm:flex`} onClick={() => { setFit((f) => (f === "largura" ? "pagina" : "largura")); setZoom(1); }}
              aria-label={fit === "largura" ? "Ajustar à página" : "Ajustar à largura"} title={fit === "largura" ? "Ajustar à página" : "Ajustar à largura"}>
              <Maximize2 className="w-4 h-4" aria-hidden />
            </button>
            <button className={btn} onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Girar 90°"><RotateCw className="w-4 h-4" aria-hidden /></button>
            <button className={`${btn} hidden sm:flex`} onClick={imprimir} disabled={imprimindo} aria-label="Imprimir" title="Imprimir">
              {imprimindo ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Printer className="w-4 h-4" aria-hidden />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default PdfViewer;

/** Uma página: canvas + camada de texto; só desenha quando aparece na tela. */
function PdfPage({ pdf, index, scale, rotation, query = "", thumbnail = false }: {
  pdf: pdfjsLib.PDFDocumentProxy; index: number; scale: number; rotation: number; query?: string; thumbnail?: boolean;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const obs = new IntersectionObserver((entries) => { if (entries[0]?.isIntersecting) setVisible(true); }, { rootMargin: "800px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<pdfjsLib.PDFPageProxy["render"]> | null = null;
    pdf.getPage(index + 1).then(async (page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale, rotation });
      setDims({ w: viewport.width, h: viewport.height });
      if (!visible) return;
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      // A tela ocupa a folha inteira: no zoom, a página antiga cresce junto com
      // a folha (transição de 200 ms) até a nova renderização chegar (A5-48).
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderTask = page.render({ canvas: null, canvasContext: ctx, viewport });
      await renderTask.promise.catch(() => {});
      if (cancelled || thumbnail || !textRef.current) return;
      const container = textRef.current;
      container.replaceChildren();
      container.style.setProperty("--scale-factor", String(viewport.scale));
      container.style.setProperty("--total-scale-factor", String(viewport.scale));
      const layer = new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container, viewport });
      await layer.render().catch(() => {});
      if (!cancelled) highlight(container, query);
    });
    return () => { cancelled = true; renderTask?.cancel(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, index, scale, rotation, visible]);

  useEffect(() => { if (textRef.current) highlight(textRef.current, query); }, [query]);

  // Só anima depois do primeiro tamanho real (a entrada não "cresce" do provisório).
  const sized = useRef(false);
  const animate = sized.current && !thumbnail;
  if (dims) sized.current = true;
  return (
    <div ref={holder} className={`relative bg-white rounded-[3px] shadow-(--shadow-paper) ${animate ? "transition-[width,height] duration-200 ease-out motion-reduce:transition-none" : ""}`}
      style={dims ? { width: dims.w, height: dims.h } : { width: thumbnail ? 100 : 600, height: thumbnail ? 141 : 848 }}>
      <canvas ref={canvasRef} className="block rounded-[3px]" aria-hidden />
      {!thumbnail && <div ref={textRef} className="pdf-text-layer" />}
    </div>
  );
}

function highlight(container: HTMLElement, query: string) {
  const q = fold(query.trim());
  container.querySelectorAll("span.pdf-hit").forEach((s) => s.classList.remove("pdf-hit"));
  if (q.length < 2) return;
  container.querySelectorAll("span").forEach((s) => {
    if (fold(s.textContent ?? "").includes(q)) s.classList.add("pdf-hit");
  });
}
