import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X, CheckCircle2, AlertCircle, AlertTriangle, Info } from "lucide-react";

export type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastCtx {
  toast: (opts: Omit<ToastItem, "id">) => string;
  dismiss: (id: string) => void;
  success: (msg: string) => void;
  error: (msg: string) => void;
  warning: (msg: string) => void;
  info: (msg: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

const icons: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

// Ícone em bloco colorido, como o ícone de app numa notificação do macOS.
const iconBg: Record<ToastType, string> = {
  success: "bg-[#30B158]",
  error: "bg-[#E5352B]",
  warning: "bg-[#F08A00]",
  info: "bg-(--accent)",
};

const iconColors: Record<ToastType, string> = {
  success: "text-white",
  error: "text-white",
  warning: "text-white",
  info: "text-white",
};

/**
 * Um aviso: some sozinho, mas pausa enquanto o ponteiro ou o foco estão nele
 * (achados X1-03, A2-30) — dá tempo de ler e de clicar em "Desfazer".
 */
function Toast({ t, onDone }: { t: ToastItem; onDone: () => void }) {
  const Icon = icons[t.type];
  const remaining = useRef(t.duration ?? (t.action ? 8000 : t.type === "error" ? 7000 : 4500));
  const started = useRef(Date.now());
  const timer = useRef<number | undefined>(undefined);
  const [leaving, setLeaving] = useState(false);

  const close = useCallback(() => {
    setLeaving(true);
    window.setTimeout(onDone, 160);
  }, [onDone]);

  const resume = useCallback(() => {
    started.current = Date.now();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(close, remaining.current);
  }, [close]);

  const pause = useCallback(() => {
    window.clearTimeout(timer.current);
    remaining.current = Math.max(1500, remaining.current - (Date.now() - started.current));
  }, []);

  useEffect(() => {
    resume();
    return () => window.clearTimeout(timer.current);
  }, [resume]);

  return (
    <div
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocus={pause}
      onBlur={resume}
      className={`${leaving ? "toast-out" : "toast-in"} pointer-events-auto mac-sheet flex items-start gap-3 rounded-[18px] p-3`}
    >
      <div className={`w-8 h-8 rounded-(--radius-sm) flex items-center justify-center shrink-0 ${iconBg[t.type]}`}>
        <Icon className={`w-4 h-4 ${iconColors[t.type]}`} aria-hidden />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] leading-4 font-bold text-(--text-primary)">Docke</p>
        <p className="mt-0.5 text-[13px] leading-[17px] text-(--text-primary)">{t.message}</p>
        {t.action && (
          <button
            onClick={() => { t.action!.onClick(); close(); }}
            className="mt-1.5 -ml-1 px-1 h-7 pointer-coarse:h-10 rounded-(--radius-control) text-mac-body font-semibold text-(--text-accent) hover:bg-(--bg-hover)"
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        onClick={close}
        aria-label="Fechar aviso"
        className="w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 -mr-1 -mt-0.5 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover) shrink-0"
      >
        <X className="w-3.5 h-3.5" aria-hidden />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(({ type, message, duration, action }: Omit<ToastItem, "id">) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-2), { id, type, message, duration, action }]);
    return id;
  }, []);

  const success = useCallback((msg: string) => { toast({ type: "success", message: msg }); }, [toast]);
  const error = useCallback((msg: string) => { toast({ type: "error", message: msg }); }, [toast]);
  const warning = useCallback((msg: string) => { toast({ type: "warning", message: msg }); }, [toast]);
  const info = useCallback((msg: string) => { toast({ type: "info", message: msg }); }, [toast]);

  const urgent = toasts.filter((t) => t.type === "error");
  const polite = toasts.filter((t) => t.type !== "error");

  return (
    <Ctx.Provider value={{ toast, dismiss: remove, success, error, warning, info }}>
      {children}
      {createPortal(
        // Fora da árvore do app (data-no-inert): continua anunciado e clicável
        // mesmo com um diálogo aberto. Celular: centralizado acima da barra inferior.
        <div
          data-no-inert
          className="pointer-events-none fixed z-[70] flex flex-col gap-2 left-3 right-3 top-[calc(10px+env(safe-area-inset-top))] sm:left-auto sm:right-4 sm:top-4 sm:w-[356px]"
        >
          <div role="status" aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
            {polite.map((t) => <Toast key={t.id} t={t} onDone={() => remove(t.id)} />)}
          </div>
          <div role="alert" aria-live="assertive" className="flex flex-col gap-2">
            {urgent.map((t) => <Toast key={t.id} t={t} onDone={() => remove(t.id)} />)}
          </div>
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be inside ToastProvider");
  return ctx;
}
