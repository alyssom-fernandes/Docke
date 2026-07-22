import { useEffect, useRef, useState } from "react";

const SHOW_DELAY_MS = 200; // abaixo disso, nada aparece — evita flicker (regra dos 200ms)
const MIN_VISIBLE_MS = 500; // uma vez visível, fica pelo menos esse tempo — evita "skeleton flashing"

/**
 * Decide quando mostrar um skeleton a partir de um booleano de loading cru.
 * Sem isso, toda troca de pasta pisca um skeleton mesmo quando a resposta
 * vem em 40ms (cache quente) — o oposto do que o skeleton deveria resolver.
 */
export function useDelayedLoading(isLoading: boolean): boolean {
  const [show, setShow] = useState(false);
  const shownAtRef = useRef<number | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isLoading) {
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
      showTimerRef.current = setTimeout(() => {
        shownAtRef.current = Date.now();
        setShow(true);
      }, SHOW_DELAY_MS);
    } else {
      if (showTimerRef.current) { clearTimeout(showTimerRef.current); showTimerRef.current = null; }
      const elapsed = shownAtRef.current ? Date.now() - shownAtRef.current : Infinity;
      if (elapsed >= MIN_VISIBLE_MS) {
        setShow(false);
        shownAtRef.current = null;
      } else {
        hideTimerRef.current = setTimeout(() => {
          setShow(false);
          shownAtRef.current = null;
        }, MIN_VISIBLE_MS - elapsed);
      }
    }
    return () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [isLoading]);

  return show;
}
