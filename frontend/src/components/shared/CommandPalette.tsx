import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, FolderOpen, Anchor } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { relativeDate } from "@/lib/date";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import Portal from "@/components/ui/Portal";

interface QuickResult {
  id: string;
  name: string;
  type: "document" | "folder";
  folder_id?: string | null;
}

interface DocumentPreview {
  id: string;
  name: string;
  file_type: string;
  size_bytes: number;
  sector: string | null;
  competencia: string | null;
  tipo_fiscal: string | null;
  ocr_text: string | null;
  created_at: string;
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CommandPalette() {
  const { isOpen, close } = useCommandPalette();
  const { current } = useCompany();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickResult[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previewCache = useRef<Map<string, DocumentPreview>>(new Map());

  useFocusTrap(containerRef, isOpen);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setResults([]);
      setActiveIdx(0);
      setPreview(null);
      previewCache.current.clear();
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Fase 7.4: preview lateral — busca os detalhes do documento em foco
  // (setinha/hover), com debounce e cache pra não disparar uma request por
  // tecla enquanto o usuário navega rápido pela lista.
  useEffect(() => {
    const active = results[activeIdx];
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    if (!active || active.type !== "document") { setPreview(null); return; }
    const cached = previewCache.current.get(active.id);
    if (cached) { setPreview(cached); return; }
    setPreviewLoading(true);
    previewDebounceRef.current = setTimeout(() => {
      api
        .get<DocumentPreview>(`/documents/${active.id}`)
        .then((r) => {
          previewCache.current.set(active.id, r.data);
          setPreview(r.data);
        })
        .catch(() => setPreview(null))
        .finally(() => setPreviewLoading(false));
    }, 150);
    return () => { if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, results]);

  const search = useCallback(
    (q: string) => {
      if (!q.trim() || !current) { setResults([]); return; }
      setLoading(true);
      api
        .get<QuickResult[]>("/search/quick", { params: { q: q.trim(), company_id: current.id } })
        .then((r) => { setResults(Array.isArray(r.data) ? r.data : []); setActiveIdx(0); })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    },
    [current?.id]
  );

  function handleChange(v: string) {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(v), 200);
  }

  function select(r: QuickResult) {
    close();
    if (r.type === "folder") {
      navigate(`/documents?folder_id=${r.id}`);
    } else {
      navigate(`/documents?folder_id=${r.folder_id ?? ""}&doc=${r.id}`);
    }
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[activeIdx]) select(results[activeIdx]);
      else if (query.trim()) { close(); navigate(`/search?q=${encodeURIComponent(query.trim())}`); }
    } else if (e.key === "Escape") {
      close();
    }
  }

  if (!isOpen) return null;

  return (
    <Portal>
    <div
      className="fixed inset-0 bg-(--overlay-scrim) flex items-start justify-center pt-[15vh] z-50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        ref={containerRef}
        className={`modal-card glass-dialog glass-blur-strong rounded-[20px] shadow-modal w-full overflow-hidden flex flex-col transition-[max-width] duration-normal ${
          preview ? "max-w-[860px]" : "max-w-[560px]"
        }`}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-(--border-default)">
          <Search className="w-4 h-4 text-(--text-placeholder) shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Buscar documentos, pastas ou ações…"
            className="flex-1 text-mac-body bg-transparent text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden"
          />
        </div>

        <div className="flex min-h-0">
        {/* Results */}
        <div className="max-h-[360px] overflow-y-auto flex-1 min-w-0">
          {loading && (
            <div className="py-3 px-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 bg-(--bg-hover) rounded animate-pulse" />
              ))}
            </div>
          )}

          {!loading && query.trim() && results.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Anchor className="w-7 h-7 text-(--text-placeholder) mb-2" />
              <p className="text-mac-body text-(--text-secondary)">Nenhum resultado para "{query}"</p>
            </div>
          )}

          {!loading && !query.trim() && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Search className="w-7 h-7 text-(--text-placeholder) mb-2" />
              <p className="text-mac-body text-(--text-secondary)">Digite para buscar</p>
              <p className="text-mac-caption text-(--text-tertiary) mt-1">Documentos, pastas e ações do sistema</p>
            </div>
          )}

          {!loading && results.length > 0 && (
            <ul>
              {results.map((r, i) => (
                <li key={r.id}>
                  <button
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-fast ${
                      i === activeIdx
                        ? "bg-teal-500 text-white"
                        : "text-(--text-primary) hover:bg-(--bg-hover)"
                    }`}
                    onClick={() => select(r)}
                    onMouseEnter={() => setActiveIdx(i)}
                  >
                    {r.type === "folder" ? (
                      <FolderOpen className={`w-4 h-4 shrink-0 ${i === activeIdx ? "text-white" : "text-teal-500"}`} />
                    ) : (
                      (() => { const s = getFileStyle(r.name); const Icon = s.icon; return (
                        <div className={`w-5 h-5 rounded-[3px] flex items-center justify-center shrink-0 ${i === activeIdx ? "" : s.bgColor}`}>
                          <Icon className={`w-3 h-3 ${i === activeIdx ? "text-white fill-white/25" : `${s.iconColor} ${s.fillColor}`}`} />
                        </div>
                      ); })()
                    )}
                    <span className="flex-1 text-mac-body truncate">{r.name}</span>
                    <span className={`text-mac-caption shrink-0 ${i === activeIdx ? "text-white/80" : "text-(--text-tertiary)"}`}>
                      {r.type === "folder" ? "Pasta" : "Documento"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Full search shortcut */}
          {!loading && query.trim() && (
            <div className="border-t border-(--border-default) px-4 py-2">
              <button
                onClick={() => { close(); navigate(`/search?q=${encodeURIComponent(query.trim())}`); }}
                className="w-full flex items-center gap-2 text-mac-caption text-(--text-secondary) hover:text-teal-500 transition-colors duration-fast py-1"
              >
                <Search className="w-3.5 h-3.5" />
                Busca avançada por "{query}"
                <kbd className="ml-auto px-1 py-0.5 text-mac-caption bg-(--bg-hover) rounded border border-(--border-default)">↵</kbd>
              </button>
            </div>
          )}
        </div>
        </div>

        {/* Fase 7.4: preview lateral — mostra contexto do documento em foco
            sem sair da paleta (setor, competência, tipo fiscal, tamanho e um
            trecho do texto OCR). Só aparece quando há um documento em foco. */}
        {preview && (
          <div className="w-[300px] shrink-0 border-l border-(--border-default) px-4 py-3 max-h-[360px] overflow-y-auto">
            {previewLoading ? (
              <div className="space-y-2">
                <div className="h-4 w-2/3 bg-(--bg-hover) rounded animate-pulse" />
                <div className="h-3 w-1/2 bg-(--bg-hover) rounded animate-pulse" />
                <div className="h-16 bg-(--bg-hover) rounded animate-pulse" />
              </div>
            ) : (
              <>
                <p className="text-mac-body font-medium text-(--text-primary) wrap-break-word">{preview.name}</p>
                <dl className="mt-2 space-y-1 text-mac-caption text-(--text-secondary)">
                  {preview.sector && (
                    <div className="flex justify-between gap-2"><dt className="text-(--text-tertiary)">Setor</dt><dd>{preview.sector}</dd></div>
                  )}
                  {preview.tipo_fiscal && (
                    <div className="flex justify-between gap-2"><dt className="text-(--text-tertiary)">Tipo fiscal</dt><dd>{preview.tipo_fiscal}</dd></div>
                  )}
                  {preview.competencia && (
                    <div className="flex justify-between gap-2"><dt className="text-(--text-tertiary)">Competência</dt><dd>{preview.competencia}</dd></div>
                  )}
                  <div className="flex justify-between gap-2"><dt className="text-(--text-tertiary)">Tamanho</dt><dd>{fmtSize(preview.size_bytes)}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-(--text-tertiary)">Enviado</dt><dd>{relativeDate(preview.created_at)}</dd></div>
                </dl>
                {preview.ocr_text && (
                  <p className="mt-3 text-mac-caption text-(--text-secondary) line-clamp-6">
                    {preview.ocr_text.slice(0, 400)}
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
    </Portal>
  );
}
