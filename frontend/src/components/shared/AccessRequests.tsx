import { useEffect, useState } from "react";
import { Check, KeyRound, X } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { relativeDate } from "@/lib/date";
import Button from "@/components/ui/Button";
import Dropdown from "@/components/ui/Dropdown";

interface Pedido {
  id: string; folder_id: string; folder_name: string; folder_path_label: string | null; requester_name: string;
  message: string | null; created_at: string;
}
const PAPEIS = [{ value: "visualizador", label: "Visualizador" }, { value: "operador", label: "Operador" }, { value: "admin", label: "Administrador" }];

/** Pedidos de acesso pendentes (B3.1.6), para quem administra a empresa. Some quando não há nenhum. */
export function AccessRequestsPanel({ companyId, onChanged }: { companyId: string; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [pedidos, setPedidos] = useState<Pedido[]>([]);
  const [papel, setPapel] = useState<Record<string, string>>({});
  const [ate, setAte] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  function load() { api.get<Pedido[]>(`/companies/${companyId}/access-requests`).then((r) => setPedidos(r.data ?? [])).catch(() => setPedidos([])); }
  useEffect(load, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps
  async function decidir(p: Pedido, aprovar: boolean) {
    setBusy(p.id);
    try {
      await api.post(`/companies/access-requests/${p.id}/decide`, { aprovar, permission_level: papel[p.id] ?? "visualizador", expires_on: ate[p.id] || null });
      success(aprovar ? `${p.requester_name} agora acessa "${p.folder_name}".` : "Pedido recusado.");
      load();
      if (aprovar) onChanged();
    } catch (e) {
      showError(friendlyError(e, "Não foi possível responder agora."));
    } finally {
      setBusy(null);
    }
  }
  if (!pedidos.length) return null;
  return (
    <section aria-labelledby="pedidos-acesso" className="glass-panel rounded-(--radius-panel) p-4 space-y-2">
      <h3 id="pedidos-acesso" className="flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><KeyRound className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> Pedidos de acesso ({pedidos.length})</h3>
      <ul className="divide-y divide-(--border-default)">
        {pedidos.map((p) => (
          <li key={p.id} className="py-2.5 space-y-2">
            <p className="text-mac-body text-(--text-primary)"><strong>{p.requester_name}</strong> pediu acesso a <strong>{p.folder_path_label ?? p.folder_name}</strong> <span className="text-mac-caption text-(--text-secondary)">· {relativeDate(p.created_at)}</span></p>
            {p.message && <p className="text-mac-caption text-(--text-secondary) whitespace-pre-line">“{p.message}”</p>}
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-40"><Dropdown ariaLabel={`Papel para ${p.requester_name}`} value={papel[p.id] ?? "visualizador"} onChange={(v) => setPapel((x) => ({ ...x, [p.id]: v }))} options={PAPEIS} /></div>
              <input type="date" aria-label="Acesso até (opcional)" value={ate[p.id] ?? ""} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setAte((x) => ({ ...x, [p.id]: e.target.value }))}
                className="h-9 pointer-coarse:h-11 px-2 rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) text-mac-body text-(--text-primary)" />
              <Button size="sm" loading={busy === p.id} onClick={() => decidir(p, true)}><Check className="w-3.5 h-3.5" aria-hidden="true" /> Aprovar</Button>
              <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => decidir(p, false)}><X className="w-3.5 h-3.5" aria-hidden="true" /> Recusar</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Aviso em Documentos quando o link é de uma pasta que a pessoa não acessa (B3.1.6). */
export function RequestAccessBanner({ folderId, onClose }: { folderId: string; onClose: () => void }) {
  const { success, error: showError } = useToast();
  const [msg, setMsg] = useState("");
  const [enviado, setEnviado] = useState(false);
  const [busy, setBusy] = useState(false);
  async function pedir() {
    setBusy(true);
    try {
      await api.post("/companies/access-requests", { folder_id: folderId, message: msg.trim() || null });
      setEnviado(true);
      success("Pedido enviado ao admin da empresa. Você recebe um aviso quando ele responder.");
    } catch (e: any) {
      if (e?.response?.status === 404) showError("Esta pasta não existe mais ou é de uma empresa que você não acessa.");
      else showError(friendlyError(e, "Não foi possível pedir agora."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div role="alert" className="glass-panel rounded-(--radius-panel) p-4 space-y-2">
      <p className="text-mac-body font-medium text-(--text-primary)">{enviado ? "Pedido de acesso enviado." : "Você não acessa a pasta deste link (ou ela foi excluída)."}</p>
      {!enviado && (
        <>
          <p className="text-mac-caption text-(--text-secondary)">Se precisar dela, peça acesso: o admin da empresa recebe o pedido e responde por aqui.</p>
          <textarea rows={2} maxLength={500} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Por que precisa (opcional)" aria-label="Motivo do pedido"
            className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
          <div className="flex gap-2">
            <Button size="sm" loading={busy} onClick={pedir}><KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> Pedir acesso</Button>
            <Button size="sm" variant="ghost" onClick={onClose}>Fechar</Button>
          </div>
        </>
      )}
    </div>
  );
}
