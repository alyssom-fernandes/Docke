import { useEffect, useState } from "react";

/**
 * Mantém um popover montado durante a animação de saída (J1-06, A2-03):
 * `mounted` fica true até `ms` depois de fechar e `leaving` liga a classe de
 * saída. Com "reduzir movimento", some na hora.
 */
export function usePresence(open: boolean, ms = 130) {
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (open) { setMounted(true); setLeaving(false); return; }
    if (!mounted) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setMounted(false); return; }
    setLeaving(true);
    const t = window.setTimeout(() => { setMounted(false); setLeaving(false); }, ms);
    return () => window.clearTimeout(t);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return { mounted, leaving };
}
