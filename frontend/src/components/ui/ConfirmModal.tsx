import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import Button from "./Button";

interface ConfirmModalProps {
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** Nível "Alto" do design system: exige digitar CONFIRMAR para habilitar o botão danger. */
  requireTypedConfirmation?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Confirmation modal per design system:
 * - Overlay rgba(0,0,0,0.5), card with modal-card animation
 * - Initial focus on Cancelar button (not on the destructive action)
 * - ESC closes
 */
export default function ConfirmModal({
  title,
  description,
  confirmLabel = "Confirmar",
  danger = false,
  loading = false,
  requireTypedConfirmation = false,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typedValue, setTypedValue] = useState("");

  useFocusTrap(containerRef);

  // Focus Cancelar on mount (design system: foco inicial em Cancelar)
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // ESC closes
  useEffect(() => {
    function handle(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={containerRef} className="modal-card bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] shadow-modal w-full max-w-[400px]">
        <div className="flex items-start gap-3 p-6">
          <div className={`w-9 h-9 rounded-[8px] flex items-center justify-center flex-shrink-0 ${
            danger ? "bg-red-50 dark:bg-red-900/20" : "bg-amber-50 dark:bg-amber-900/20"
          }`}>
            <AlertTriangle className={`w-5 h-5 ${danger ? "text-red-600 dark:text-red-400" : "text-amber-600 dark:text-amber-400"}`} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
            <p className="text-sm text-[var(--text-secondary)] mt-1">{description}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {requireTypedConfirmation && (
          <div className="px-6 pb-4">
            <input
              type="text"
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder="Digite CONFIRMAR"
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-6 pb-6">
          <Button ref={cancelRef} variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            size="sm"
            loading={loading}
            disabled={requireTypedConfirmation && typedValue !== "CONFIRMAR"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
