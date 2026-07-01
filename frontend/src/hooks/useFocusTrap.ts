import { useEffect, RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Traps Tab/Shift+Tab focus within the given container ref while active.
 * Restores focus to the previously-focused element on unmount.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement>, active = true) {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;

    function getFocusable() {
      return Array.from(
        containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
      ).filter((el) => !el.closest("[aria-hidden='true']"));
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = getFocusable();
      if (!focusable.length) { e.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [active, containerRef]);
}
