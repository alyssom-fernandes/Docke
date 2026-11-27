import { useEffect, useRef, useState, type RefObject } from "react";
import { RefreshCw } from "lucide-react";

/**
 * Gestos do celular (B1.2.8, B4.5.6).
 *
 * Puxar para atualizar: com a lista no topo, arrastar para baixo mais que o
 * limite e soltar chama `onRefresh`. Só no toque; o mouse não muda nada.
 */
const LIMITE = 72;

export function usePullToRefresh(ref: RefObject<HTMLElement | null>, onRefresh: () => void | Promise<void>, ativo = true) {
  const [puxado, setPuxado] = useState(0);
  const [atualizando, setAtualizando] = useState(false);
  const fn = useRef(onRefresh);
  fn.current = onRefresh;
  useEffect(() => {
    const el = ref.current;
    if (!el || !ativo) return;
    let inicio: number | null = null;
    let dist = 0;
    const start = (e: TouchEvent) => { inicio = el.scrollTop <= 0 && e.touches.length === 1 ? e.touches[0].clientY : null; dist = 0; };
    const move = (e: TouchEvent) => {
      if (inicio === null) return;
      dist = Math.max(0, e.touches[0].clientY - inicio);
      if (dist > 0 && el.scrollTop <= 0) setPuxado(Math.min(dist * 0.5, LIMITE + 20));
    };
    const end = async () => {
      if (inicio !== null && dist * 0.5 >= LIMITE) {
        setAtualizando(true);
        try { await fn.current(); } finally { setAtualizando(false); }
      }
      inicio = null; dist = 0; setPuxado(0);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: true });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end); el.removeEventListener("touchcancel", end);
    };
  }, [ref, ativo]);
  return { puxado, atualizando };
}

/** Indicador do puxar para atualizar (seta que gira e vira "atualizando"). */
export function IndicadorPuxar({ puxado, atualizando }: { puxado: number; atualizando: boolean }) {
  if (!puxado && !atualizando) return null;
  const pronto = puxado >= LIMITE;
  return (
    <div className="flex justify-center overflow-hidden transition-[height] duration-fast" style={{ height: atualizando ? 40 : puxado * 0.6 }} role="status" aria-live="polite">
      <span className="mt-2 inline-flex items-center gap-1.5 text-mac-caption text-(--text-secondary)">
        <RefreshCw className={`w-4 h-4 ${atualizando ? "animate-spin" : ""}`} style={atualizando ? undefined : { transform: `rotate(${puxado * 3}deg)` }} aria-hidden="true" />
        {atualizando ? "Atualizando…" : pronto ? "Solte para atualizar" : ""}
      </span>
    </div>
  );
}

/**
 * Deslizar na linha (B1.2.8, B4.5.6): no toque, arrastar a linha para a
 * esquerda abre as ações dela (a folha inferior do celular). A linha
 * acompanha o dedo enquanto desliza; um toque normal continua abrindo.
 */
export function useSwipeRow(onSwipe: (el: HTMLElement) => void) {
  const estado = useRef<{ x: number; y: number; el: HTMLElement; horizontal: boolean | null } | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
      if (e.touches.length !== 1) return;
      estado.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, el: e.currentTarget, horizontal: null };
    },
    onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
      const s = estado.current;
      if (!s) return;
      const dx = e.touches[0].clientX - s.x;
      const dy = e.touches[0].clientY - s.y;
      if (s.horizontal === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) s.horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
      if (s.horizontal && dx < 0) s.el.style.transform = `translateX(${Math.max(dx, -96)}px)`;
    },
    onTouchEnd: (e: React.TouchEvent<HTMLElement>) => {
      const s = estado.current;
      estado.current = null;
      if (!s) return;
      const dx = (e.changedTouches[0]?.clientX ?? s.x) - s.x;
      s.el.style.transition = "transform 160ms ease-out";
      s.el.style.transform = "";
      window.setTimeout(() => { s.el.style.transition = ""; }, 180);
      if (s.horizontal && dx < -60) { e.preventDefault(); onSwipe(s.el); }
    },
  };
}
