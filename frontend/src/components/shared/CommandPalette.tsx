import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, FolderOpen, Anchor } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useCommandPalette } from "@/hooks/useCommandPalette";

interface QuickResult {
  id: string;
  name: string;
  type: "document" | "folder";
  folder_id?: string | null;
}

export default function CommandPalette() {
  const { isOpen, close } = useCommandPalette();
  const { current } = useCompany();
  const navigate = useNavigate();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickResult[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useFocusTrap(containerRef, isOpen);

  // Reset on open
  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setResults([]);
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [isOpen]);

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
    <div
      className="fixed inset-0 bg-black/40 flex items-start justify-center pt-[15vh] z-50 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div ref={containerRef} className="modal-card bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] shadow-modal w-full max-w-[560px] overflow-hidden">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-default)]">
          <Search className="w-4 h-4 text-[var(--text-placeholder)] flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Buscar documentos, pastas ou ações…"
            className="flex-1 text-mac-body bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-mac-caption bg-[var(--bg-hover)] text-[var(--text-tertiary)] rounded border border-[var(--border-default)]">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-[360px] overflow-y-auto">
          {loading && (
            <div className="py-3 px-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 bg-[var(--bg-hover)] rounded animate-pulse" />
              ))}
            </div>
          )}

          {!loading && query.trim() && results.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Anchor className="w-7 h-7 text-[var(--text-placeholder)] mb-2" />
              <p className="text-mac-body text-[var(--text-secondary)]">Nenhum resultado para "{query}"</p>
            </div>
          )}

          {!loading && !query.trim() && (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Search className="w-7 h-7 text-[var(--text-placeholder)] mb-2" />
              <p className="text-mac-body text-[var(--text-secondary)]">Digite para buscar</p>
              <p className="text-mac-caption text-[var(--text-tertiary)] mt-1">Documentos, pastas e ações do sistema</p>
            </div>
          )}

          {!loading && results.length > 0 && (
            <ul>
              {results.map((r, i) => (
                <li key={r.id}>
                  <button
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors duration-fast ${
                      i === activeIdx
                        ? "bg-teal-500/10 text-teal-500"
                        : "text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
                    }`}
                    onClick={() => select(r)}
                    onMouseEnter={() => setActiveIdx(i)}
                  >
                    {r.type === "folder" ? (
                      <FolderOpen className="w-4 h-4 flex-shrink-0 text-teal-500" />
                    ) : (
                      (() => { const s = getFileStyle(r.name); const Icon = s.icon; return (
                        <div className={`w-5 h-5 rounded-[3px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                          <Icon className={`w-3 h-3 ${s.iconColor}`} />
                        </div>
                      ); })()
                    )}
                    <span className="flex-1 text-mac-body truncate">{r.name}</span>
                    <span className="text-mac-caption text-[var(--text-tertiary)] flex-shrink-0">
                      {r.type === "folder" ? "Pasta" : "Documento"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* Full search shortcut */}
          {!loading && query.trim() && (
            <div className="border-t border-[var(--border-default)] px-4 py-2">
              <button
                onClick={() => { close(); navigate(`/search?q=${encodeURIComponent(query.trim())}`); }}
                className="w-full flex items-center gap-2 text-mac-caption text-[var(--text-secondary)] hover:text-teal-500 transition-colors duration-fast py-1"
              >
                <Search className="w-3.5 h-3.5" />
                Busca avançada por "{query}"
                <kbd className="ml-auto px-1 py-0.5 text-mac-caption bg-[var(--bg-hover)] rounded border border-[var(--border-default)]">↵</kbd>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
