import { useEffect, useState } from "react";
import { Smartphone } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import Dropdown from "@/components/ui/Dropdown";

const OPCOES = [
  { value: "admins_sensiveis", label: "Administradores e quem vê dados pessoais" },
  { value: "admins", label: "Só administradores" },
  { value: "todos", label: "Todo mundo" },
  { value: "desligada", label: "Ninguém é obrigado" },
];

/** Quem precisa da verificação em duas etapas nesta empresa (decisão do dono, 26/11/2026). */
export default function MfaPolicyCard({ companyId }: { companyId: string }) {
  const { success, error: showError } = useToast();
  const [pol, setPol] = useState<{ policy: string; can_edit: boolean } | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [saving, setSaving] = useState(false);
  const [motivo, setMotivo] = useState("");

  useEffect(() => {
    setFalhou(false);
    api.get(`/companies/${companyId}/mfa-policy`).then((r) => setPol(r.data)).catch(() => setFalhou(true));
  }, [companyId]);

  async function salvar(policy: string) {
    if (!pol || policy === pol.policy) return;
    const antes = pol;
    setPol({ ...pol, policy });
    setSaving(true);
    try {
      await api.put(`/companies/${companyId}/mfa-policy`, { policy, motivo: motivo.trim() || null });
      success("Regra da verificação em duas etapas salva.");
    } catch (e: any) {
      setPol(antes);
      showError(friendlyError(e, "Não foi possível salvar a regra. Tente de novo."));
    } finally {
      setSaving(false);
    }
  }

  if (falhou) return null;
  return (
    <section className="glass-panel rounded-(--radius-panel) p-5 space-y-3" aria-labelledby="pol-mfa">
      <h3 id="pol-mfa" className="flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><Smartphone className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> Verificação em duas etapas</h3>
      <p className="text-mac-caption text-(--text-secondary)">
        Quem precisa digitar o código do app autenticador, além da senha. "Dados pessoais" são as pastas marcadas como dado pessoal ou sensível (RH e afins). O administrador geral sempre usa.
      </p>
      {!pol ? (
        <div className="h-10 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span id="pol-mfa-quem" className="text-mac-body text-(--text-primary)">Quem precisa</span>
          <Dropdown className="w-72 max-w-full" ariaLabelledby="pol-mfa-quem" value={pol.policy} options={OPCOES} disabled={!pol.can_edit || saving}
            onChange={(v) => { if (pol.can_edit && !saving) salvar(v); }} />
          {!pol.can_edit && <p className="w-full text-mac-caption text-(--text-secondary)">Só o administrador geral muda esta regra.</p>}
          {pol.can_edit && (
            <input value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={300} aria-label="Motivo da mudança (opcional)"
              placeholder="Motivo da mudança (opcional, vai para a Atividade)"
              className="mac-field w-full h-8 pointer-coarse:h-11 px-2.5 text-mac-caption text-(--text-primary)" />
          )}
        </div>
      )}
    </section>
  );
}
