/**
 * Pré-carga do visualizador de PDF (X1-22, J1-12): o chunk do PdfViewer
 * (~146 KB comprimidos) baixa com o navegador ocioso quando a pasta aberta tem
 * PDF, e não no primeiro clique. Só uma vez por sessão.
 */
let pdfViewer: Promise<unknown> | null = null;

export function prefetchPdfViewer() {
  if (pdfViewer) return;
  const run = () => { pdfViewer = import("@/components/documents/PdfViewer").catch(() => { pdfViewer = null; }); };
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(run, { timeout: 3000 }); else window.setTimeout(run, 1500);
}
