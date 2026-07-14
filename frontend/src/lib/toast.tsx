import { createContext, useContext, useState, useCallback, ReactNode } from "react";
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
  toast: (opts: Omit<ToastItem, "id">) => void;
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

const iconBg: Record<ToastType, string> = {
  success: "bg-emerald-500/10",
  error: "bg-red-500/10",
  warning: "bg-amber-500/10",
  info: "bg-teal-500/10",
};

const iconColors: Record<ToastType, string> = {
  success: "text-emerald-500",
  error: "text-red-500",
  warning: "text-amber-500",
  info: "text-teal-500",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    ({ type, message, duration, action }: Omit<ToastItem, "id">) => {
      const id = Math.random().toString(36).slice(2);
      setToasts((prev) => [...prev.slice(-2), { id, type, message, duration, action }]);
      const d = duration ?? (type === "error" ? 6000 : 4000);
      setTimeout(() => remove(id), d);
    },
    [remove]
  );

  const success = (msg: string) => toast({ type: "success", message: msg });
  const error = (msg: string) => toast({ type: "error", message: msg });
  const warning = (msg: string) => toast({ type: "warning", message: msg });
  const info = (msg: string) => toast({ type: "info", message: msg });

  return (
    <Ctx.Provider value={{ toast, success, error, warning, info }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80">
        {toasts.map((t) => {
          const Icon = icons[t.type];
          return (
            <div
              key={t.id}
              className="toast-in glass-panel glass-blur-strong flex items-start gap-3 rounded-[var(--radius-dialog)] shadow-dropdown p-3"
            >
              <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${iconBg[t.type]}`}>
                <Icon className={`w-4 h-4 ${iconColors[t.type]}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-mac-body text-[var(--text-primary)]">{t.message}</p>
                {t.action && (
                  <button
                    onClick={() => { t.action!.onClick(); remove(t.id); }}
                    className="text-mac-caption text-teal-500 font-medium mt-1 hover:underline"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                onClick={() => remove(t.id)}
                className="text-[var(--text-placeholder)] hover:text-[var(--text-secondary)] shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be inside ToastProvider");
  return ctx;
}
