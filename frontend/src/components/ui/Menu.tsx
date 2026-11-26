import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Menu acessível (achados A4-22, X1-07): role="menu" com itens role="menuitem",
 * setas para cima/baixo, Home/End, primeira letra pula para o item, Enter ou
 * Espaço executam, Esc e Tab fecham e devolvem o foco a quem abriu. Abre num
 * ponto (clique direito, toque longo) ou ancorado num botão, sempre dentro da
 * tela. No toque, itens com 44 px.
 */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Linha divisória antes deste item. */
  separatorBefore?: boolean;
  hint?: string;
}

interface MenuProps {
  items: MenuItem[];
  onClose: () => void;
  /** Ponto (clique direito) ou elemento âncora (botão "Mais ações"). */
  anchor: { x: number; y: number } | HTMLElement;
  label: string;
  /** Alinhamento ao âncora (só para elemento). */
  align?: "start" | "end";
}

export default function Menu({ items, onClose, anchor, label, align = "start" }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const previous = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
  const [active, setActive] = useState(enabled[0] ?? -1);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // No celular o menu vira folha inferior (J1-03, B1.2.8): largura toda,
  // itens de 48 px, nome do item no topo; o resto do comportamento é o mesmo.
  const [sheet] = useState(() => window.matchMedia("(max-width: 639px)").matches);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (sheet) { setPos({ top: 0, left: 0 }); return; }
    const { width, height } = el.getBoundingClientRect();
    let x: number, y: number;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      x = align === "end" ? r.right - width : r.left;
      y = r.bottom + 6;
      if (y + height > window.innerHeight - 8) y = r.top - height - 6;
    } else {
      x = anchor.x;
      y = anchor.y;
      if (y + height > window.innerHeight - 8) y = Math.max(8, anchor.y - height);
    }
    x = Math.min(Math.max(8, x), window.innerWidth - width - 8);
    y = Math.min(Math.max(8, y), window.innerHeight - height - 8);
    setPos({ top: y, left: x });
  }, [anchor, align]);

  useEffect(() => {
    if (active >= 0) itemRefs.current[active]?.focus({ preventScroll: true });
  }, [active, pos]);

  function close(restore = true) {
    onClose();
    if (restore && previous.current && document.contains(previous.current)) previous.current.focus({ preventScroll: true });
  }

  useEffect(() => {
    function onDown(e: MouseEvent | TouchEvent) {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      close(false);
    }
    function onScroll() { close(false); }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function move(delta: number) {
    if (!enabled.length) return;
    const pos = enabled.indexOf(active);
    const next = enabled[(pos + delta + enabled.length) % enabled.length];
    setActive(next);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); setActive(enabled[0]); }
    else if (e.key === "End") { e.preventDefault(); setActive(enabled[enabled.length - 1]); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); close(); }
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      const letter = e.key.toLowerCase();
      const start = enabled.indexOf(active);
      for (let k = 1; k <= enabled.length; k++) {
        const idx = enabled[(start + k) % enabled.length];
        if (items[idx].label.toLowerCase().startsWith(letter)) { setActive(idx); break; }
      }
    }
  }

  const menu = (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={sheet ? undefined : pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
      className={sheet
        ? "sheet-in fixed z-[80] inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto pt-2 pb-[calc(8px+env(safe-area-inset-bottom))] glass-dialog glass-blur-strong rounded-t-(--radius-dialog) shadow-modal"
        : `fixed z-[80] min-w-[220px] max-w-[300px] py-1.5 glass-dialog glass-blur-strong rounded-(--radius-popover) shadow-dropdown ${pos ? "menu-in" : ""}`}
    >
      {sheet && (
        <div className="px-5 pt-1 pb-2" aria-hidden="true">
          <div className="mx-auto mb-2 h-1 w-9 rounded-full bg-(--border-control)" />
          <p className="truncate text-mac-caption font-semibold text-(--text-secondary)">{label}</p>
        </div>
      )}
      {items.map((it, i) => (
        <div key={`${it.label}-${i}`}>
          {it.separatorBefore && <div role="separator" className="my-1 mx-2.5 h-px bg-(--border-default)" />}
          <button
            ref={(el) => { itemRefs.current[i] = el; }}
            type="button"
            role="menuitem"
            tabIndex={i === active ? 0 : -1}
            disabled={it.disabled}
            aria-disabled={it.disabled || undefined}
            onMouseEnter={() => !it.disabled && setActive(i)}
            onClick={() => { if (it.disabled) return; close(false); it.onSelect(); }}
            className={`mx-1.5 flex w-[calc(100%-12px)] items-center gap-2.5 rounded-[6px] px-2.5 text-left text-mac-body outline-hidden
              ${sheet ? "h-12 px-3.5 active:bg-(--bg-hover) focus-visible:bg-(--bg-hover)" : "h-7 pointer-coarse:h-11"}
              ${it.danger ? "text-(--text-danger)" : "text-(--text-primary)"}
              ${!sheet && i === active ? (it.danger ? "bg-red-600 text-white" : "bg-teal-600 text-white") : ""}
              disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {it.icon && <span className={`flex w-4 shrink-0 items-center justify-center ${sheet ? "[&_svg]:h-4 [&_svg]:w-4" : "[&_svg]:h-3.5 [&_svg]:w-3.5"}`} aria-hidden>{it.icon}</span>}
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className={`shrink-0 text-mac-caption ${!sheet && i === active ? "text-white/80" : "text-(--text-secondary)"}`}>{it.hint}</span>}
            {it.shortcut && !sheet && (
              <kbd className={`shrink-0 font-sans text-mac-caption ${i === active ? "text-white/80" : "text-(--text-secondary)"}`}>{it.shortcut}</kbd>
            )}
          </button>
        </div>
      ))}
      {sheet && (
        <div className="mx-1.5 mt-1 border-t border-(--border-default) pt-1">
          <button type="button" onClick={() => close()} className="flex w-[calc(100%-12px)] mx-1.5 h-12 items-center justify-center rounded-[6px] text-mac-body font-medium text-(--text-accent) active:bg-(--bg-hover)">
            Cancelar
          </button>
        </div>
      )}
    </div>
  );

  return createPortal(
    sheet ? (
      <>
        <div aria-hidden="true" className="dialog-scrim-in fixed inset-0 z-[79] bg-(--overlay-scrim)" />
        {menu}
      </>
    ) : menu,
    document.body,
  );
}
