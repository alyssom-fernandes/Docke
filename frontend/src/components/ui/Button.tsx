import { ButtonHTMLAttributes, ReactNode, forwardRef } from "react";
import { Loader2 } from "lucide-react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "icon";
  size?: "sm" | "md";
  loading?: boolean;
  children: ReactNode;
}

const base =
  "inline-flex items-center justify-center font-medium rounded-full transition-all duration-fast select-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-teal-400 disabled:opacity-50 disabled:pointer-events-none active:scale-[0.97]";

const variants: Record<string, string> = {
  primary: "bg-teal-600 text-white hover:bg-teal-500",
  secondary:
    "bg-transparent text-(--text-primary) border border-(--border-default) hover:bg-(--bg-hover)",
  ghost: "bg-transparent text-(--text-secondary) hover:bg-(--bg-hover)",
  danger: "bg-red-600 text-white hover:bg-red-500",
  icon: "bg-transparent text-(--text-placeholder) hover:bg-(--bg-hover) hover:text-(--text-secondary)",
};

const sizes: Record<string, string> = {
  sm: "h-7 px-3 text-mac-body gap-1.5",
  md: "h-8 px-4 text-mac-body gap-2",
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
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});

export default Button;
