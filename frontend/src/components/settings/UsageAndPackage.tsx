import { useEffect, useRef, useState } from "react";
import { HardDrive, Download, Upload } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { fmtSize } from "@/components/documents/docShared";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";

/**
 * Uso, cota e pacote de configuração da empresa (B4.2.8): quanto a empresa
 * guarda, o limite (o administrador geral define), e exportar/importar
 * campos, políticas de guarda e modelos de obrigação entre empresas.
 */
interface Uso { documentos: number; na_lixeira: number; pastas: number; pessoas: number; bytes_total: number; bytes_versoes: number; cota_bytes: number | null }
type Resumo = { campos: { novos: string[]; ja_existem: number }; politicas: { novas: string[]; ja_existem: number }; modelos: { novos: string[]; ja_existem: number }; aplicado: boolean };

export default function UsageAndPackage({ companyId, supremo }: { companyId: string; supremo: boolean }) {
  const { success, error: showError } = useToast();
  const [uso, setUso] = useState<Uso | null>(null);
  const [cotaGb, setCotaGb] = useState("");
  const [editandoCota, setEditandoCota] = useState(false);
  const [pacote, setPacote] = useState<Record<string, unknown> | null>(null);
  const [previa, setPrevia] = useState<Resumo | null>(null);
  const [busy, setBusy] = useState(false);
  const arquivo = useRef<HTMLInputElement>(null);

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
  async function exportar() {
    try {
      const r = await api.get(`/companies/${companyId}/config-package`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url; a.download = "docke-pacote-de-configuracao.json"; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { showError(friendlyError(e, "Não foi possível exportar.")); }
  }
  async function lerArquivo(f: File | undefined) {
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      setBusy(true);
      const r = await api.post<Resumo>(`/companies/${companyId}/config-package/import`, { pacote: p, aplicar: false });
      setPacote(p); setPrevia(r.data);
    } catch (e) { showError(e instanceof SyntaxError ? "O arquivo não é um JSON válido." : friendlyError(e, "Não foi possível ler o pacote.")); }
    finally { setBusy(false); if (arquivo.current) arquivo.current.value = ""; }
  }
  async function aplicar() {
    if (!pacote) return;
    setBusy(true);
    try {
      await api.post(`/companies/${companyId}/config-package/import`, { pacote, aplicar: true });
      success("Configuração importada."); setPacote(null); setPrevia(null);
    } catch (e) { showError(friendlyError(e, "Não foi possível importar.")); } finally { setBusy(false); }
  }

  if (!uso) return null;
  const pct = uso.cota_bytes ? Math.min(100, Math.round((uso.bytes_total / uso.cota_bytes) * 100)) : null;
  const nada = previa && !previa.campos.novos.length && !previa.politicas.novas.length && !previa.modelos.novos.length;
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
      <div className="flex flex-wrap items-center gap-2 border-t border-(--border-default) pt-3">
        <p className="text-mac-caption text-(--text-secondary) basis-full">Pacote de configuração: campos de metadado, políticas de guarda e modelos de obrigação, para levar a outra empresa.</p>
        <Button size="sm" variant="secondary" onClick={exportar}><Download className="w-4 h-4" aria-hidden="true" /> Exportar</Button>
        <Button size="sm" variant="secondary" loading={busy && !previa} onClick={() => arquivo.current?.click()}><Upload className="w-4 h-4" aria-hidden="true" /> Importar…</Button>
        <input ref={arquivo} type="file" accept="application/json,.json" className="sr-only" aria-label="Escolher pacote" onChange={(e) => lerArquivo(e.target.files?.[0])} />
      </div>
      {previa && (
        <Dialog onClose={() => { setPrevia(null); setPacote(null); }} title="Importar configuração" size="sm" busy={busy}
          description={nada ? "Tudo o que está no pacote já existe nesta empresa." : "Entra só o que ainda não existe aqui (pelo nome). Nada é apagado ou alterado."}
          footer={<><Button variant="secondary" onClick={() => { setPrevia(null); setPacote(null); }}>Cancelar</Button>{!nada && <Button loading={busy} onClick={aplicar}>Importar</Button>}</>}>
          <ul className="space-y-2 text-mac-body text-(--text-primary)">
            {([["Campos", previa.campos.novos, previa.campos.ja_existem], ["Políticas de guarda", previa.politicas.novas, previa.politicas.ja_existem], ["Modelos de obrigação", previa.modelos.novos, previa.modelos.ja_existem]] as const).map(([t, novos, ja]) => (
              <li key={t}>
                <strong>{t}:</strong> {novos.length} {novos.length === 1 ? "novo" : "novos"}{ja ? `, ${ja} já existe${ja === 1 ? "" : "m"}` : ""}
                {novos.length > 0 && <span className="block text-mac-caption text-(--text-secondary) truncate">{novos.slice(0, 6).join(", ")}{novos.length > 6 ? "…" : ""}</span>}
              </li>
            ))}
          </ul>
        </Dialog>
      )}
    </section>
  );
}
