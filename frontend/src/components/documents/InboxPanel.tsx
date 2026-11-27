import { useEffect, useState } from "react";
import { Inbox, Check } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";

/*
 * Pasta de triagem (B1.1.8): quando a pasta aberta é a "Entrada" da empresa,
 * mostra a sugestão de destino de cada documento (com o motivo) e move os
 * marcados de uma vez. Nada sai daqui sem confirmação.
 */

interface Item {
  id: string; name: string; tipo_fiscal: string | null; uploaded_by_name: string | null;
  sugestao: { folder_id: string | null; folder_label: string | null; motivo: string | null; competencia: string | null };
}

export default function InboxPanel({ companyId, folderId, onMoved }: { companyId: string; folderId: string; onMoved: () => void }) {
  const { success, error: showError } = useToast();
  const [itens, setItens] = useState<Item[] | null>(null);
  const [marcados, setMarcados] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  function carregar() {
    api.get<{ folder: { id: string } | null; documents: Item[] }>(`/companies/${companyId}/inbox`).then((r) => {
      if (r.data.folder?.id !== folderId) { setItens(null); return; }
      setItens(r.data.documents);
      setMarcados(new Set(r.data.documents.filter((d) => d.sugestao.folder_id).map((d) => d.id)));
    }).catch(() => setItens(null));
  }
  useEffect(carregar, [companyId, folderId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!itens || itens.length === 0) return null;
  const comSugestao = itens.filter((d) => d.sugestao.folder_id);

  async function confirmar() {
    const escolhidos = itens!.filter((d) => marcados.has(d.id) && d.sugestao.folder_id);
    if (!escolhidos.length) return;
    setBusy(true);
    try {
      for (const d of escolhidos.filter((x) => x.sugestao.competencia)) {
        await api.patch(`/documents/${d.id}`, { competencia: d.sugestao.competencia });
      }
      const porPasta = new Map<string, string[]>();
      for (const d of escolhidos) porPasta.set(d.sugestao.folder_id!, [...(porPasta.get(d.sugestao.folder_id!) ?? []), d.id]);
      for (const [target, ids] of porPasta) await api.post("/documents/bulk-move", { document_ids: ids, target_folder_id: target });
      success(`${escolhidos.length} ${escolhidos.length === 1 ? "documento movido" : "documentos movidos"} para ${porPasta.size} ${porPasta.size === 1 ? "pasta" : "pastas"}.`);
      onMoved();
      carregar();
    } catch (e: any) {
      showError(typeof e?.response?.data?.detail === "string" ? e.response.data.detail : "Não foi possível mover todos. Confira a pasta e tente de novo.");
      onMoved();
      carregar();
    } finally { setBusy(false); }
  }

  return (
    <section aria-labelledby="triagem-titulo" className="mx-3 mt-3 rounded-(--radius-panel) border border-teal-500/30 bg-(--accent)/5 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="triagem-titulo" className="flex-1 flex items-center gap-2 text-mac-body font-semibold text-(--text-primary)"><Inbox className="w-4 h-4 text-(--text-accent)" aria-hidden />Triagem · {itens.length} {itens.length === 1 ? "documento" : "documentos"}</h2>
        <Button size="sm" loading={busy} disabled={!marcados.size} onClick={confirmar}><Check className="w-3.5 h-3.5" aria-hidden />Mover os marcados ({marcados.size})</Button>
      </div>
      <p className="text-mac-caption text-(--text-secondary)">{comSugestao.length} com sugestão de destino. Confira e mova; sem sugestão, use “Mover para…” no documento.</p>
      <ul className="divide-y divide-(--border-default)">
        {itens.map((d) => (
          <li key={d.id} className="flex items-start gap-2 py-1.5">
            <Checkbox checked={marcados.has(d.id)} disabled={!d.sugestao.folder_id}
              onChange={(e) => setMarcados((m) => { const n = new Set(m); if (e.target.checked) n.add(d.id); else n.delete(d.id); return n; })}
              aria-label={`Mover ${d.name}`} />
            <div className="min-w-0 flex-1">
              <p className="text-mac-body text-(--text-primary) truncate">{d.name}</p>
              <p className="text-mac-caption text-(--text-secondary)">
                {d.sugestao.folder_id ? <>→ <strong className="font-medium text-(--text-primary)">{d.sugestao.folder_label}</strong> · {d.sugestao.motivo}</> : "Sem sugestão"}
                {d.sugestao.competencia ? ` · competência ${d.sugestao.competencia.slice(5, 7)}/${d.sugestao.competencia.slice(0, 4)}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
