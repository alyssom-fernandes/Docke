/**
 * Painel "Informações" da prévia (achados A5-36 e B2.4.9 da avaliação de
 * 25/11/2026): detalhes, versões e atividade do documento ao lado do arquivo,
 * sem fechar a prévia nem perder a página em que se estava. Mesmo encaixe do
 * painel de comentários (lateral de 320 px; tela cheia no celular).
 */
import { useEffect, useState } from "react";
import { Info, X } from "lucide-react";
import { Link } from "react-router-dom";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { relativeDate, fullDate } from "@/lib/date";
import type { Document } from "./docShared";
import VersionsPanel from "./VersionsPanel";

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

const OCR: Record<Document["ocr_status"], string> = {
  pending: "na fila para leitura do texto",
  processing: "lendo o texto",
  done: "texto lido (busca no conteúdo)",
  failed: "não foi possível ler o texto",
  skipped: "sem leitura de texto",
};

type InfoDoc = Pick<Document, "id" | "name" | "size_bytes"> & Partial<Pick<Document, "ocr_status" | "created_at" | "updated_at" | "uploaded_by_name">>;

export default function PreviewInfoPanel({ doc, onClose, onChanged }: { doc: InfoDoc; onClose: () => void; onChanged?: () => void }) {
  const { current } = useCompany();
  const [act, setAct] = useState<{ total: number; last: string | null } | null>(null);

  useEffect(() => {
    let vivo = true;
    setAct(null);
    api.get(`/activity`, { params: { company_id: current?.id, item_id: doc.id, page_size: 1 } })
      .then((r) => { if (vivo) setAct({ total: r.data?.total ?? 0, last: r.data?.results?.[0]?.created_at ?? null }); })
      .catch(() => {});
    return () => { vivo = false; };
  }, [doc.id, current?.id]);

  const row = "flex justify-between gap-3 py-1.5 border-b border-(--border-default) last:border-0";
  const dt = "text-mac-caption text-(--text-secondary) shrink-0";
  const dd = "text-mac-caption text-(--text-primary) text-right min-w-0 break-words";

  return (
    <aside aria-label="Informações do documento" className="panel-in absolute top-0 right-0 bottom-0 z-10 w-full sm:w-[320px] flex flex-col border-l border-(--border-default) bg-(--bg-card) shadow-(--shadow-dropdown)">
      <div className="flex items-center gap-2 px-3 h-11 border-b border-(--border-default)">
        <Info className="w-4 h-4 text-(--text-accent)" aria-hidden />
        <h2 className="flex-1 text-mac-body font-semibold text-(--text-primary)">Informações</h2>
        <button type="button" onClick={onClose} aria-label="Fechar informações" className="h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 inline-flex items-center justify-center rounded-full hover:bg-(--bg-hover)"><X className="w-4 h-4" aria-hidden /></button>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-4">
        <dl>
          <div className={row}><dt className={dt}>Nome</dt><dd className={dd}>{doc.name}</dd></div>
          <div className={row}><dt className={dt}>Tamanho</dt><dd className={dd}>{fmtSize(doc.size_bytes)}</dd></div>
          {doc.created_at && <div className={row}><dt className={dt}>Enviado</dt><dd className={dd} title={fullDate(doc.created_at)}>{relativeDate(doc.created_at)}{doc.uploaded_by_name ? ` por ${doc.uploaded_by_name}` : ""}</dd></div>}
          {doc.updated_at && doc.updated_at !== doc.created_at && <div className={row}><dt className={dt}>Alterado</dt><dd className={dd} title={fullDate(doc.updated_at)}>{relativeDate(doc.updated_at)}</dd></div>}
          {doc.ocr_status && <div className={row}><dt className={dt}>Texto</dt><dd className={dd}>{OCR[doc.ocr_status] ?? doc.ocr_status}</dd></div>}
          <div className={row}>
            <dt className={dt}>Atividade</dt>
            <dd className={dd}>
              {act === null ? "…" : act.total === 0 ? "nenhum evento" : `${act.total} ${act.total === 1 ? "evento" : "eventos"}${act.last ? `, o último ${relativeDate(act.last)}` : ""}`}
              {" · "}
              <Link to={`/activity?item=${doc.id}&nome=${encodeURIComponent(doc.name)}`} className="text-(--text-accent) hover:underline underline-offset-2">ver tudo</Link>
            </dd>
          </div>
        </dl>
        <VersionsPanel documentId={doc.id} documentName={doc.name} onChanged={() => onChanged?.()} />
      </div>
    </aside>
  );
}
