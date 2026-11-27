import { Anchor } from "lucide-react";
import { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

/*
 * Estado vazio no padrão da Apple (ContentUnavailableView): símbolo grande em
 * cinza, título e uma frase; a ação, quando houver, logo abaixo.
 */
export default function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <span className="mb-3 text-(--text-tertiary) [&>svg]:w-12 [&>svg]:h-12 [&>svg]:stroke-[1.25]" aria-hidden="true">
        {icon ?? <Anchor className="w-12 h-12" />}
      </span>
      <p className="text-[17px] leading-[22px] font-semibold text-(--text-primary) mb-1">{title}</p>
      {description && (
        <p className="text-[13px] leading-[18px] text-(--text-secondary) max-w-sm" style={{ textWrap: "balance" } as React.CSSProperties}>{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
