import { InputHTMLAttributes, forwardRef, useEffect, useRef } from "react";
import { Check, Minus } from "lucide-react";

type CheckboxProps = InputHTMLAttributes<HTMLInputElement> & {
  /** Parte marcada (ex.: "Todos" com só alguns selecionados) — A2-41. */
  indeterminate?: boolean;
};

// Checkbox custom (quadrado arredondado + fill de acento + check) — o checkbox
// nativo do navegador é a maior quebra visual de "isso não parece macOS" num
// formulário (mesmo raciocínio que levou ao Switch custom em Switch.tsx).
// O <input> real fica sobreposto e invisível (opacity-0, não sr-only) pra
// continuar capturando clique/teclado/onChange exatamente como um checkbox
// normal — só o visual por baixo é substituído.
const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className = "", checked, indeterminate = false, ...props }, ref) => {
    const inner = useRef<HTMLInputElement | null>(null);
    useEffect(() => { if (inner.current) inner.current.indeterminate = indeterminate && !checked; }, [indeterminate, checked]);
    const on = checked || indeterminate;
    return (
    <span className={`relative inline-flex w-4 h-4 pointer-coarse:w-5 pointer-coarse:h-5 shrink-0 ${className}`}>
      {/* Alvo de toque maior que o glifo visível (16px) — mesmo padrão do
          iOS/macOS: controle pequeno, área de clique maior por baixo. -inset-2
          estende a área clicável ~8px em cada lado sem alterar o layout, já
          que o <input> é absolute e não ocupa espaço no fluxo. */}
      <input
        ref={(el) => { inner.current = el; if (typeof ref === "function") ref(el); else if (ref) ref.current = el; }}
        type="checkbox"
        aria-checked={indeterminate && !checked ? "mixed" : undefined}
        checked={checked}
        className="peer absolute -inset-2 pointer-coarse:-inset-3.5 opacity-0 cursor-pointer"
        {...props}
      />
      <span
        aria-hidden="true"
        className={`w-4 h-4 pointer-coarse:w-5 pointer-coarse:h-5 rounded-[5px] flex items-center justify-center transition-colors duration-fast pointer-events-none
          peer-focus-visible:outline-solid peer-focus-visible:outline-[3px] peer-focus-visible:outline-(--focus-ring) peer-focus-visible:outline-offset-1
          ${on ? "bg-(--accent) shadow-(--shadow-hairline-inset)" : "mac-check-off"}`}
      >
        {checked ? <Check className="w-3 h-3 text-white" strokeWidth={3} /> : indeterminate ? <Minus className="w-3 h-3 text-white" strokeWidth={3} /> : null}
      </span>
    </span>
    );
  }
);

Checkbox.displayName = "Checkbox";
export default Checkbox;
