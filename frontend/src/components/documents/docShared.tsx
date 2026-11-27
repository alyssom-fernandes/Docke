import { useState, type ElementType } from "react";
import { relativeDate, fullDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import { Clock, Loader2, CheckCircle2, AlertCircle, MinusCircle } from "lucide-react";
import Badge from "@/components/ui/Badge";
import Tooltip from "@/components/ui/Tooltip";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DocFolder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface Document {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  ocr_status: "pending" | "processing" | "done" | "failed" | "skipped";
  created_at: string;
  updated_at?: string;
  uploaded_by_name?: string | null;
  folder_id: string | null;
  favorited?: boolean;
  active_share_count?: number;
  /** Miniatura da grade (A4-20): URL assinada, quando já foi gerada. */
  thumb_url?: string | null;
  /** Documento-modelo (B1.5.6): aparece em "Novo a partir de modelo". */
  is_template?: boolean;
}

// Metadados personalizados (ADENDO-08) — campo resolvido pra pasta atual
// (já com herança/override aplicados pelo backend) e valor preenchido por documento.
export type CustomFieldType = "texto" | "cpf" | "cnpj" | "data" | "competencia" | "numero" | "selecao" | "moeda" | "email" | "telefone" | "cep" | "booleano"
  | "texto_longo" | "data_hora" | "multipla" | "url";

export interface ResolvedField {
  custom_field_id: string;
  required: boolean;
  display_order: number;
  column_width: number | null;
  default_value: string | null;
  condition_field_id: string | null;
  condition_value: string | null;
  label: string;
  field_key: string;
  type: CustomFieldType;
  format_config: Record<string, unknown>;
}

export interface DocFieldValueRow {
  document_id: string;
  custom_field_id: string;
  value_text: string;
  value_date: string | null;
  value_number: number | null;
}

export type Item = { kind: "folder"; data: DocFolder } | { kind: "document"; data: Document };

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

export const fmtDate = relativeDate;
export const fmtDateFull = fullDate;

// Caracteres proibidos em nomes de arquivo/pasta (compatibilidade Windows/macOS)
export const FORBIDDEN_NAME_CHARS = /[\\/:*?"<>|]/;

export const ALLOWED_EXT = ["pdf", "xlsx", "xls", "csv", "docx", "doc", "xml", "jpg", "jpeg", "png", "gif", "txt"];
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const plural = (n: number, um: string, varios: string) => `${n.toLocaleString("pt-BR")} ${n === 1 ? um : varios}`;


/** Envia o arquivo direto ao armazenamento com progresso (fetch não informa). */
export function putWithProgress(url: string, body: Blob, contentType: string | null, onProgress: (pct: number) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    // Cancelar pela Central de tarefas (A2-26): -1 = cancelado por quem enviou.
    if (signal?.aborted) { resolve(-1); return; }
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.onabort = () => resolve(-1);
    xhr.open("PUT", url);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(Math.round((ev.loaded / ev.total) * 100)); };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => resolve(0);
    xhr.ontimeout = () => resolve(0);
    xhr.send(body);
  });
}

export const CANCELADO = "Envio cancelado. Dá para tentar de novo.";

// Separa nome-base e extensão pra manter a extensão fixa durante renomeação inline
export function splitExt(name: string): [string, string] {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return [name, ""];
  return [name.slice(0, idx), name.slice(idx)];
}

// Coluna "Tipo" (Kind) — todo Finder/Explorer mostra o tipo por extenso ao
// lado do nome; nós só tínhamos o ícone colorido, que sozinho não é óbvio
// pra quem não conhece o mapeamento de cores (ADENDO-09 §13).
// Rótulos curtos ("PDF", "Word") em vez de "Documento PDF"/"Documento Word" —
// o nome completo ocupava espaço desnecessário na coluna Tipo, sem agregar
// nada que o ícone colorido ao lado já não comunique.
export const KIND_LABELS: Record<string, string> = {
  pdf: "PDF",
  xlsx: "Excel",
  xls: "Excel",
  csv: "CSV",
  docx: "Word",
  doc: "Word",
  xml: "XML",
  jpg: "JPEG",
  jpeg: "JPEG",
  png: "PNG",
  gif: "GIF",
  txt: "Texto",
};
export function kindLabel(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return KIND_LABELS[ext] ?? (ext ? ext.toUpperCase() : "Documento");
}

export function ocrBadge(status: Document["ocr_status"]) {
  const map: Record<Document["ocr_status"], { label: string; variant: "default" | "teal" | "warning" | "error" | "success" }> = {
    pending: { label: "Aguardando OCR", variant: "default" },
    processing: { label: "Processando OCR", variant: "warning" },
    done: { label: "OCR concluído", variant: "success" },
    failed: { label: "OCR falhou", variant: "error" },
    skipped: { label: "OCR ignorado", variant: "default" },
  };
  const { label, variant } = map[status] ?? { label: status, variant: "default" };
  return <Badge variant={variant}>{label}</Badge>;
}

// Situação da leitura do texto (OCR), com rótulo que diz o que significa (A4-19).
export function OcrIcon({ status, inverted = false }: { status: Document["ocr_status"]; inverted?: boolean }) {
  const map: Record<Document["ocr_status"], { Icon: ElementType; className: string; label: string }> = {
    pending: { Icon: Clock, className: "text-(--text-tertiary)", label: "Na fila para ler o texto" },
    processing: { Icon: Loader2, className: "text-(--text-warning) animate-spin motion-reduce:animate-none", label: "Lendo o texto…" },
    done: { Icon: CheckCircle2, className: "text-(--text-success)", label: "Texto pronto: aparece na busca pelo conteúdo" },
    failed: { Icon: AlertCircle, className: "text-(--text-danger)", label: "Não foi possível ler o texto. Abra os detalhes para tentar de novo" },
    skipped: { Icon: MinusCircle, className: "text-(--text-tertiary)", label: "Sem texto para ler" },
  };
  const { Icon, className, label } = map[status] ?? map.pending;
  return (
    <Tooltip label={label}>
      <span role="img" aria-label={label} className="inline-flex">
        <Icon className={`w-4 h-4 ${inverted ? "text-white" : className}`} aria-hidden />
      </span>
    </Tooltip>
  );
}

// Miniatura na grade (A4-20): página 1 do PDF ou a imagem reduzida; sem
// miniatura (ainda gerando, ou formato sem prévia), o ícone do tipo.
export function GridThumb({ doc, selected }: { doc: Document; selected: boolean }) {
  const [falhou, setFalhou] = useState(false);
  const s = getFileStyle(doc.name);
  const Icon = s.icon;
  return (
    // Como no Finder: selecionado, o ícone ganha um fundo cinza arredondado.
    <div className={`h-[80px] flex items-end justify-center shrink-0 rounded-(--radius-control) px-1.5 pb-1 ${selected ? "bg-(--control-fill)" : ""}`} aria-hidden>
      {doc.thumb_url && !falhou ? (
        <img
          src={doc.thumb_url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFalhou(true)}
          className="max-h-[72px] max-w-[64px] rounded-(--radius-hair) bg-white object-contain shadow-(--shadow-thumb)"
        />
      ) : (
        <Icon className="w-16 h-16" />
      )}
    </div>
  );
}
