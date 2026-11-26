/**
 * Pilha de desfazer (achado A4-61 da avaliação de 25/11/2026). Cada ação que
 * mexe em documentos ou pastas (excluir, mover, renomear) já é gravada na hora
 * e empilha aqui a operação inversa. "Desfazer" no aviso ou Ctrl+Z (⌘Z) tira
 * a de cima e a executa. Guarda as 20 últimas, só durante a sessão da aba.
 */
export interface UndoEntry {
  id: string;
  /** Como a ação aparece no aviso de "desfeito": "Exclusão de 3 documentos". */
  label: string;
  undo: () => Promise<void>;
}

const stack: UndoEntry[] = [];
const MAX = 20;

export function pushUndo(label: string, undo: () => Promise<void>): UndoEntry {
  const entry = { id: Math.random().toString(36).slice(2), label, undo };
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

/** Ctrl+Z / ⌘Z fora de campos de texto. */
export function isUndoShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return false;
  const t = e.target as HTMLElement | null;
  return !(t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable));
}
