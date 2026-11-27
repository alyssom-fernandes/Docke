import { useEffect, useRef, useState, type ReactNode } from "react";
import { Folder, PanelRight } from "lucide-react";
import api from "@/lib/api";
import { getFileStyle } from "@/lib/fileType";
import { fmtSize } from "@/components/documents/docShared";

/**
 * Painel de detalhe das listas largas (A6-T3): em telas a partir de 1400 px,
 * busca, ancorados, links, atividade e lixeira ganham uma coluna à direita com
 * o item em foco ou sob o ponteiro, como a prévia do Spotlight. O clique na
 * linha continua fazendo o que fazia; abaixo dessa largura nada muda.
 */

const LARGO = "(min-width: 1400px)";

export function useLargo(): boolean {
  const [largo, setLargo] = useState(() => typeof window !== "undefined" && window.matchMedia(LARGO).matches);
  useEffect(() => {
    const mq = window.matchMedia(LARGO);
    const on = () => setLargo(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return largo;
}

export interface InspectorItem {
  kind: "document" | "folder" | "other";
  id: string;
  name: string;
  /** Linhas próprias da tela (ex.: quando expira o link, quem excluiu). */
  extra?: [string, ReactNode][];
  /** Ícone/visual para itens que não são documento nem pasta (ex.: evento da trilha). */
  icon?: ReactNode;
}

/** Item em foco: o ponteiro só troca depois de uma pausa curta, para o painel não piscar. */
export function useInspectorTarget() {
  const [item, setItem] = useState<InspectorItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  function bind(it: InspectorItem) {
    return {
      onMouseEnter: () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => setItem(it), 120); },
      onFocus: () => { if (timer.current) clearTimeout(timer.current); setItem(it); },
    };
  }
  return { item, setItem, bind };
}

type DocDetalhe = {
  file_type?: string | null; size_bytes?: number | null; created_at?: string; uploaded_by_name?: string | null;
  competencia?: string | null; tipo_fiscal?: string | null; ocr_status?: string | null; thumb_url?: string | null; ocr_excerpt?: string;
};
const cacheDoc = new Map<string, DocDetalhe | null>();
const cachePasta = new Map<string, { subfolders: number; documents: number } | null>();

const dataBr = (iso?: string | null) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("pt-BR") : null);
const LIDO: Record<string, string> = { done: "Lido", pending: "Na fila", processing: "Lendo", failed: "Não foi possível ler", skipped: "Não se aplica" };

function Linhas({ rows }: { rows: [string, ReactNode][] }) {
  const vis = rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!vis.length) return null;
  return (
    <dl className="divide-y divide-(--border-default) text-mac-caption">
      {vis.map(([k, v], i) => (
        <div key={`${k}-${i}`} className="flex justify-between gap-3 py-1.5">
          <dt className="text-(--text-secondary) shrink-0">{k}</dt>
          <dd className="text-(--text-primary) text-right min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Corpo({ item }: { item: InspectorItem }) {
  const [doc, setDoc] = useState<DocDetalhe | null | undefined>(item.kind === "document" ? cacheDoc.get(item.id) : undefined);
  const [pasta, setPasta] = useState(item.kind === "folder" ? cachePasta.get(item.id) : undefined);
  useEffect(() => {
    let vivo = true;
    if (item.kind === "document" && !cacheDoc.has(item.id)) {
      api.get<DocDetalhe>(`/documents/${item.id}`).then((r) => { cacheDoc.set(item.id, r.data); if (vivo) setDoc(r.data); })
        .catch(() => { cacheDoc.set(item.id, null); if (vivo) setDoc(null); });
    }
    if (item.kind === "folder" && !cachePasta.has(item.id)) {
      api.get(`/folders/${item.id}/summary`).then((r) => { cachePasta.set(item.id, r.data); if (vivo) setPasta(r.data); })
        .catch(() => { cachePasta.set(item.id, null); if (vivo) setPasta(null); });
    }
    return () => { vivo = false; };
  }, [item.kind, item.id]);

  const estilo = getFileStyle(item.name);
  const Icone = estilo.icon;
  const visual = item.icon ?? (item.kind === "folder"
    ? <Folder className="w-16 h-16 text-(--text-accent)" aria-hidden="true" />
    : doc?.thumb_url
      ? <img src={doc.thumb_url} alt="" className="max-h-44 max-w-full rounded-(--radius-hair) bg-white object-contain shadow-(--shadow-thumb)" />
      : <Icone className="w-16 h-16" aria-hidden="true" />);
  const carregando = (item.kind === "document" && doc === undefined) || (item.kind === "folder" && pasta === undefined);
  const rows: [string, ReactNode][] = item.kind === "document" && doc ? [
    ["Tipo", doc.file_type?.toUpperCase()],
    ["Tamanho", doc.size_bytes ? fmtSize(doc.size_bytes) : null],
    ["Enviado em", dataBr(doc.created_at)],
    ["Por", doc.uploaded_by_name],
    ["Tipo fiscal", doc.tipo_fiscal],
    ["Competência", doc.competencia ? new Date(`${doc.competencia.slice(0, 10)}T12:00:00`).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }) : null],
    ["Texto", doc.ocr_status ? LIDO[doc.ocr_status] ?? doc.ocr_status : null],
  ] : item.kind === "folder" && pasta ? [
    ["Subpastas", String(pasta.subfolders)],
    ["Documentos", String(pasta.documents)],
  ] : [];
  return (
    <div key={item.id} className="reveal space-y-4">
      <div className="flex min-h-48 items-center justify-center rounded-(--radius-control) bg-(--bg-hover)/60 p-4">{visual}</div>
      <p className="text-mac-callout font-semibold text-(--text-primary) break-words">{item.name}</p>
      {carregando ? <div className="h-24 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" aria-label="Carregando" /> : <Linhas rows={[...rows, ...(item.extra ?? [])]} />}
      {doc?.ocr_excerpt && (
        <p className="text-mac-caption text-(--text-secondary) line-clamp-6 whitespace-pre-line">{doc.ocr_excerpt}</p>
      )}
    </div>
  );
}

/** Lista + coluna de detalhe à direita (só em tela larga). */
export function InspectorLayout({ item, children, vazio = "Passe o ponteiro ou use as setas numa linha para ver os detalhes aqui." }: {
  item: InspectorItem | null; children: ReactNode; vazio?: ReactNode;
}) {
  const largo = useLargo();
  if (!largo) return <>{children}</>;
  return (
    <div className="flex items-start gap-6">
      <div className="flex-1 min-w-0">{children}</div>
      <aside aria-label="Detalhes" aria-live="polite" className="w-80 shrink-0 sticky top-4 rounded-(--radius-card) border border-(--border-default) bg-(--bg-card) p-4 shadow-(--shadow-hairline)">
        {item ? <Corpo item={item} /> : (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-mac-caption text-(--text-secondary)">
            <PanelRight className="w-8 h-8 opacity-50" aria-hidden="true" />
            <p className="max-w-56">{vazio}</p>
          </div>
        )}
      </aside>
    </div>
  );
}
