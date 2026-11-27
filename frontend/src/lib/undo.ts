/**
 * Pilha de desfazer (achados A4-61, A2-31 e FA-A2-03 da avaliação de
 * 25/11/2026). Cada ação reversível (excluir, mover, renomear, ancorar,
 * restaurar da lixeira, editar metadado) já é gravada na hora e empilha aqui a
 * operação inversa. "Desfazer" no aviso ou Ctrl+Z (⌘Z) em qualquer tela tira a
 * de cima e a executa. Guarda as 20 últimas, só durante a sessão da aba.
 *
 * Depois de desfazer, a janela recebe o evento "docke:desfeito" para as telas
 * abertas recarregarem o que mudou.
 */
import { useCallback, useEffect } from "react";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";

export interface UndoEntry {
  id: string;
  /** Como a ação aparece no aviso de "desfeito": "Exclusão de 3 documentos". */
  label: string;
  undo: () => Promise<void>;
  /** Ações repetidas sobre a mesma coisa (digitar num campo) viram uma entrada só. */
  key?: string;
}

const stack: UndoEntry[] = [];
const MAX = 20;

export function pushUndo(label: string, undo: () => Promise<void>, key?: string): UndoEntry {
  // Mesma chave no topo: mantém a operação inversa mais antiga (volta ao valor
  // de antes da primeira edição), só troca o rótulo.
  const top = stack[stack.length - 1];
  if (key && top?.key === key) {
    top.label = label;
    return top;
  }
  const entry = { id: Math.random().toString(36).slice(2), label, undo, key };
  stack.push(entry);
  if (stack.length > MAX) stack.shift();
  return entry;
}

/** Tira uma entrada específica (o "Desfazer" do aviso) ou a do topo (Ctrl+Z). */
export function takeUndo(id?: string): UndoEntry | null {
  if (id) {
    const i = stack.findIndex((e) => e.id === id);
    return i >= 0 ? stack.splice(i, 1)[0] : null;
  }
  return stack.pop() ?? null;
}

export function hasUndo(): boolean {
  return stack.length > 0;
}

/** Ctrl+Z / ⌘Z fora de campos de texto (dentro deles vale o desfazer do próprio campo). */
export function isUndoShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return false;
  const t = e.target as HTMLElement | null;
  return !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
}

/** Desfazer com aviso, usado pelas telas e pelo atalho global. */
export function useUndo() {
  const { toast, error: showError } = useToast();

  const run = useCallback(async (id?: string) => {
    const entry = takeUndo(id);
    if (!entry) { toast({ type: "info", message: "Não há nada para desfazer." }); return; }
    try {
      await entry.undo();
      toast({ type: "success", message: `Desfeito: ${entry.label}.` });
    } catch (e: unknown) {
      showError(friendlyError(e, `Não foi possível desfazer: ${entry.label}.`));
    }
    window.dispatchEvent(new CustomEvent("docke:desfeito"));
  }, [toast, showError]);

  /** Aviso com "Desfazer" ligado à mesma entrada do Ctrl+Z. */
  const offer = useCallback((message: string, label: string, undo: () => Promise<void>) => {
    const entry = pushUndo(label, undo);
    toast({ type: "success", message, action: { label: "Desfazer", onClick: () => run(entry.id) } });
  }, [toast, run]);

  return { run, offer };
}

/** Ctrl+Z em qualquer tela do app (montado uma vez na casca). */
export function useUndoShortcut() {
  const { run } = useUndo();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isUndoShortcut(e)) return;
      // Com um diálogo aberto o atalho fica com ele (o campo ou o próprio diálogo).
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]')) return;
      e.preventDefault();
      run();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [run]);
}
