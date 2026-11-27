import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { createElement } from "react";

interface CPCtx {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}

const Ctx = createContext<CPCtx>({ isOpen: false, open: () => {}, close: () => {}, toggle: () => {} });

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((v) => !v), []);

  useEffect(() => {
    function handle(e: KeyboardEvent) {
      // Com Caps Lock (ou Shift) a tecla chega como "K": o atalho vale igual.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [toggle, close]);

  return createElement(Ctx.Provider, { value: { isOpen, open, close, toggle } }, children);
}

export function useCommandPalette() {
  return useContext(Ctx);
}
