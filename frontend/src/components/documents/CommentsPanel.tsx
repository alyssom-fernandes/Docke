import { useState, type FormEvent } from "react";
import { MapPin, Check, Trash2, X, MessageSquare } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import Button from "@/components/ui/Button";

/*
 * Comentários e anotações do documento (B2.4.6, B2.4.9): painel ao lado do
 * visualizador, sem sair da página em que se está. Anotação = comentário
 * preso a um ponto da página (camada separada; o arquivo não muda).
 */

export interface Comentario {
  id: string; body: string; page: number | null; x: number | null; y: number | null; created_at: string;
  resolved_at: string | null; author: string; mine: boolean; version_number: number | null;
}

export default function CommentsPanel({ docId, comentarios, setComentarios, ponto, setPonto, annotating, setAnnotating, ativo, onGoTo, onClose, podeAnotar }: {
  docId: string;
  comentarios: Comentario[];
  setComentarios: (f: (c: Comentario[]) => Comentario[]) => void;
  ponto: { page: number; x: number; y: number } | null;
  setPonto: (p: { page: number; x: number; y: number } | null) => void;
  annotating: boolean;
  setAnnotating: (v: boolean) => void;
  ativo: string | null;
  onGoTo: (page: number, id: string) => void;
  onClose: () => void;
  podeAnotar: boolean;
}) {
  const { error: showError } = useToast();
  const [texto, setTexto] = useState("");
  const [busy, setBusy] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    if (!texto.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<Comentario>(`/documents/${docId}/comments`, { body: texto.trim(), ...(ponto ?? {}) });
      setComentarios((c) => [...c, r.data]);
      setTexto(""); setPonto(null); setAnnotating(false);
    } catch (err: any) {
      showError(typeof err?.response?.data?.detail === "string" ? err.response.data.detail : "Não foi possível comentar.");
    } finally { setBusy(false); }
  }
  async function resolver(c: Comentario) {
    try {
      await api.patch(`/comments/${c.id}`, { resolved: !c.resolved_at });
      setComentarios((cs) => cs.map((x) => (x.id === c.id ? { ...x, resolved_at: x.resolved_at ? null : new Date().toISOString() } : x)));
    } catch { showError("Não foi possível marcar."); }
  }
  async function apagar(c: Comentario) {
    try {
      await api.delete(`/comments/${c.id}`);
      setComentarios((cs) => cs.filter((x) => x.id !== c.id));
    } catch (err: any) { showError(typeof err?.response?.data?.detail === "string" ? err.response.data.detail : "Não foi possível apagar."); }
  }

  return (
    <aside aria-label="Comentários e anotações" className="absolute top-0 right-0 bottom-0 z-10 w-full sm:w-[320px] flex flex-col border-l border-(--border-default) bg-(--bg-card) shadow-(--shadow-dropdown)">
      <div className="flex items-center gap-2 px-3 h-11 border-b border-(--border-default)">
        <MessageSquare className="w-4 h-4 text-(--text-accent)" aria-hidden />
        <h2 className="flex-1 text-mac-body font-semibold text-(--text-primary)">Comentários <span className="font-normal text-(--text-tertiary)">· {comentarios.length}</span></h2>
        <button type="button" onClick={onClose} aria-label="Fechar comentários" className="h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full hover:bg-(--bg-hover)"><X className="w-4 h-4" aria-hidden /></button>
      </div>
      <ol className="flex-1 overflow-auto p-3 space-y-2">
        {comentarios.length === 0 && <li className="text-mac-caption text-(--text-tertiary)">Sem comentários. Escreva abaixo{podeAnotar ? " ou use “Marcar na página” para prender a nota num ponto do documento" : ""}.</li>}
        {comentarios.map((c) => (
          <li key={c.id} className={`rounded-(--radius-control) border p-2.5 ${ativo === c.id ? "border-amber-500 bg-(--tint-warning)" : "border-(--border-default)"} ${c.resolved_at ? "opacity-60" : ""}`}>
            <div className="flex items-center gap-1.5 text-mac-caption text-(--text-secondary)">
              <span className="font-medium text-(--text-primary) truncate">{c.author}</span>
              <span>· {new Date(c.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
              {c.version_number && <span>· v{c.version_number}</span>}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-mac-body text-(--text-primary)">{c.body}</p>
            <div className="mt-1.5 flex items-center gap-1">
              {c.page && (
                <button type="button" onClick={() => onGoTo(c.page!, c.id)} className="inline-flex items-center gap-1 rounded-full px-2 min-h-7 text-mac-caption text-(--text-accent) hover:bg-(--bg-hover)">
                  {c.x !== null && <MapPin className="w-3 h-3" aria-hidden />}Página {c.page}
                </button>
              )}
              <span className="flex-1" />
              <button type="button" onClick={() => resolver(c)} aria-pressed={!!c.resolved_at} title={c.resolved_at ? "Reabrir" : "Marcar como resolvido"} aria-label={c.resolved_at ? "Reabrir" : "Marcar como resolvido"}
                className="h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><Check className="w-3.5 h-3.5" aria-hidden /></button>
              {c.mine && <button type="button" onClick={() => apagar(c)} aria-label="Apagar comentário" title="Apagar"
                className="h-7 w-7 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><Trash2 className="w-3.5 h-3.5" aria-hidden /></button>}
            </div>
          </li>
        ))}
      </ol>
      <form onSubmit={enviar} className="border-t border-(--border-default) p-3 space-y-2">
        {podeAnotar && (
          <div className="flex items-center gap-2 text-mac-caption">
            <button type="button" onClick={() => { setAnnotating(!annotating); setPonto(null); }} aria-pressed={annotating}
              className={`inline-flex items-center gap-1 rounded-full px-2.5 min-h-7 pointer-coarse:min-h-11 border ${annotating || ponto ? "border-teal-600 bg-(--tint-accent) text-(--text-primary)" : "border-(--border-control) text-(--text-secondary) hover:bg-(--bg-hover)"}`}>
              <MapPin className="w-3.5 h-3.5" aria-hidden />{ponto ? `Na página ${ponto.page}` : annotating ? "Clique na página…" : "Marcar na página"}
            </button>
            {ponto && <button type="button" onClick={() => setPonto(null)} className="text-(--text-secondary) hover:underline">tirar o ponto</button>}
          </div>
        )}
        <label htmlFor="coment-texto" className="sr-only">Comentário</label>
        <textarea id="coment-texto" rows={2} maxLength={2000} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={ponto ? "Nota para este ponto da página" : "Escreva um comentário"}
          className="w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 py-2 text-mac-body text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
        <Button type="submit" size="sm" loading={busy} disabled={!texto.trim()}>{ponto ? "Anotar" : "Comentar"}</Button>
      </form>
    </aside>
  );
}
