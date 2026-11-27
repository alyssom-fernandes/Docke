import { ReactNode, useId, useRef, useState } from "react";
import Button from "./Button";
import Dialog from "./Dialog";

interface ConfirmModalProps {
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  /** Nível "Alto" do design system: exige digitar um valor específico para habilitar o botão danger. */
  requireTypedConfirmation?: boolean;
  /** Valor exato que precisa ser digitado (default "CONFIRMAR"). Use um valor dinâmico
   * (ex: nome do documento) para ações onde digitar a palavra genérica seria fraco demais. */
  typedConfirmationValue?: string;
  /** Conteúdo extra entre a descrição e os botões (ex.: lista do que será afetado). */
  children?: ReactNode;
  onConfirm: (typedValue: string) => void;
  onClose: () => void;
}

/**
 * Confirmação sobre o Dialog acessível: foco inicial em Cancelar (nunca na ação
 * destrutiva), Esc e clique fora fecham, e nada fecha enquanto a ação roda.
 */
export default function ConfirmModal({
  title,
  description,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
  loading = false,
  requireTypedConfirmation = false,
  typedConfirmationValue = "CONFIRMAR",
  children,
  onConfirm,
  onClose,
}: ConfirmModalProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typedValue, setTypedValue] = useState("");
  const inputId = useId();
  const blocked = requireTypedConfirmation && typedValue.trim() !== typedConfirmationValue;

  return (
    <Dialog
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      variant="alert"
      busy={loading}
      showClose={false}
      initialFocusRef={requireTypedConfirmation ? undefined : cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            loading={loading}
            disabled={blocked}
            onClick={() => onConfirm(typedValue)}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {(children || requireTypedConfirmation) && (
        <div className="space-y-3">
          {children}
          {requireTypedConfirmation && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={inputId} className="text-mac-body text-(--text-secondary)">
                Para confirmar, digite <strong className="font-semibold text-(--text-primary) select-all">{typedConfirmationValue}</strong>
              </label>
              <input
                id={inputId}
                type="text"
                autoComplete="off"
                value={typedValue}
                onChange={(e) => setTypedValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !blocked && !loading) onConfirm(typedValue); }}
                className="mac-field w-full h-7 pointer-coarse:h-11 px-2 text-[13px] pointer-coarse:text-[16px] text-(--text-primary) placeholder:text-(--text-placeholder)"
              />
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
