import { ReactNode } from "react";

type Variant = "default" | "success" | "error" | "warning" | "info" | "teal";

const variants: Record<Variant, string> = {
  default: "bg-[var(--bg-hover)] text-[var(--text-secondary)]",
  teal: "bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
  success: "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
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
      className={`inline-flex items-center rounded-[4px] px-1.5 py-0.5 text-xs font-medium ${variants[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
