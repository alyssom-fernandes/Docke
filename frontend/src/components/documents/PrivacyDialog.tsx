import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";

type Sens = "normal" | "pessoal" | "sensivel";
const OPCOES: { v: Sens; titulo: string; texto: string }[] = [
  { v: "normal", titulo: "Sem classificação", texto: "Documentos da empresa sem dado pessoal relevante." },
  { v: "pessoal", titulo: "Dado pessoal", texto: "Nome, CPF, endereço, salário (holerites, contratos de trabalho, admissões)." },
  { v: "sensivel", titulo: "Dado sensível", texto: "Saúde (ASO, atestados, exames), biometria, filiação sindical. Bloqueia link público." },
];

export const PRIVACY_LABEL: Record<string, string> = { pessoal: "Dado pessoal", sensivel: "Dado sensível" };

/**
 * Classificação LGPD de uma pasta (X2-17): vale para as subpastas; "dado
 * sensível" bloqueia link público. A mudança entra na trilha.
 */
export default function PrivacyDialog({ folderId, folderName, onClose, onSaved }: {
  folderId: string; folderName: string; onClose: () => void; onSaved?: (effective: Sens) => void;
}) {
  const { success, error: showError } = useToast();
  const [atual, setAtual] = useState<{ sensitivity: Sens; effective: Sens; inherited: boolean } | null>(null);
  const [escolha, setEscolha] = useState<Sens>("normal");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/folders/${folderId}/privacy`).then((r) => { setAtual(r.data); setEscolha(r.data.sensitivity); }).catch(() => setAtual({ sensitivity: "normal", effective: "normal", inherited: false }));
  }, [folderId]);

  async function salvar() {
    setBusy(true);
    try {
      const r = await api.put(`/folders/${folderId}/privacy`, { sensitivity: escolha });
      success(`"${folderName}": ${OPCOES.find((o) => o.v === escolha)?.titulo.toLowerCase()}.`);
      onSaved?.(r.data.effective);
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível salvar a classificação.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} size="sm" busy={busy} title={`Privacidade de "${folderName}"`}
      description="Classificação pela LGPD. Vale para esta pasta e as subpastas."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} onClick={salvar} disabled={!atual}>Salvar</Button></>}>
      {atual?.inherited && (
        <p className="mb-3 flex items-start gap-2 rounded-(--radius-control) bg-amber-500/10 px-3 py-2 text-mac-caption text-(--text-primary)">
          <ShieldAlert className="w-3.5 h-3.5 mt-0.5 text-(--text-warning) shrink-0" aria-hidden="true" />
          Uma pasta acima já está como “{PRIVACY_LABEL[atual.effective]}”: a classificação mais restritiva continua valendo aqui.
        </p>
      )}
      <div role="radiogroup" aria-label="Classificação" className="space-y-2">
        {OPCOES.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={escolha === o.v} onClick={() => setEscolha(o.v)}
            className={`w-full text-left rounded-(--radius-control) border p-3 transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${escolha === o.v ? "border-teal-600 bg-teal-500/10" : "border-(--border-control) hover:bg-(--bg-hover)"}`}>
            <span className="block text-mac-body font-medium text-(--text-primary)">{o.titulo}</span>
            <span className="block text-mac-caption text-(--text-secondary)">{o.texto}</span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
