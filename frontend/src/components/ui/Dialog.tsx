import { ReactNode, RefObject, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, createContext, useContext, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Diálogo acessível — a base de todos os modais (achados A2-38, X1-01, X1-02):
 * role="dialog" + aria-modal, título e descrição ligados, foco inicial, Tab
 * preso dentro, Esc fecha (só o diálogo de cima), foco volta para quem abriu,
 * o resto da página fica inerte e sem rolagem. Entra e sai com movimento
 * curto (respeita "reduzir movimento"). No celular vira uma folha que sobe
 * da borda de baixo, com área segura.
 */

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const stack: string[] = [];

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export interface DialogProps {
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  /** Elemento que recebe o foco ao abrir (padrão: primeiro campo ou o próprio diálogo). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Enquanto true, Esc e clique fora não fecham (operação em andamento). */
  busy?: boolean;
  /** Título só para leitor de tela (quando o conteúdo já tem cabeçalho visual próprio). */
  hideTitle?: boolean;
  /** Botão X no canto (padrão: sim). */
  showClose?: boolean;
  /** Cabeçalho próprio no lugar do título padrão (o título continua ligado ao diálogo). */
  header?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Ponto da tela de onde o diálogo cresce e para onde volta (Quick Look, A5-38). */
  origin?: { x: number; y: number } | null;
}

// Fechar com a saída animada a partir de qualquer ponto de dentro do diálogo
// (ex.: o X próprio do cabeçalho do visualizador, A5-38).
const DialogCloseContext = createContext<(() => void) | null>(null);
export function DialogCloseButton({ className, label, children }: { className?: string; label: string; children: ReactNode }) {
  const close = useContext(DialogCloseContext);
  return <button type="button" className={className} onClick={() => close?.()} aria-label={label}>{children}</button>;
}

const WIDTH = {
  sm: "sm:max-w-[400px]", md: "sm:max-w-[480px]", lg: "sm:max-w-[640px]", xl: "sm:max-w-[880px]",
  // Visualizador: ocupa a tela (até 1400 px) — em 1440/1920 o PDF não fica pequeno.
  full: "sm:max-w-[min(1400px,96vw)] h-[94dvh] sm:h-[min(92dvh,1100px)]",
};

export default function Dialog({
  onClose, title, description, children, footer, size = "md", initialFocusRef, busy = false,
  hideTitle = false, showClose = true, className = "", bodyClassName = "", header, origin = null,
}: DialogProps) {
  // Deslocamento do centro da tela até o item de origem, lido uma vez ao abrir.
  const [qo] = useState(() => (origin && window.matchMedia("(min-width: 640px)").matches && !reducedMotion()
    ? { "--qo-x": `${Math.round(origin.x - window.innerWidth / 2)}px`, "--qo-y": `${Math.round(origin.y - window.innerHeight / 2)}px` } as CSSProperties
    : null));
  const id = useId();
  const titleId = `${id}-titulo`;
  const descId = `${id}-descricao`;
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const requestClose = useCallback(() => {
    if (busyRef.current || leaving) return;
    if (reducedMotion()) { onClose(); return; }
    setLeaving(true);
    window.setTimeout(onClose, 150);
  }, [onClose, leaving]);

  // Pilha (Esc só no de cima), foco inicial, inércia do resto e trava de rolagem.
  useLayoutEffect(() => {
    stack.push(id);
    const previous = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    const inerted: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      // [data-no-inert]: a região de avisos (toasts) continua viva e anunciada.
      if (el !== root && !el.hasAttribute("inert") && !el.hasAttribute("data-no-inert") && el.tagName !== "SCRIPT") {
        el.setAttribute("inert", "");
        inerted.push(el);
      }
    }
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = "hidden";

    const target =
      initialFocusRef?.current ??
      panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panelRef.current?.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), textarea, select") ??
      panelRef.current;
    target?.focus({ preventScroll: true });

    return () => {
      const i = stack.lastIndexOf(id);
      if (i >= 0) stack.splice(i, 1);
      inerted.forEach((el) => el.removeAttribute("inert"));
      html.style.overflow = prevOverflow;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        requestClose();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (!items.length) { e.preventDefault(); panelRef.current.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
    // Fase de bolha: um campo dentro do diálogo pode tratar o Esc antes
    // (ex.: fechar a busca interna) e parar a propagação.
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [id, requestClose]);

  return createPortal(
    <DialogCloseContext.Provider value={requestClose}>
    <div ref={rootRef} className="fixed inset-0 z-[60]">
      <div
        aria-hidden
        onClick={requestClose}
        className={`absolute inset-0 bg-(--overlay-scrim) ${leaving ? "dialog-scrim-out" : "dialog-scrim-in"}`}
      />
      <div className="pointer-events-none absolute inset-0 flex items-end justify-center sm:items-center sm:p-4">
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          className={`pointer-events-auto relative flex w-full max-h-[92dvh] flex-col glass-dialog glass-blur-strong shadow-modal
            rounded-t-[18px] sm:rounded-(--radius-dialog) pb-[env(safe-area-inset-bottom)] sm:pb-0 focus:outline-hidden
            ${WIDTH[size]} ${qo ? (leaving ? "quicklook-out" : "quicklook-in") : leaving ? "dialog-panel-out" : "dialog-panel-in"} ${className}`}
          style={qo ?? undefined}
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-(--border-control) sm:hidden" aria-hidden />
          {header && <h2 id={titleId} className="sr-only">{title}</h2>}
          {header}
          <div className={`flex items-start gap-3 px-5 pt-4 sm:pt-5 ${hideTitle || header ? "sr-only" : ""}`}>
            <div className="min-w-0 flex-1">
              {!header && <h2 id={titleId} className="text-mac-title3 text-(--text-primary)">{title}</h2>}
              {description && (
                <div id={descId} className="mt-1.5 text-mac-body leading-[19px] text-(--text-secondary)">{description}</div>
              )}
            </div>
            {showClose && !hideTitle && (
              <button
                type="button"
                onClick={requestClose}
                disabled={busy}
                aria-label="Fechar"
                className="-mr-2 -mt-1 flex h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 shrink-0 items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) disabled:opacity-(--opacity-disabled)"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>
          {children !== undefined && (
            <div className={`min-h-0 flex-1 overflow-y-auto px-5 py-4 ${bodyClassName}`}>{children}</div>
          )}
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-(--border-default) px-5 py-3.5 sm:flex-row sm:items-center sm:justify-end">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
    </DialogCloseContext.Provider>,
    document.body,
  );
}
