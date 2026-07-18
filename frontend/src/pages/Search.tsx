import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { usePageTitle } from "@/hooks/usePageTitle";
import { relativeDate } from "@/lib/date";
import { getFileStyle } from "@/lib/fileType";
import { Search as SearchIcon, X } from "lucide-react";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import EmptyState from "@/components/shared/EmptyState";
import TruncatedFileName from "@/components/ui/TruncatedFileName";

interface SearchResult {
  id: string;
  name: string;
  snippet: string;
  rank: number;
  created_at: string;
  folder_id: string | null;
  folder_name?: string;
}

interface SearchResponse {
  results: SearchResult[];
  items?: SearchResult[];
  total: number;
  page: number;
  page_size: number;
}

const fmtDate = relativeDate;

// O snippet vem do ts_headline() do Postgres sobre o texto OCR do documento —
// texto controlado por quem faz upload, não pelo backend. ts_headline só
// insere os marcadores <mark>/</mark> literais; não escapa o resto do texto.
// Escapamos tudo via textContent (nunca interpretado como HTML) e só depois
// reconstituímos os marcadores de destaque já escapados de volta em <mark>
// reais — assim nenhum HTML/script arbitrário do OCR pode ser injetado.
function highlightSnippet(snippet: string): string {
  const span = document.createElement("span");
  span.textContent = snippet;
  return span.innerHTML
    .replace(/&lt;mark&gt;/g, '<mark class="bg-teal-100 text-teal-700 dark:bg-teal-500/25 dark:text-teal-300 rounded px-0.5">')
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

export default function Search() {
  usePageTitle("Busca");
  const { current } = useCompany();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const doSearch = useCallback(
    (q: string) => {
      if (!q.trim() || !current) return;
      setLoading(true);
      setSearched(true);
      api
        .get<SearchResponse>("/search", { params: { q: q.trim(), company_id: current.id } })
        .then((r) => { setResults(r.data.results ?? r.data.items ?? []); setTotal(r.data.total); })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [current?.id]
  );

  useEffect(() => {
    const q = params.get("q");
    if (q) { setQuery(q); doSearch(q); }
  }, [doSearch]);

  // Busca ao vivo enquanto digita, com debounce — a HIG recomenda começar a
  // busca assim que possível em vez de exigir Enter/clique ("If possible,
  // start search immediately when a person types"). skipNext evita disparar
  // de novo no primeiro render (a query inicial já é buscada pelo efeito
  // acima, a partir da URL).
  const skipNext = useRef(true);
  useEffect(() => {
    if (skipNext.current) { skipNext.current = false; return; }
    if (!query.trim()) {
      setSearched(false);
      setResults([]);
      setTotal(0);
      setParams({}, { replace: true });
      return;
    }
    const handle = setTimeout(() => {
      setParams({ q: query.trim() }, { replace: true });
      doSearch(query);
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setParams({ q: query.trim() });
    doSearch(query);
  }

  function clearQuery() {
    setQuery("");
    setSearched(false);
    setResults([]);
    setTotal(0);
    setParams({}, { replace: true });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-mac-title2 font-semibold text-[var(--text-primary)]">Busca avançada</h1>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-placeholder)] pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Digite para buscar documentos por conteúdo ou nome…"
            className="w-full h-10 pl-10 pr-9 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-full text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
          />
          {/* Botão de limpar customizado — type="text" em vez de "search" pra
              não depender do X nativo do navegador (inconsistente entre
              Chrome/Edge/Firefox e sem estilo do app); a HIG exige que todo
              search field mostre Search icon + Clear button. */}
          {query && (
            <button
              type="button"
              onClick={clearQuery}
              aria-label="Limpar busca"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors duration-fast"
            >
              <X className="w-3 h-3" strokeWidth={2.5} />
            </button>
          )}
        </div>
        <button
          type="submit"
          className="h-10 px-5 bg-teal-600 text-white text-mac-body font-medium rounded-full hover:bg-teal-500 transition-colors duration-fast"
        >
          Buscar
        </button>
      </form>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
          ))}
        </div>
      ) : searched && results.length === 0 ? (
        <EmptyState
          title="Nenhum resultado"
          description={`Nenhum documento encontrado para "${query}".`}
          icon={<SearchIcon className="w-6 h-6" />}
        />
      ) : results.length > 0 ? (
        <>
          <p className="text-mac-body text-[var(--text-secondary)]">{total} resultado{total !== 1 ? "s" : ""} para "{params.get("q")}"</p>
          {/* Lista agrupada num único cartão com divisores — mesma convenção
              usada em Atividade/Lixeira/Compartilhados, em vez de um cartão
              flutuante por item (que destoava do resto do app no mobile). */}
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
            <ul>
              {results.map((r) => (
                <li
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/documents?folder_id=${r.folder_id ?? ""}&doc=${r.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/documents?folder_id=${r.folder_id ?? ""}&doc=${r.id}`);
                    }
                  }}
                  className="flex items-start gap-3 px-5 py-3.5 hover:bg-[var(--bg-hover)] transition-colors duration-fast cursor-pointer border-b border-[var(--border-default)] last:border-0"
                >
                  {(() => { const s = getFileStyle(r.name); const Icon = s.icon; return (
                    <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-3.5 h-3.5 ${s.iconColor} ${s.fillColor}`} />
                    </div>
                  ); })()}
                  <div className="flex-1 min-w-0">
                    <TruncatedFileName name={r.name} className="text-mac-body font-medium text-[var(--text-primary)]" />
                    {r.snippet && (
                      <p
                        className="text-mac-caption text-[var(--text-secondary)] mt-1 line-clamp-2"
                        dangerouslySetInnerHTML={{ __html: highlightSnippet(r.snippet) }}
                      />
                    )}
                    <p className="text-mac-caption text-[var(--text-tertiary)] mt-1">
                      {r.folder_name && <>{r.folder_name} · </>}
                      {fmtDate(r.created_at)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : !searched ? (
        <EmptyState
          title="Busque por documentos"
          description="Use palavras-chave do nome ou conteúdo OCR dos documentos."
          icon={<SearchIcon className="w-6 h-6" />}
        />
      ) : null}
    </div>
  );
}
