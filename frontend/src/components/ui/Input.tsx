import { InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = "", ...props }, ref) => (
    <div className="flex flex-col gap-1">
      {label && (
        <label className="text-sm font-medium text-[var(--text-secondary)]">
          {label}
        </label>
      )}
      <input
        ref={ref}
        className={`h-9 w-full rounded-[8px] border px-3 text-sm
          bg-[var(--bg-card)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)]
          border-[var(--border-default)] focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent
          disabled:bg-[var(--bg-hover)] disabled:text-[var(--text-tertiary)] disabled:cursor-not-allowed disabled:select-none
          transition-all duration-fast
          ${error ? "border-red-500 focus:ring-red-400" : ""}
          ${className}`}
        {...props}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
);

Input.displayName = "Input";
export default Input;
