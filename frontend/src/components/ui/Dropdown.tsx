import { KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { ChevronsUpDown, Check } from "lucide-react";

export interface DropdownOption {
  value: string;
  label: string;
  depth?: number;
}

/**
 * Seletor no lugar do <select> nativo, no padrão "combobox só de seleção" do
 * WAI-ARIA (achado A2 primitivos): botão com aria-haspopup="listbox" e
 * aria-expanded, lista com role="listbox"/"option", setas, Home/End, letra
 * inicial, Enter/Espaço escolhem, Esc fecha e devolve o foco. 44 px no toque.
 */
export default function Dropdown({
  value, placeholder = "Selecione", options, onChange, disabled, className, ariaLabelledby, ariaLabel, id,
}: {
  value: string;
  placeholder?: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabelledby?: string;
  ariaLabel?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();
  const listId = `${uid}-lista`;
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const typeahead = useRef({ text: "", timer: 0 });

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function choose(i: number) {
    const opt = options[i];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (disabled) return;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(active); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === "Tab") setOpen(false);
    else if (e.key.length === 1) {
      window.clearTimeout(typeahead.current.timer);
      typeahead.current.text += e.key.toLowerCase();
      typeahead.current.timer = window.setTimeout(() => { typeahead.current.text = ""; }, 600);
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typeahead.current.text));
      if (hit >= 0) setActive(hit);
    }
  }

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={ariaLabelledby}
        aria-label={ariaLabelledby ? undefined : ariaLabel}
        aria-activedescendant={open ? `${uid}-op-${active}` : undefined}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        className="mac-popup w-full h-7 pointer-coarse:h-11 pl-2.5 pr-1.5 flex items-center justify-between gap-2 text-[13px] font-medium pointer-coarse:text-[16px] text-left focus:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) disabled:opacity-(--opacity-disabled) disabled:cursor-not-allowed"
      >
        <span className={`truncate ${selected ? "text-(--text-primary)" : "text-(--text-placeholder)"}`}>{selected?.label ?? placeholder}</span>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-(--radius-badge) bg-(--accent) text-white" aria-hidden>
          <ChevronsUpDown className="w-3 h-3" strokeWidth={2.5} />
        </span>
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-labelledby={ariaLabelledby}
          aria-label={ariaLabelledby ? undefined : ariaLabel ?? placeholder}
          className="menu-in absolute z-50 mt-1 w-full min-w-[160px] max-h-64 overflow-y-auto p-[5px] glass-dialog glass-blur-strong rounded-(--radius-popover) shadow-dropdown"
        >
          {options.map((opt, i) => (
            <li
              key={`${opt.value}-${i}`}
              id={`${uid}-op-${i}`}
              data-index={i}
              role="option"
              aria-selected={opt.value === value}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(i)}
              style={{ paddingLeft: 8 + (opt.depth ?? 0) * 14 }}
              className={`flex items-center justify-between gap-2 h-6 pointer-coarse:h-11 pr-2 rounded-(--radius-control) text-[13px] cursor-default select-none ${
                i === active ? "bg-(--selection-bg) text-(--selection-text)" : "text-(--text-primary)"
              }`}
            >
              <span className="truncate">{opt.label}</span>
              {opt.value === value && <Check className="w-3.5 h-3.5 shrink-0" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
