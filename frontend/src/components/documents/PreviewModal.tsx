import { useEffect, useRef, useState } from "react";
import { X, Download, AlertCircle, Loader2 } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { getFileStyle } from "@/lib/fileType";
import api from "@/lib/api";

interface Doc {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
}

interface PreviewModalProps {
  doc: Doc;
  onClose: () => void;
}

type PreviewType = "pdf" | "image" | "text" | "unsupported";

function resolveType(name: string, mime: string): PreviewType {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext)) return "image";
  if (mime.startsWith("text/") || ["txt", "csv", "xml"].includes(ext)) return "text";
  return "unsupported";
}

export default function PreviewModal({ doc, onClose }: PreviewModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  const [url, setUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const type = resolveType(doc.name, doc.mime_type);
  const { icon: Icon, iconColor, bgColor } = getFileStyle(doc.name);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    if (type === "unsupported") { setLoading(false); return; }

    api.get<{ download_url: string }>(`/documents/${doc.id}/download-url`)
      .then(async ({ data }) => {
        if (type === "text") {
          const resp = await fetch(data.download_url);
          if (!resp.ok) throw new Error("Erro ao carregar arquivo.");
          const txt = await resp.text();
          setTextContent(txt.slice(0, 50_000)); // cap at 50k chars
        } else {
          setUrl(data.download_url);
        }
      })
      .catch((e) => setError(e?.message ?? "Erro ao carregar preview."))
      .finally(() => setLoading(false));
  }, [doc.id, type]);

  async function download() {
    try {
      const r = await api.get<{ download_url: string }>(`/documents/${doc.id}/download-url`);
      const a = document.createElement("a");
      a.href = r.data.download_url;
      a.download = doc.name;
      a.click();
    } catch {
      // silent — user can retry
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={containerRef}
        className="modal-card bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] shadow-modal flex flex-col w-full max-w-4xl"
        style={{ height: "min(90vh, 760px)" }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border-default)] flex-shrink-0">
          <div className={`w-8 h-8 rounded-[6px] flex items-center justify-center flex-shrink-0 ${bgColor}`}>
            <Icon className={`w-4 h-4 ${iconColor}`} />
          </div>
          <span
            className="flex-1 text-sm font-medium text-[var(--text-primary)] truncate"
            title={doc.name}
          >
            {doc.name}
          </span>
          <button
            onClick={download}
            className="flex items-center gap-1.5 h-8 px-3 text-xs border border-[var(--border-default)] rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
            aria-label="Baixar arquivo"
          >
            <Download className="w-3.5 h-3.5" />
            Baixar
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
            aria-label="Fechar preview"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-hidden relative">
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-[var(--text-placeholder)] animate-spin" />
            </div>
          )}

          {!loading && error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
              <AlertCircle className="w-10 h-10 text-[var(--text-placeholder)]" />
              <p className="text-sm text-[var(--text-secondary)]">{error}</p>
            </div>
          )}

          {!loading && !error && type === "unsupported" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
              <div className={`w-14 h-14 rounded-[12px] flex items-center justify-center ${bgColor}`}>
                <Icon className={`w-7 h-7 ${iconColor}`} />
              </div>
              <p className="text-sm text-[var(--text-secondary)]">
                Nenhuma visualização disponível para este tipo de arquivo.
              </p>
              <button
                onClick={download}
                className="flex items-center gap-1.5 h-9 px-4 text-sm bg-teal-600 text-white rounded-[8px] hover:bg-teal-500 transition-colors duration-fast"
              >
                <Download className="w-4 h-4" />
                Fazer download para abrir
              </button>
            </div>
          )}

          {!loading && !error && type === "pdf" && url && (
            <iframe
              src={url}
              className="w-full h-full border-0"
              title={doc.name}
            />
          )}

          {!loading && !error && type === "image" && url && (
            <div className="w-full h-full flex items-center justify-center bg-[var(--bg-page)] overflow-auto p-4">
              <img
                src={url}
                alt={doc.name}
                className="max-w-full max-h-full object-contain rounded-[4px]"
              />
            </div>
          )}

          {!loading && !error && type === "text" && textContent !== null && (
            <pre className="w-full h-full overflow-auto p-5 text-xs font-mono text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words">
              {textContent}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
