import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2, AlertCircle } from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";

// new URL(..., import.meta.url) é o padrão oficial documentado pelo pdfjs-dist
// pro Vite — usar o import "?url" direto causou UnknownErrorException aqui
// (mismatch de versão entre o worker cru servido por "?url" e o pacote
// pré-otimizado pelo Vite em node_modules/.vite/deps).
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// Renderiza o PDF em <canvas> próprio em vez de <iframe src={url}> — um
// iframe apontando pra um PDF carrega o visualizador NATIVO do navegador
// (barra de zoom/paginação/impressão cinza do Chrome/Edge), o elemento mais
// visível de todo o app que ainda "denunciava" ser um site, já que PDF é o
// tipo de arquivo mais comum aqui. Controles próprios abaixo, estilo Preview.app.
export default function PdfViewer({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<ReturnType<pdfjsLib.PDFPageProxy["render"]> | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    pdfjsLib.getDocument(url).promise
      .then((pdf) => {
        if (cancelled) return;
        pdfRef.current = pdf;
        setNumPages(pdf.numPages);
        setPage(1);
      })
      .catch(() => { if (!cancelled) setError("Não foi possível abrir o PDF."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      pdfRef.current?.destroy();
      pdfRef.current = null;
    };
  }, [url]);

  useEffect(() => {
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas || loading) return;

    let cancelled = false;
    pdf.getPage(page).then((pdfPage) => {
      if (cancelled) return;
      // Escala pra caber na largura do container, multiplicada pelo zoom do
      // usuário — o próprio zoom re-renderiza em resolução mais alta (não é
      // um transform: scale() borrando o texto, é um novo render nítido).
      const containerWidth = containerRef.current?.clientWidth ?? 800;
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const fitScale = (containerWidth - 48) / baseViewport.width;
      const viewport = pdfPage.getViewport({ scale: fitScale * zoom });

      const context = canvas.getContext("2d");
      if (!context) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = viewport.width * dpr;
      canvas.height = viewport.height * dpr;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      renderTaskRef.current?.cancel();
      const task = pdfPage.render({ canvasContext: context, viewport });
      renderTaskRef.current = task;
      task.promise.catch(() => {});
    });

    return () => { cancelled = true; };
  }, [page, zoom, loading]);

  if (loading) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-[var(--text-placeholder)] animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-center px-8">
        <AlertCircle className="w-10 h-10 text-[var(--text-placeholder)]" />
        <p className="text-mac-body text-[var(--text-secondary)]">{error}</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="w-full h-full flex flex-col bg-[var(--bg-page)]">
      <div className="flex-1 overflow-auto flex justify-center p-6">
        <canvas ref={canvasRef} className="rounded-[4px] shadow-[0_2px_16px_rgba(0,0,0,0.15)] bg-white" />
      </div>

      {/* Barra flutuante de navegação/zoom — mesma "cápsula" de vidro usada no
          Dock e na barra inferior mobile, igual ao Preview.app real. */}
      <div className="flex-shrink-0 flex justify-center pb-4 pointer-events-none">
        <div className="pointer-events-auto glass-panel glass-blur-strong glass-shadow rounded-full flex items-center gap-1 px-2 py-1.5">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="h-7 w-7 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-fast"
            aria-label="Página anterior"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-mac-caption text-[var(--text-secondary)] px-1.5 min-w-[64px] text-center tabular-nums">
            {page} de {numPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(numPages, p + 1))}
            disabled={page >= numPages}
            className="h-7 w-7 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-fast"
            aria-label="Próxima página"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="w-px h-4 bg-[var(--border-default)] mx-1" />
          <button
            onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
            disabled={zoom <= 0.5}
            className="h-7 w-7 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-fast"
            aria-label="Diminuir zoom"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-mac-caption text-[var(--text-secondary)] min-w-[40px] text-center tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
            disabled={zoom >= 3}
            className="h-7 w-7 flex items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-fast"
            aria-label="Aumentar zoom"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
