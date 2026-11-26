import { useEffect, useState } from "react";
import { Link2 } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import Switch from "@/components/ui/Switch";
import Dropdown from "@/components/ui/Dropdown";

const MAXIMOS = [
  { value: "", label: "Sem limite" },
  { value: "1", label: "1 dia" },
  { value: "7", label: "7 dias" },
  { value: "30", label: "30 dias" },
  { value: "90", label: "90 dias" },
  { value: "365", label: "1 ano" },
];

/** Política de links públicos da empresa (FA-A5-08): senha obrigatória e validade máxima. */
export default function SharePolicyCard({ companyId, canEdit }: { companyId: string; canEdit: boolean }) {
  const { success, error: showError } = useToast();
  const [pol, setPol] = useState<{ require_password: boolean; max_days: number | null } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(`/companies/${companyId}/share-policy`).then((r) => setPol(r.data)).catch(() => setPol({ require_password: false, max_days: null }));
  }, [companyId]);

  async function salvar(next: { require_password: boolean; max_days: number | null }) {
    const antes = pol;
    setPol(next);
    setSaving(true);
    try {
      await api.put(`/companies/${companyId}/share-policy`, next);
      success("Política de links salva.");
    } catch (e: any) {
      setPol(antes);
      showError(friendlyError(e, "Não foi possível salvar a política de links. Tente de novo."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="glass-panel rounded-(--radius-panel) p-5 space-y-3" aria-labelledby="pol-links">
      <h3 id="pol-links" className="flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><Link2 className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> Links públicos</h3>
      <p className="text-mac-caption text-(--text-secondary)">Regras para todo link de compartilhamento desta empresa. Pasta com dado sensível já não aceita link.</p>
      {!pol ? (
        <div className="h-16 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />
      ) : (
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-3 text-mac-body text-(--text-primary)">
            Exigir senha em todo link
            <Switch checked={pol.require_password} disabled={!canEdit || saving} label="Exigir senha em todo link"
              onChange={() => salvar({ ...pol, require_password: !pol.require_password })} />
          </label>
          <div className="flex items-center justify-between gap-3">
            <span id="pol-max" className="text-mac-body text-(--text-primary)">Validade máxima</span>
            <Dropdown className="w-40" ariaLabelledby="pol-max" value={pol.max_days ? String(pol.max_days) : ""} options={MAXIMOS}
              onChange={(v) => { if (canEdit && !saving) salvar({ ...pol, max_days: v ? Number(v) : null }); }} />
          </div>
          {!canEdit && <p className="text-mac-caption text-(--text-secondary)">Só quem administra a empresa muda estas regras.</p>}
        </div>
      )}
    </section>
  );
}
