/**
 * Aviso de alteração não salva ao sair pelo próprio app (achado A8-07 da
 * avaliação de 25/11/2026). O app usa BrowserRouter, sem bloqueio de rota,
 * então o aviso intercepta o clique em links internos enquanto há algo
 * pendente; fechar a aba já é coberto por "beforeunload" na própria tela.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ConfirmModal from "@/components/ui/ConfirmModal";

export function useUnsavedGuard(dirty: boolean, onSave?: () => Promise<boolean | void> | void) {
  const navigate = useNavigate();
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const to = url.pathname + url.search + url.hash;
      if (to === window.location.pathname + window.location.search + window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      setTarget(to);
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  const modal = target ? (
    <ConfirmModal
      title="Sair sem salvar?"
      description="Há alterações nesta tela que ainda não foram salvas."
      confirmLabel={onSave ? "Salvar e sair" : "Sair sem salvar"}
      cancelLabel="Continuar editando"
      onClose={() => setTarget(null)}
      onConfirm={async () => {
        const to = target;
        if (onSave) {
          const ok = await onSave();
          if (ok === false) { setTarget(null); return; }
        }
        setTarget(null);
        navigate(to);
      }}
    />
  ) : null;

  return modal;
}
