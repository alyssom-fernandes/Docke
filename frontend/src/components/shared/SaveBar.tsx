import Button from "@/components/ui/Button";

/**
 * Fase 10.3 — Save Bar padronizada: barra que só aparece quando há alterações
 * pendentes (dirty state), em vez de um botão "Salvar" estático sempre visível
 * mesmo sem nada mudado. Padrão macOS System Settings / Linear.
 */
export default function SaveBar({ visible, saving, onSave, onDiscard }: {
  visible: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!visible) return null;
  return (
    <div className="sticky bottom-0 -mx-6 -mb-6 mt-2 px-6 py-3 border-t border-(--border-default) bg-(--bg-card)/95 backdrop-blur-xs flex items-center justify-between gap-3 rounded-b-(--radius-panel) page-enter">
      <span className="text-mac-caption text-(--text-secondary)">Você tem alterações não salvas.</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onDiscard} disabled={saving}>Descartar</Button>
        <Button size="sm" onClick={onSave} loading={saving}>Salvar</Button>
      </div>
    </div>
  );
}
