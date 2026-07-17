import { ReactNode, cloneElement, isValidElement } from "react";

interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
}

// Bolha cinza sólida com "cauda" apontando pro elemento de origem — padrão
// macOS/iOS real (visto na referência da pasta docs/pdf), diferente do balão
// nativo do navegador que title="" produzia até agora em toda a base de
// código. group/tooltip escopa o hover ao wrapper local, não ao ancestral
// mais próximo com a classe "group" (ex: linhas de tabela que já usam group
// pra revelar botões de ação).
export default function Tooltip({ label, children, side = "top" }: TooltipProps) {
  if (!isValidElement(children)) return <>{children}</>;

  const positionClass =
    side === "top" ? "bottom-full left-1/2 -translate-x-1/2 mb-2" : "top-full left-1/2 -translate-x-1/2 mt-2";
  const tailClass =
    side === "top"
      ? "top-full left-1/2 -translate-x-1/2 -mt-[3px] border-t-[var(--bg-elevated)] border-x-transparent border-b-transparent"
      : "bottom-full left-1/2 -translate-x-1/2 -mb-[3px] border-b-[var(--bg-elevated)] border-x-transparent border-t-transparent";

  return (
    <span className="relative inline-flex group/tooltip">
      {cloneElement(children as any, { "aria-label": label })}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 whitespace-nowrap opacity-0 scale-95 group-hover/tooltip:opacity-100 group-hover/tooltip:scale-100 group-focus-within/tooltip:opacity-100 group-focus-within/tooltip:scale-100 transition-[opacity,transform] duration-fast delay-300 ${positionClass}`}
      >
        <span className="block rounded-[6px] bg-[var(--bg-elevated)] border border-[var(--border-default)] shadow-dropdown px-2 py-1 text-mac-caption text-[var(--text-primary)]">
          {label}
        </span>
        <span className={`absolute w-0 h-0 border-[4px] ${tailClass}`} />
      </span>
    </span>
  );
}
