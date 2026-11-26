import { useState } from "react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { friendlyError } from "@/lib/errors";
import { FORBIDDEN_NAME_CHARS, type DocFolder } from "@/components/documents/docShared";

export function CreateFolderModal({ parentId, parentName, siblings, companyId, onClose, onDone }: {
  parentId: string | null; parentName: string; siblings: string[]; companyId: string; onClose: () => void; onDone: (folder: DocFolder) => void;
}) {
  const { success } = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Mesma regra do backend (achado A4-40): avisa enquanto digita.
  const trimmed = name.trim().replace(/\s+/g, " ");
  const localError =
    trimmed && FORBIDDEN_NAME_CHARS.test(trimmed) ? 'O nome não pode ter \\ / : * ? " < > |.'
    : trimmed.endsWith(".") ? "O nome não pode terminar com ponto."
    : trimmed && siblings.some((n) => n.toLowerCase() === trimmed.toLowerCase()) ? `Já existe uma pasta "${trimmed}" aqui.`
    : "";

  async function create() {
    if (!trimmed || localError) return;
    setSaving(true);
    setError("");
    try {
      const { data } = await api.post("/folders", { name: trimmed, company_id: companyId, parent_id: parentId });
      success(`Pasta "${data.name}" criada.`);
      onDone(data);
      onClose();
    } catch (e: any) {
      setError(friendlyError(e, "Não foi possível criar a pasta."));
    } finally {
      setSaving(false);
    }
  }

  const shown = error || localError;
  return (
    <Dialog
      onClose={onClose}
      title="Nova pasta"
      description={<>Em <strong className="font-medium text-(--text-primary)">{parentName}</strong></>}
      size="sm"
      busy={saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button loading={saving} onClick={create} disabled={!trimmed || !!localError}>Criar pasta</Button>
        </>
      }
    >
      <label htmlFor="nova-pasta-nome" className="block text-mac-body font-medium text-(--text-secondary) mb-1.5">Nome</label>
      <input
        id="nova-pasta-nome"
        type="text"
        value={name}
        maxLength={150}
        onChange={(e) => { setName(e.target.value); setError(""); }}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); create(); } }}
        placeholder="Ex.: Notas fiscais 2026"
        aria-invalid={shown ? true : undefined}
        aria-describedby={shown ? "nova-pasta-erro" : undefined}
        className="w-full h-9 pointer-coarse:h-11 px-3 text-mac-body pointer-coarse:text-[16px] bg-(--bg-card) border border-(--border-control) rounded-(--radius-control) text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
      />
      {shown && <p id="nova-pasta-erro" role="alert" className="mt-1.5 text-mac-caption text-(--text-danger)">{shown}</p>}
    </Dialog>
  );
}

// ─── Detail Drawer ────────────────────────────────────────────────────────────
