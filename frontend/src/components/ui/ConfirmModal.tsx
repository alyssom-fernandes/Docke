import { useEffect, useRef, useState } from "react";
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
      className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={containerRef} className="modal-card glass-panel glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal w-full max-w-[360px]">
        <div className="p-5 pb-3">
          <h2 className="text-mac-title3 text-[var(--text-primary)]">{title}</h2>
          <p className="text-mac-body text-[var(--text-secondary)] mt-1.5">{description}</p>
        </div>
        {requireTypedConfirmation && (
          <div className="px-5 pb-3">
            <input
              type="text"
              value={typedValue}
              onChange={(e) => setTypedValue(e.target.value)}
              placeholder="Digite CONFIRMAR"
              className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-5 pb-5">
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
