import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Dica no formato do macOS para todo elemento com `title` (achado A2-35 da
 * avaliação de 25/11/2026). Montado uma vez na raiz: ao passar o mouse, o
 * `title` sai do elemento enquanto o ponteiro está sobre ele (para o balão do
 * navegador não aparecer junto) e volta ao sair; a etiqueta própria aparece
 * embaixo, como no Mac. Pelo teclado, o foco visível também mostra a dica,
 * coisa que o balão do navegador nunca fez. Esc e rolagem fecham.
 */
const FIRST_DELAY_MS = 500;
const WARM_WINDOW_MS = 600;

export default function TitleTips() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const hovered = useRef<HTMLElement | null>(null);
  const lastClosed = useRef(0);

  useEffect(() => {
    function clear() { if (timer.current) window.clearTimeout(timer.current); timer.current = undefined; }
    function restore() {
      const el = hovered.current;
      if (el && el.dataset.docketip !== undefined) {
        if (!el.hasAttribute("title")) el.setAttribute("title", el.dataset.docketip);
        delete el.dataset.docketip;
      }
      hovered.current = null;
    }
    function close() {
      clear();
      setTip((t) => { if (t) lastClosed.current = Date.now(); return null; });
      setPos(null);
    }
    function open(el: HTMLElement, text: string, delay: number) {
      clear();
      timer.current = window.setTimeout(() => {
        if (!el.isConnected) return;
        setTip({ text, rect: el.getBoundingClientRect() });
      }, delay);
    }
    function onOver(e: MouseEvent) {
      const el = (e.target as Element | null)?.closest?.("[title]") as HTMLElement | null;
      if (!el || el === hovered.current) return;
      if (el instanceof SVGElement) return;
      const text = el.getAttribute("title")?.trim();
      if (!text) return;
      restore();
      close();
      hovered.current = el;
      el.dataset.docketip = el.getAttribute("title") ?? "";
      el.removeAttribute("title");
      open(el, text, Date.now() - lastClosed.current < WARM_WINDOW_MS ? 0 : FIRST_DELAY_MS);
    }
    function onOut(e: MouseEvent) {
      const el = hovered.current;
      if (!el) return;
      const to = e.relatedTarget as Node | null;
      if (to && el.contains(to)) return;
      restore();
      close();
    }
    function onFocus(e: FocusEvent) {
      const el = e.target as HTMLElement | null;
      if (!el || !el.matches?.(":focus-visible")) return;
      const text = el.getAttribute?.("title")?.trim();
      if (text) open(el, text, 0);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") close(); }
    function onDown() { restore(); close(); }
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("focusout", close, true);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      restore();
      clear();
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("focusout", close, true);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) return;
    const a = tip.rect;
    const t = tipRef.current.getBoundingClientRect();
    const gap = 6;
    let top = a.bottom + gap;
    if (top + t.height > window.innerHeight - 4) top = a.top - t.height - gap;
    const left = Math.min(Math.max(8, a.left + a.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    setPos({ left, top });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <span ref={tipRef} role="tooltip" aria-hidden="true"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      className={`pointer-events-none fixed z-[95] max-w-[320px] ${pos ? "menu-in" : ""}`}>
      <span className="block rounded-[5px] mac-sheet px-[7px] py-[3px] text-[11px] leading-[14px] text-(--text-primary) whitespace-pre-line">
        {tip.text}
      </span>
    </span>,
    document.body,
  );
}
