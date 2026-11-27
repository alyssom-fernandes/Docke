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
          <label htmlFor={inputId} className="text-[13px] font-medium text-(--text-primary)">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`mac-field h-7 pointer-coarse:h-11 w-full px-2 text-[13px] pointer-coarse:text-[16px]
            text-(--text-primary) placeholder:text-(--text-placeholder)
            disabled:opacity-60 disabled:cursor-not-allowed disabled:select-none
            ${error ? "mac-field-error" : ""}
            ${className}`}
          {...props}
        />
        {error && <p id={errorId} className="text-mac-caption text-(--text-danger)">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";
export default Input;
