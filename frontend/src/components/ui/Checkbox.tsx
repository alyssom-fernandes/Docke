import { InputHTMLAttributes, forwardRef } from "react";
import { Check } from "lucide-react";

type CheckboxProps = InputHTMLAttributes<HTMLInputElement>;

// Checkbox custom (quadrado arredondado + fill de acento + check) — o checkbox
// nativo do navegador é a maior quebra visual de "isso não parece macOS" num
// formulário (mesmo raciocínio que levou ao Switch custom em Switch.tsx).
// O <input> real fica sobreposto e invisível (opacity-0, não sr-only) pra
// continuar capturando clique/teclado/onChange exatamente como um checkbox
// normal — só o visual por baixo é substituído.
const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className = "", checked, ...props }, ref) => (
    <span className={`relative inline-flex w-4 h-4 flex-shrink-0 ${className}`}>
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        className="peer absolute inset-0 w-4 h-4 opacity-0 cursor-pointer"
        {...props}
      />
      <span
        aria-hidden="true"
        className={`w-4 h-4 rounded-[5px] border flex items-center justify-center transition-colors duration-fast pointer-events-none
          peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-teal-400 peer-focus-visible:outline-offset-1
          ${checked
            ? "bg-teal-500 border-teal-500"
            : "bg-[var(--bg-card)] border-[var(--border-default)]"
          }`}
      >
        {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
      </span>
    </span>
  )
);

Checkbox.displayName = "Checkbox";
export default Checkbox;
