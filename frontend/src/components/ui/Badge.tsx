import { ReactNode } from "react";

type Variant = "default" | "success" | "error" | "warning" | "info" | "teal";

// ADR-018: badges "success"/"teal" usam o token de contraste corrigido
// (status-badge, definido em tokens.css) — reprovado em WCAG AA (~3.2:1) no
// valor original. Demais variantes seguem a paleta semântica padrão.
const variants: Record<Variant, string> = {
  default: "bg-[var(--bg-hover)] text-[var(--text-secondary)]",
  teal: "status-badge",
  success: "status-badge",
  error: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  info: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
};

export default function Badge({
  children,
  variant = "default",
  className = "",
}: {
  children: ReactNode;
  variant?: Variant;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
