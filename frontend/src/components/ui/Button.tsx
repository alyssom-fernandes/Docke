import { ButtonHTMLAttributes, ReactNode, forwardRef } from "react";
import { Loader2 } from "lucide-react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "icon";
  size?: "sm" | "md";
  loading?: boolean;
  children: ReactNode;
}

// Botões do kit do macOS 27: cápsula, texto 13 em peso médio; o secundário é
// o preenchimento de controle (8%) sem borda, o principal leva o acento.
const base =
  "inline-flex items-center justify-center font-medium rounded-full transition-[background-color,color,transform,filter] duration-fast select-none focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) disabled:opacity-(--opacity-disabled) disabled:pointer-events-none active:scale-[0.97] motion-reduce:active:scale-100 [&_svg]:shrink-0";

const variants: Record<string, string> = {
  primary: "bg-(--accent) text-white hover:bg-(--accent-hover) shadow-(--shadow-hairline)",
  secondary: "bg-(--control-fill) text-(--text-primary) hover:bg-(--control-fill-hover)",
  ghost: "bg-transparent text-(--text-primary) hover:bg-(--control-fill)",
  danger: "bg-(--text-danger) text-white hover:brightness-95 shadow-(--shadow-hairline)",
  icon: "bg-transparent text-(--text-secondary) hover:bg-(--control-fill) hover:text-(--text-primary)",
};

// Em tela de toque (pointer: coarse) todo botão chega a 44 px de altura.
const sizes: Record<string, string> = {
  sm: "h-7 px-3 text-[13px] gap-1.5 pointer-coarse:h-11 pointer-coarse:px-4 [&_svg]:size-3.5",
  md: "h-8 px-4 text-[13px] gap-1.5 pointer-coarse:h-11 [&_svg]:size-4",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, children, className = "", disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          <span>{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});

export default Button;
