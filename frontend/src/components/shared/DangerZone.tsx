import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Fase 10.2 — container visual padronizado pra ações destrutivas em
 * Configurações (border vermelha translúcida + ícone de alerta). Antes cada
 * tela desenhava o próprio "cantinho perigoso" à mão (ex: painel de execução
 * de descarte em Retention.tsx); agora todas usam o mesmo wrapper. A
 * confirmação em si continua sendo `ConfirmModal` com
 * `requireTypedConfirmation` — este componente é só a moldura.
 */
export default function DangerZone({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) p-6 space-y-4 border border-red-500/20">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-red-500" />
        <h2 className="text-mac-body font-semibold text-(--text-primary)">{title}</h2>
      </div>
      {description && <p className="text-mac-caption text-(--text-secondary)">{description}</p>}
      {children}
    </div>
  );
}
