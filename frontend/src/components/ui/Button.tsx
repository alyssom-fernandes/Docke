import { ButtonHTMLAttributes, ReactNode, forwardRef } from "react";
import { Loader2 } from "lucide-react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "icon";
  size?: "sm" | "md";
  loading?: boolean;
  children: ReactNode;
}

const base =
  "inline-flex items-center justify-center font-medium rounded-full transition-all duration-fast select-none focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) focus-visible:ring-offset-1 focus-visible:ring-offset-(--bg-card) disabled:opacity-(--opacity-disabled) disabled:pointer-events-none active:scale-[0.97] motion-reduce:active:scale-100";

const variants: Record<string, string> = {
  // Texto branco sobre teal-600 dá 4,5:1; o hover escurece (teal-700) em vez
  // de clarear — o teal-500 derrubava o contraste para 3,2:1.
  primary: "bg-teal-600 text-white hover:bg-teal-700",
  secondary:
    "bg-transparent text-(--text-primary) border border-(--border-control) hover:bg-(--bg-hover)",
  ghost: "bg-transparent text-(--text-secondary) hover:bg-(--bg-hover)",
  danger: "bg-red-600 text-white hover:bg-red-700",
  icon: "bg-transparent text-(--text-placeholder) hover:bg-(--bg-hover) hover:text-(--text-secondary)",
};

// Em tela de toque (pointer: coarse) todo botão chega a 44 px de altura.
const sizes: Record<string, string> = {
  sm: "h-7 px-3 text-mac-body gap-1.5 pointer-coarse:h-11 pointer-coarse:px-4",
  md: "h-8 px-4 text-mac-body gap-2 pointer-coarse:h-11",
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
