import { InputHTMLAttributes, forwardRef, useId } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

// O <label> precisa estar ligado ao campo (htmlFor/id): sem isso, o leitor de
// tela anuncia o placeholder no lugar do rótulo (no campo de senha, "••••••••").
const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = "", id, ...props }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    const errorId = `${inputId}-erro`;
    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-mac-body font-medium text-(--text-secondary)">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`h-9 w-full rounded-(--radius-control) border px-3 text-mac-body
            bg-(--bg-card) text-(--text-primary) placeholder:text-(--text-placeholder)
            border-(--border-default) focus:outline-hidden focus:ring-[3px] focus:ring-teal-500/70 focus:border-transparent
            disabled:bg-(--bg-hover) disabled:text-(--text-tertiary) disabled:cursor-not-allowed disabled:select-none
            transition-all duration-fast
            ${error ? "border-red-500 focus:ring-red-400" : ""}
            ${className}`}
          {...props}
        />
        {error && <p id={errorId} className="text-mac-caption text-red-500">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";
export default Input;
