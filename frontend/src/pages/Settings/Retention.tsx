import { useEffect, useState } from "react";
import { Archive, AlertTriangle } from "lucide-react";
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
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-[var(--text-primary)]">Retenção</h2>

      <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Archive className="w-4 h-4 text-teal-600" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Dias na lixeira antes da exclusão permanente</h3>
        </div>

        {loading ? (
          <div className="h-9 bg-[var(--bg-hover)] rounded-[8px] animate-pulse max-w-[200px]" />
        ) : (
          <div className="flex items-center gap-2 max-w-[200px]">
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(Math.max(1, Number(e.target.value)))}
              className="w-24 h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
            <span className="text-sm text-[var(--text-secondary)]">dias</span>
          </div>
        )}

        <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900/40 rounded-[8px]">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-amber-800 dark:text-amber-300">
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
