import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";

// Dropdown genérico (substitui <select> nativo por popover de vidro) — extraído
// de Settings/Metadata.tsx pra ser reusado em qualquer seletor do app (Users.tsx,
// etc.) em vez de cada tela reimplementar o próprio <select> cru.

export interface DropdownOption {
  value: string;
  label: string;
  depth?: number;
}

export default function Dropdown({
  value, placeholder, options, onChange, disabled, className,
}: {
  value: string;
  placeholder: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="w-full h-9 px-3 flex items-center justify-between gap-2 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] disabled:opacity-50 focus:outline-none focus:ring-[3px] focus:ring-teal-500/70 hover:bg-[var(--bg-hover)] transition-colors duration-fast"
      >
        <span className={`truncate ${selected ? "" : "text-[var(--text-placeholder)]"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown className={`w-4 h-4 flex-shrink-0 text-[var(--text-tertiary)] transition-transform duration-fast ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute top-full left-0 mt-1 w-full min-w-[220px] max-h-[280px] overflow-y-auto glass-panel glass-blur-strong rounded-[var(--radius-popover)] shadow-dropdown py-1 z-50"
        >
          {options.length === 0 ? (
            <p className="px-3 py-2 text-mac-caption text-[var(--text-tertiary)]">Nenhuma opção disponível.</p>
          ) : (
            options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{ paddingLeft: `${12 + (o.depth ?? 0) * 16}px` }}
                className={`w-full flex items-center justify-between gap-2 pr-3 py-1.5 text-mac-body text-left transition-colors duration-fast ${
                  o.value === value ? "text-teal-500 font-medium" : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                }`}
              >
                <span className="truncate">{o.label}</span>
                {o.value === value && <Check className="w-4 h-4 flex-shrink-0" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
