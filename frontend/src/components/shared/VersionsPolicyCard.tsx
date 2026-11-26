import { useEffect, useState } from "react";
import { History } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import Dropdown from "@/components/ui/Dropdown";
import ConfirmModal from "@/components/ui/ConfirmModal";

const OPCOES = [
  { value: "", label: "Para sempre" },
  { value: "30", label: "30 dias" },
  { value: "180", label: "180 dias" },
  { value: "365", label: "1 ano" },
  { value: "1825", label: "5 anos" },
];

/** Retenção do histórico de versões (B1.4.9): por quanto tempo guardar a versão substituída. */
export default function VersionsPolicyCard({ companyId }: { companyId: string }) {
  const { success, error: showError } = useToast();
  const [pol, setPol] = useState<{ keep_days: number | null; can_edit: boolean } | null>(null);
  const [pendente, setPendente] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get(`/companies/${companyId}/versions-policy`).then((r) => setPol(r.data)).catch(() => setPol(null));
  }, [companyId]);

  async function salvar(v: string) {
    setSaving(true);
    try {
      const r = await api.put(`/companies/${companyId}/versions-policy`, { keep_days: v ? Number(v) : null });
      setPol(r.data);
      success(v ? `Versões substituídas ficam guardadas por ${OPCOES.find((o) => o.value === v)?.label}.` : "Versões antigas ficam guardadas para sempre.");
    } catch (e) {
      showError(friendlyError(e, "Não foi possível salvar."));
    } finally {
      setSaving(false);
      setPendente(null);
    }
  }

  if (!pol) return null;
  const atual = pol.keep_days ? String(pol.keep_days) : "";
  const opcoes = OPCOES.some((o) => o.value === atual) ? OPCOES : [...OPCOES, { value: atual, label: `${pol.keep_days} dias` }];
  return (
    <section className="glass-panel rounded-(--radius-panel) p-5 space-y-3" aria-labelledby="pol-versoes">
      <h3 id="pol-versoes" className="flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><History className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> Histórico de versões</h3>
      <p className="text-mac-caption text-(--text-secondary)">
        Por quanto tempo uma versão antiga fica guardada depois de ser substituída. A versão atual nunca sai, e documento sob bloqueio judicial ou retenção travada guarda todas.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span id="pol-versoes-quanto" className="text-mac-body text-(--text-primary)">Guardar versões antigas</span>
        <Dropdown className="w-48" ariaLabelledby="pol-versoes-quanto" value={atual} options={opcoes} disabled={!pol.can_edit || saving}
          onChange={(v) => { if (v !== atual) { if (v) setPendente(v); else salvar(v); } }} />
      </div>
      {!pol.can_edit && <p className="text-mac-caption text-(--text-secondary)">Só o administrador geral muda este prazo.</p>}
      {pendente && (
        <ConfirmModal title="Apagar versões antigas depois do prazo?" confirmLabel="Confirmar" danger loading={saving}
          description={`Versões substituídas há mais de ${OPCOES.find((o) => o.value === pendente)?.label} serão apagadas de vez pela manutenção (até 200 por vez), e cada exclusão fica na trilha. Não dá para desfazer.`}
          onClose={() => setPendente(null)} onConfirm={() => salvar(pendente)} />
      )}
    </section>
  );
}
