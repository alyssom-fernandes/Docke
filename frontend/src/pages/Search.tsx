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

interface FacetValue {
  value: string;
  count: number;
}

interface SearchResponse {
  results: SearchResult[];
  items?: SearchResult[];
  total: number;
  page: number;
  page_size: number;
  facets?: { sector: FacetValue[]; file_type: FacetValue[] };
}

const fmtDate = relativeDate;

// O snippet vem do ts_headline() do Postgres sobre o texto OCR do documento —
// texto controlado por quem faz upload, não pelo backend. ts_headline só
// insere os marcadores <mark>/</mark> literais; não escapa o resto do texto.
// Escapamos tudo via textContent (nunca interpretado como HTML) e só depois
// reconstituímos os marcadores de destaque já escapados de volta em <mark>
// reais — assim nenhum HTML/script arbitrário do OCR pode ser injetado.
// Fase 7.3: o backend separa múltiplos trechos de maior densidade com
// <hr/> (FragmentDelimiter) — dividimos ANTES de escapar cada pedaço, senão
// o delimitador em si viraria texto escapado e nunca seria reconhecido.
function highlightSnippet(snippet: string): string[] {
  return snippet.split("<hr/>").map((fragment) => {
    const span = document.createElement("span");
    span.textContent = fragment;
    return span.innerHTML
      .replace(/&lt;mark&gt;/g, '<mark class="bg-amber-200 text-amber-900 dark:bg-amber-400/30 dark:text-amber-200 rounded px-0.5">')
      .replace(/&lt;\/mark&gt;/g, "</mark>");
  });
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
  const [facets, setFacets] = useState<{ sector: FacetValue[]; file_type: FacetValue[] }>({ sector: [], file_type: [] });
  const [sectorFilter, setSectorFilter] = useState<string | null>(null);
  const [fileTypeFilter, setFileTypeFilter] = useState<string | null>(null);

  const doSearch = useCallback(
    (q: string, sector: string | null, fileType: string | null) => {
      if (!q.trim() || !current) return;
      setLoading(true);
      setSearched(true);
      api
        .get<SearchResponse>("/search", {
          params: {
            q: q.trim(),
            company_id: current.id,
            ...(sector ? { sector } : {}),
            ...(fileType ? { file_type: fileType } : {}),
          },
        })
        .then((r) => {
          setResults(r.data.results ?? r.data.items ?? []);
          setTotal(r.data.total);
          setFacets(r.data.facets ?? { sector: [], file_type: [] });
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [current?.id]
  );

  useEffect(() => {
    const q = params.get("q");
    if (q) { setQuery(q); doSearch(q, null, null); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      setFacets({ sector: [], file_type: [] });
      setSectorFilter(null);
      setFileTypeFilter(null);
      setParams({}, { replace: true });
      return;
    }
    const handle = setTimeout(() => {
      setParams({ q: query.trim() }, { replace: true });
      setSectorFilter(null);
      setFileTypeFilter(null);
      doSearch(query, null, null);
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setParams({ q: query.trim() });
    setSectorFilter(null);
    setFileTypeFilter(null);
    doSearch(query, null, null);
  }

  function clearQuery() {
    setQuery("");
    setSearched(false);
    setResults([]);
    setTotal(0);
    setFacets({ sector: [], file_type: [] });
    setSectorFilter(null);
    setFileTypeFilter(null);
    setParams({}, { replace: true });
  }

  // Fase 7.2: clicar numa faceta filtra sem apagar a busca; clicar de novo
  // na mesma faceta selecionada remove o filtro (toggle).
  function toggleSector(value: string) {
    const next = sectorFilter === value ? null : value;
    setSectorFilter(next);
    doSearch(query, next, fileTypeFilter);
  }
  function toggleFileType(value: string) {
    const next = fileTypeFilter === value ? null : value;
    setFileTypeFilter(next);
    doSearch(query, sectorFilter, next);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-mac-title2 font-semibold text-(--text-primary)">Busca avançada</h1>

      <form onSubmit={handleSubmit} className="flex gap-2">
        <div className="flex-1 relative">
          <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-(--text-placeholder) pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Digite para buscar documentos por conteúdo ou nome…"
            className="w-full h-10 pl-10 pr-9 text-mac-body bg-(--bg-card) border border-(--border-default) rounded-full text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-teal-500/70"
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
              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-(--text-tertiary) hover:bg-(--bg-hover) hover:text-(--text-primary) transition-colors duration-fast"
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
            <div key={i} className="h-20 bg-(--bg-card) border border-(--border-default) rounded-(--radius-control) animate-pulse" />
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
          <p className="text-mac-body text-(--text-secondary)">{total} resultado{total !== 1 ? "s" : ""} para "{params.get("q")}"</p>

          {/* Fase 7.2: facetas dinâmicas — setor e tipo de arquivo entre os
              documentos que bateram com a busca, com contagem por opção. */}
          {(facets.sector.length > 0 || facets.file_type.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {facets.sector.map((f) => (
                <button
                  key={`sector-${f.value}`}
                  type="button"
                  onClick={() => toggleSector(f.value)}
                  className={`h-7 px-3 text-mac-caption font-medium rounded-full border transition-colors duration-fast ${
                    sectorFilter === f.value
                      ? "bg-teal-600 border-teal-600 text-white"
                      : "bg-(--bg-card) border-(--border-default) text-(--text-secondary) hover:bg-(--bg-hover)"
                  }`}
                >
                  {f.value} <span className="opacity-70">({f.count})</span>
                </button>
              ))}
              {facets.file_type.map((f) => (
                <button
                  key={`filetype-${f.value}`}
                  type="button"
                  onClick={() => toggleFileType(f.value)}
                  className={`h-7 px-3 text-mac-caption font-medium rounded-full border transition-colors duration-fast ${
                    fileTypeFilter === f.value
                      ? "bg-teal-600 border-teal-600 text-white"
                      : "bg-(--bg-card) border-(--border-default) text-(--text-secondary) hover:bg-(--bg-hover)"
                  }`}
                >
                  .{f.value} <span className="opacity-70">({f.count})</span>
                </button>
              ))}
            </div>
          )}

          {/* Lista agrupada num único cartão com divisores — mesma convenção
              usada em Atividade/Lixeira/Compartilhados, em vez de um cartão
              flutuante por item (que destoava do resto do app no mobile). */}
          <div className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden">
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
                  className="flex items-start gap-3 px-5 py-3.5 hover:bg-(--bg-hover) transition-colors duration-fast cursor-pointer border-b border-(--border-default) last:border-0"
                >
                  {(() => { const s = getFileStyle(r.name); const Icon = s.icon; return (
                    <div className={`w-6 h-6 rounded-badge flex items-center justify-center shrink-0 ${s.bgColor}`}>
                      <Icon className={`w-3.5 h-3.5 ${s.iconColor} ${s.fillColor}`} />
                    </div>
                  ); })()}
                  <div className="flex-1 min-w-0">
                    <TruncatedFileName name={r.name} className="text-mac-body font-medium text-(--text-primary)" />
                    {r.snippet && highlightSnippet(r.snippet).map((fragment, i) => (
                      <p
                        key={i}
                        className="text-mac-caption text-(--text-secondary) mt-1 line-clamp-2"
                        dangerouslySetInnerHTML={{ __html: fragment }}
                      />
                    ))}
                    <p className="text-mac-caption text-(--text-tertiary) mt-1">
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
