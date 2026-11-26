import { Anchor } from "lucide-react";
import { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

/*
 * Estado vazio (estética P3): o ícone da tela no centro de ondas concêntricas,
 * como a água em volta de uma âncora (o tema do Docke), flutuando de leve.
 * As ondas são traço fino no estilo dos SF Symbols; sem "reduzir movimento"
 * nada se mexe.
 */
export default function EmptyState({ title, description, icon, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="relative w-32 h-32 mb-4 flex items-center justify-center" aria-hidden="true">
        <svg viewBox="0 0 128 128" className="absolute inset-0 w-full h-full text-(--text-accent)">
          <circle cx="64" cy="64" r="62" fill="none" stroke="currentColor" strokeOpacity="0.08" strokeWidth="1" />
          <circle cx="64" cy="64" r="48" fill="none" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1" strokeDasharray="2 5" className="empty-orbit" />
          <circle cx="64" cy="64" r="34" fill="currentColor" fillOpacity="0.06" />
        </svg>
        <div className="empty-float relative w-14 h-14 rounded-[16px] bg-linear-to-br from-teal-500 to-teal-700 shadow-[0_8px_24px_-8px_rgba(13,148,136,0.55)] flex items-center justify-center text-white">
          <span className="[&>svg]:w-7 [&>svg]:h-7 [&>svg]:stroke-[1.75]">
            {icon ?? <Anchor className="w-7 h-7" />}
          </span>
        </div>
        <div className="absolute bottom-3 right-4 w-6 h-6 rounded-full bg-(--bg-card) border border-(--border-default) shadow-sm flex items-center justify-center">
          <Anchor className="w-3 h-3 text-(--text-accent)" />
        </div>
      </div>
      <p className="text-mac-title3 display-type text-(--text-primary) mb-1">{title}</p>
      {description && (
        <p className="text-mac-body leading-[19px] text-(--text-secondary) max-w-sm" style={{ textWrap: "balance" } as React.CSSProperties}>{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
