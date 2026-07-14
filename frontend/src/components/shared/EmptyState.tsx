import { Anchor } from "lucide-react";
import { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export default function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      {/* Illustrated icon: main icon + decorative anchor */}
      <div className="relative w-16 h-16 mb-5">
        <div className="w-16 h-16 rounded-[16px] bg-teal-50 dark:bg-teal-900/20 flex items-center justify-center text-teal-500 dark:text-teal-400">
          <span className="[&>svg]:w-8 [&>svg]:h-8">
            {icon ?? <Anchor className="w-8 h-8" />}
          </span>
        </div>
        {/* Decorative anchor badge */}
        <div className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-full bg-[var(--bg-card)] border border-[var(--border-default)] flex items-center justify-center">
          <Anchor className="w-3 h-3 text-teal-400 opacity-70" />
        </div>
      </div>
      <p className="text-mac-callout font-medium text-[var(--text-primary)] mb-1">{title}</p>
      {description && (
        <p className="text-mac-body text-[var(--text-secondary)] max-w-xs">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
