import { ReactNode, cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: "top" | "bottom";
}

/**
 * Bolha com "cauda" apontando para o elemento (padrão macOS/iOS).
 *
 * A2-36: a posição é calculada na tela — vira para o outro lado quando falta
 * espaço e desliza para não passar das bordas — e a bolha sai num portal, sem
 * ser cortada por áreas com rolagem. No toque, segurar o dedo mostra o rótulo
 * por 1,5 s. Esc fecha (WCAG 1.4.13).
 */
export default function Tooltip({ label, children, side = "top" }: TooltipProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: "top" | "bottom"; tail: number } | null>(null);

  function clear() { if (timer.current) window.clearTimeout(timer.current); timer.current = undefined; }
  function show(delay: number) { clear(); timer.current = window.setTimeout(() => setOpen(true), delay); }
  function hide() { clear(); setOpen(false); setPos(null); }

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !tipRef.current) return;
    const a = anchorRef.current.getBoundingClientRect();
    const t = tipRef.current.getBoundingClientRect();
    const gap = 8;
    let lado = side;
    if (lado === "top" && a.top - t.height - gap < 4) lado = "bottom";
    else if (lado === "bottom" && a.bottom + t.height + gap > window.innerHeight - 4) lado = "top";
    const centro = a.left + a.width / 2;
    const left = Math.min(Math.max(8, centro - t.width / 2), window.innerWidth - t.width - 8);
    const top = lado === "top" ? a.top - t.height - gap : a.bottom + gap;
    setPos({ left, top, side: lado, tail: Math.min(Math.max(8, centro - left), t.width - 8) });
  }, [open, side, label]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    const onScroll = () => hide();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("scroll", onScroll, true); };
  }, [open]);

  useEffect(() => clear, []);

  if (!isValidElement(children)) return <>{children}</>;

  return (
    <span
      ref={anchorRef}
      className="relative inline-flex"
      onMouseEnter={() => show(300)}
      onMouseLeave={hide}
      onFocus={(e) => { if ((e.target as HTMLElement).matches?.(":focus-visible")) show(0); }}
      onBlur={hide}
      onTouchStart={() => { clear(); timer.current = window.setTimeout(() => { setOpen(true); timer.current = window.setTimeout(hide, 1500); }, 500); }}
      onTouchMove={() => { if (!open) clear(); }}
      onTouchEnd={() => { if (!open) clear(); }}
    >
      {cloneElement(children as any, { "aria-label": label })}
      {open && createPortal(
        <span
          ref={tipRef}
          role="tooltip"
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          className={`pointer-events-none fixed z-[90] whitespace-nowrap ${pos ? "menu-in" : ""}`}
        >
          <span className="block rounded-[6px] bg-(--bg-elevated) border border-(--border-default) shadow-dropdown px-2 py-1 text-mac-caption text-(--text-primary)">
            {label}
          </span>
          {pos && (
            <span
              className={`absolute w-0 h-0 border-4 -translate-x-1/2 ${
                pos.side === "top"
                  ? "top-full mt-[-3px] border-t-(--bg-elevated) border-x-transparent border-b-transparent"
                  : "bottom-full mb-[-3px] border-b-(--bg-elevated) border-x-transparent border-t-transparent"
              }`}
              style={{ left: pos.tail }}
            />
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}
