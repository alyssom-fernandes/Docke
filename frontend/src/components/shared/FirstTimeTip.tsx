import { useEffect, useState } from "react";
import { Command, X } from "lucide-react";
import { useAuthContext } from "@/lib/AuthContext";
import { openKeyboardShortcuts } from "@/components/shared/KeyboardShortcuts";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Dica da primeira vez (B4.3.5): aparece uma vez por pessoa, depois de entrar,
 * no canto da janela (só no computador, onde há teclado). "Entendi" some de
 * vez; "Ver atalhos" abre o painel, que fica sempre a um "?" de distância.
 */
export default function FirstTimeTip() {
  const { user } = useAuthContext();
  const chave = user ? `docke_dica_inicial_${user.id}` : null;
  const [aberta, setAberta] = useState(false);

  useEffect(() => {
    if (!chave || localStorage.getItem(chave)) return;
    if (!window.matchMedia("(pointer: fine) and (min-width: 1024px)").matches) return;
    const t = window.setTimeout(() => setAberta(true), 2500);
    return () => window.clearTimeout(t);
  }, [chave]);

  if (!aberta || !chave) return null;
  const fechar = () => { localStorage.setItem(chave, "1"); setAberta(false); };
  return (
    <div role="status" aria-live="polite" className="menu-in fixed z-[70] bottom-5 right-5 w-[300px] rounded-(--radius-popover) mac-sheet shadow-(--shadow-dropdown) p-4 space-y-2">
      <div className="flex items-start gap-2">
        <Command className="w-4 h-4 mt-0.5 text-(--text-accent) shrink-0" aria-hidden="true" />
        <p className="flex-1 text-mac-body text-(--text-primary)">
          <strong className="font-semibold">{isMac ? "⌘K" : "Ctrl K"}</strong> busca documentos, pastas e ações de qualquer tela. <strong className="font-semibold">?</strong> mostra todos os atalhos.
        </p>
        <button type="button" onClick={fechar} aria-label="Fechar a dica" className="w-6 h-6 -mt-1 -mr-1 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><X className="w-3.5 h-3.5" aria-hidden="true" /></button>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => { fechar(); openKeyboardShortcuts(); }} className="h-7 px-3 rounded-full text-mac-caption font-medium text-(--text-accent) hover:bg-(--bg-hover)">Ver atalhos</button>
        <button type="button" onClick={fechar} className="h-7 px-3 rounded-full text-mac-caption font-medium bg-(--accent) text-white hover:bg-(--accent-hover)">Entendi</button>
      </div>
    </div>
  );
}
