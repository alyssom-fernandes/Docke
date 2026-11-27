import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";

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
  const [atual, setAtual] = useState<{ sensitivity: Sens; effective: Sens; inherited: boolean; legal_basis?: string | null; purpose?: string | null; bases_legais?: string[] } | null>(null);
  const [escolha, setEscolha] = useState<Sens>("normal");
  // B3.7.6: base legal e finalidade do tratamento (opcionais).
  const [base, setBase] = useState("");
  const [finalidade, setFinalidade] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get(`/folders/${folderId}/privacy`).then((r) => { setAtual(r.data); setEscolha(r.data.sensitivity); setBase(r.data.legal_basis ?? ""); setFinalidade(r.data.purpose ?? ""); }).catch(() => setAtual({ sensitivity: "normal", effective: "normal", inherited: false }));
  }, [folderId]);

  async function salvar() {
    setBusy(true);
    try {
      const r = await api.put(`/folders/${folderId}/privacy`, { sensitivity: escolha, legal_basis: base || null, purpose: finalidade || null });
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
        <p className="mb-3 flex items-start gap-2 rounded-(--radius-control) bg-(--tint-warning) px-3 py-2 text-mac-caption text-(--text-primary)">
          <ShieldAlert className="w-3.5 h-3.5 mt-0.5 text-(--text-warning) shrink-0" aria-hidden="true" />
          Uma pasta acima já está como “{PRIVACY_LABEL[atual.effective]}”: a classificação mais restritiva continua valendo aqui.
        </p>
      )}
      <div role="radiogroup" aria-label="Classificação" className="space-y-2">
        {OPCOES.map((o) => (
          <button key={o.v} type="button" role="radio" aria-checked={escolha === o.v} onClick={() => setEscolha(o.v)}
            className={`w-full text-left rounded-(--radius-control) border p-3 transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${escolha === o.v ? "border-(--accent) bg-(--tint-accent)" : "border-(--border-control) hover:bg-(--bg-hover)"}`}>
            <span className="block text-mac-body font-medium text-(--text-primary)">{o.titulo}</span>
            <span className="block text-mac-caption text-(--text-secondary)">{o.texto}</span>
          </button>
        ))}
      </div>
      {escolha !== "normal" && (
        <div className="mt-4 space-y-3">
          <div>
            <span id="priv-base" className="block mb-1 text-mac-body font-medium text-(--text-secondary)">Base legal (opcional)</span>
            <Dropdown ariaLabelledby="priv-base" value={base} onChange={setBase}
              options={[{ value: "", label: "Não informada" }, ...(atual?.bases_legais ?? []).map((b) => ({ value: b, label: b })), ...(base && !(atual?.bases_legais ?? []).includes(base) ? [{ value: base, label: base }] : [])]} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="priv-fin" className="text-mac-body font-medium text-(--text-secondary)">Finalidade (opcional)</label>
            <textarea id="priv-fin" rows={2} maxLength={500} value={finalidade} onChange={(e) => setFinalidade(e.target.value)}
              placeholder="Ex.: folha de pagamento e obrigações trabalhistas (eSocial)."
              className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
          </div>
          <p className="text-mac-caption text-(--text-secondary)">Aparecem no relatório para o encarregado (Ajustes → Privacidade).</p>
        </div>
      )}
    </Dialog>
  );
}
