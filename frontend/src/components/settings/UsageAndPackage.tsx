import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { HardDrive } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { fmtSize } from "@/components/documents/docShared";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

/**
 * Uso e cota da empresa (B4.2.8): quanto a empresa guarda e o limite (o
 * administrador geral define). O pacote de configuração fica em Organização.
 */
interface Uso { documentos: number; na_lixeira: number; pastas: number; pessoas: number; bytes_total: number; bytes_versoes: number; cota_bytes: number | null }

export default function UsageAndPackage({ companyId, supremo }: { companyId: string; supremo: boolean }) {
  const { success, error: showError } = useToast();
  const [uso, setUso] = useState<Uso | null>(null);
  const [cotaGb, setCotaGb] = useState("");
  const [editandoCota, setEditandoCota] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api.get<Uso>(`/companies/${companyId}/usage`).then((r) => setUso(r.data)).catch(() => setUso(null));
  useEffect(() => { load(); }, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function salvarCota() {
    setBusy(true);
    try {
      const n = Number(cotaGb.replace(",", "."));
      await api.put(`/companies/${companyId}/quota`, { quota_gb: cotaGb.trim() && n > 0 ? n : null });
      success(cotaGb.trim() ? "Cota definida." : "Cota removida."); setEditandoCota(false); load();
    } catch (e) { showError(friendlyError(e, "Não foi possível mudar a cota.")); } finally { setBusy(false); }
  }

  if (!uso) return null;
  const pct = uso.cota_bytes ? Math.min(100, Math.round((uso.bytes_total / uso.cota_bytes) * 100)) : null;
  return (
    <section aria-labelledby="uso-titulo" className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 space-y-4">
      <div className="flex items-start gap-3">
        <HardDrive className="w-5 h-5 text-(--text-accent) mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <h2 id="uso-titulo" className="text-mac-callout font-semibold text-(--text-primary)">Uso e configuração</h2>
          <p className="text-mac-caption text-(--text-secondary)">
            {uso.documentos.toLocaleString("pt-BR")} documentos · {uso.pastas.toLocaleString("pt-BR")} pastas · {uso.pessoas} pessoas · {uso.na_lixeira} na lixeira
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between text-mac-caption">
          <span className="text-(--text-primary)">{fmtSize(uso.bytes_total)} guardados{uso.bytes_versoes ? ` (${fmtSize(uso.bytes_versoes)} em versões antigas)` : ""}</span>
          <span className="text-(--text-secondary)">{uso.cota_bytes ? `de ${fmtSize(uso.cota_bytes)}` : "sem limite"}</span>
        </div>
        {pct !== null && (
          <div className="h-2 rounded-full bg-(--bg-hover) overflow-hidden" role="progressbar" aria-label="Uso da cota" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={`h-full rounded-full ${pct >= 90 ? "bg-(--text-danger)" : pct >= 75 ? "bg-(--text-warning)" : "bg-(--accent)"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
        {supremo && (editandoCota ? (
          <div className="flex items-end gap-2 max-w-sm">
            <Input label="Cota em GB (vazio = sem limite)" inputMode="decimal" value={cotaGb} onChange={(e) => setCotaGb(e.target.value)} />
            <Button size="sm" loading={busy} onClick={salvarCota}>Salvar</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditandoCota(false)}>Cancelar</Button>
          </div>
        ) : (
          <button type="button" onClick={() => { setCotaGb(uso.cota_bytes ? String(+(uso.cota_bytes / 1024 ** 3).toFixed(1)).replace(".", ",") : ""); setEditandoCota(true); }}
            className="text-mac-caption font-medium text-(--text-accent) hover:underline">{uso.cota_bytes ? "Mudar a cota" : "Definir uma cota"}</button>
        ))}
      </div>
      <p className="border-t border-(--border-default) pt-3 text-mac-caption text-(--text-secondary)">
        Para levar campos, modelos e regras de guarda a outra empresa, use o pacote de configuração em <Link to="/settings/organization" className="font-medium text-(--text-accent) hover:underline">Organização</Link>.
      </p>
    </section>
  );
}
