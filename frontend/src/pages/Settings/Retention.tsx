import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";

export default function Retention() {
  usePageTitle("Retenção");
  const { current } = useCompany();
  const { success, error: showError } = useToast();
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!current) return;
    setLoading(true);
    api.get(`/companies/${current.id}/retention`)
      .then((r) => setDays(r.data.retention_days ?? 30))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [current?.id]);

  async function save() {
    if (!current) return;
    setSaving(true);
    try {
      const { data } = await api.patch(`/companies/${current.id}/retention`, { retention_days: days });
      success(`Retenção atualizada para ${data.retention_days} dias.`);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Erro ao atualizar retenção.");
    } finally {
      setSaving(false);
    }
  }

  const carencia = Math.min(days, 7);

  return (
    <div>
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] p-6 space-y-5">
        <p className="text-mac-body font-medium text-[var(--text-primary)]">Dias na lixeira antes da exclusão permanente</p>

        {loading ? (
          <div className="h-9 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse max-w-[200px]" />
        ) : (
          <div className="flex items-center gap-2 max-w-[200px]">
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(Math.max(1, Number(e.target.value)))}
              className="w-24 h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
            <span className="text-mac-body text-[var(--text-secondary)]">dias</span>
          </div>
        )}

        <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-[var(--radius-control)]">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-mac-caption text-amber-800 dark:text-amber-300">
            Itens excluídos há mais de {carencia} dia{carencia !== 1 ? "s" : ""} manterão a retenção anterior.
            Itens mais recentes seguirão a nova regra imediatamente.
          </p>
        </div>

        <div className="flex justify-end">
          <Button size="sm" loading={saving} onClick={save}>Salvar</Button>
        </div>
      </div>
    </div>
  );
}
