import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search as SearchIcon, X, AlertTriangle, RefreshCw, Clock, ChevronLeft, ChevronRight, FileWarning, Bookmark } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { getFileStyle } from "@/lib/fileType";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import Dropdown from "@/components/ui/Dropdown";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { useToast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";

interface SavedSearch { id: string; name: string; query: string }

interface SearchResult {
  id: string;
  name: string;
  snippet: string | null;
  created_at: string;
  folder_id: string | null;
  folder_name?: string;
  folder_path_label?: string | null;
  ocr_status?: string;
  file_type?: string;
}
interface FacetValue { value: string; count: number }
interface SearchResponse {
  results: SearchResult[];
  total: number;
  page: number;
  page_size: number;
  facets?: { sector: FacetValue[]; file_type: FacetValue[] };
  sem_texto?: number;
  /** Sem resultado exato: são documentos com palavras parecidas (erro de digitação ou de OCR). */
  aproximado?: boolean;
}
interface FolderOption { id: string; name: string; path: string }

const PAGE_SIZE = 20;
const RECENT_KEY = "docke_buscas_recentes";

const PERIODS: { value: string; label: string }[] = [
  { value: "", label: "Qualquer data" },
  { value: "7", label: "Últimos 7 dias" },
  { value: "30", label: "Últimos 30 dias" },
  { value: "365", label: "Últimos 12 meses" },
  { value: "ano", label: "Este ano" },
  { value: "custom", label: "Escolher datas…" },
];

const SORTS = [
  { value: "relevancia", label: "Mais relevantes" },
  { value: "recentes", label: "Mais recentes" },
  { value: "antigos", label: "Mais antigos" },
  { value: "nome", label: "Nome (A–Z)" },
];

function isoDaysAgo(n: number) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).replace(/\./g, "");
}

// O trecho vem do ts_headline() sobre o texto do documento, controlado por
// quem envia o arquivo: escapa tudo e só depois devolve os <mark>.
function highlightSnippet(snippet: string): string[] {
  return snippet.split("<hr/>").map((fragment) => {
    const span = document.createElement("span");
    span.textContent = fragment;
    return span.innerHTML
      .replace(/&lt;mark&gt;/g, '<mark class="bg-amber-200 text-amber-950 dark:bg-amber-400/30 dark:text-amber-100 rounded px-0.5">')
      .replace(/&lt;\/mark&gt;/g, "</mark>");
  });
}

function loadRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").slice(0, 8); } catch { return []; }
}

/**
 * Busca (achados A6-03..A6-09): filtros de pasta, período, tipo e ordenação
 * guardados na URL, paginação, resultados como links, respostas fora de
 * ordem descartadas, lista anterior visível enquanto a nova chega e vazio
 * que diz o que fazer.
 */
export default function Search() {
  usePageTitle("Busca");
  const { current } = useCompany();
  const [params, setParams] = useSearchParams();
  const uid = useId();

  const q = params.get("q") ?? "";
  const pasta = params.get("pasta") ?? "";
  const sub = params.get("sub") !== "0";
  const periodo = params.get("periodo") ?? "";
  const de = params.get("de") ?? "";
  const ate = params.get("ate") ?? "";
  const ordem = params.get("ordem") ?? "relevancia";
  const tipo = params.get("tipo") ?? "";
  const setor = params.get("setor") ?? "";
  const pagina = Math.max(1, Number(params.get("pagina") ?? 1) || 1);

  const [text, setText] = useState(q);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [retry, setRetry] = useState(0);
  // Prévia lateral do resultado em foco (J1-13), como a paleta já tem.
  const [ativo, setAtivo] = useState<SearchResult | null>(null);
  const [previa, setPrevia] = useState<{ id: string; size_bytes?: number; trecho: string } | null>(null);
  const previaCache = useRef(new Map<string, { id: string; size_bytes?: number; trecho: string }>());
  useEffect(() => {
    if (!ativo) return;
    const c = previaCache.current.get(ativo.id);
    if (c) { setPrevia(c); return; }
    setPrevia(null);
    let vivo = true;
    const t = window.setTimeout(() => {
      api.get(`/documents/${ativo.id}`).then((r) => {
        const v = { id: ativo.id, size_bytes: r.data?.size_bytes, trecho: (r.data?.ocr_excerpt ?? r.data?.ocr_text ?? "").slice(0, 900) };
        previaCache.current.set(ativo.id, v);
        if (vivo) setPrevia(v);
      }).catch(() => { if (vivo) setPrevia({ id: ativo.id, trecho: "" }); });
    }, 120);
    return () => { vivo = false; window.clearTimeout(t); };
  }, [ativo]);
  const reqId = useRef(0);

  // Buscas salvas (B2.1.5): consulta + filtros, reexecutável em um clique.
  const { success, error: showError } = useToast();
  const [salvas, setSalvas] = useState<SavedSearch[]>([]);
  const [salvando, setSalvando] = useState(false);
  const [nomeSalva, setNomeSalva] = useState("");
  useEffect(() => {
    if (!current) return;
    api.get<SavedSearch[]>("/search/saved", { params: { company_id: current.id } }).then((r) => setSalvas(r.data ?? [])).catch(() => setSalvas([]));
  }, [current?.id]);
  function consultaAtual() {
    const n = new URLSearchParams(params);
    n.delete("pagina");
    return n.toString();
  }
  async function salvarBusca() {
    if (!current || !nomeSalva.trim()) return;
    try {
      const r = await api.post<SavedSearch>("/search/saved", { company_id: current.id, name: nomeSalva.trim(), query: consultaAtual() });
      setSalvas((xs) => [...xs.filter((x) => x.name !== r.data.name), r.data].sort((a, b) => a.name.localeCompare(b.name, "pt-BR")));
      success(`Busca "${r.data.name}" salva.`);
      setSalvando(false);
    } catch (e) {
      showError(friendlyError(e, "Não foi possível salvar a busca."));
    }
  }
  async function apagarBusca(id: string) {
    const antes = salvas;
    setSalvas((xs) => xs.filter((x) => x.id !== id));
    try { await api.delete(`/search/saved/${id}`); } catch { setSalvas(antes); showError("Não foi possível apagar."); }
  }
  const salvaAtual = salvas.find((x) => x.query === consultaAtual());

  function setP(changes: Record<string, string | null>, resetPage = true) {
    setParams((p) => {
      const n = new URLSearchParams(p);
      for (const [k, v] of Object.entries(changes)) { if (v === null || v === "") n.delete(k); else n.set(k, v); }
      if (resetPage && !("pagina" in changes)) n.delete("pagina");
      return n;
    }, { replace: true });
  }

  useEffect(() => { setText(q); }, [q]);
  useEffect(() => {
    if (!current) return;
    api.get<FolderOption[]>("/folders", { params: { company_id: current.id, flat: true } }).then((r) => setFolders(r.data ?? [])).catch(() => setFolders([]));
  }, [current?.id]);

  // Digitar atualiza a URL com debounce de 250 ms.
  useEffect(() => {
    if (text.trim() === q) return;
    const t = setTimeout(() => setP({ q: text.trim() || null }), 250);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  const [dateFrom, dateTo] = useMemo(() => {
    if (periodo === "custom") return [de, ate];
    if (periodo === "ano") return [`${new Date().getFullYear()}-01-01`, ""];
    if (periodo) return [isoDaysAgo(Number(periodo)), ""];
    return ["", ""];
  }, [periodo, de, ate]);

  useEffect(() => {
    if (!current || !q) { setData(null); setState("idle"); return; }
    const id = ++reqId.current;
    setState("loading");
    api.get<SearchResponse>("/search", {
      params: {
        q, company_id: current.id, page: pagina, page_size: PAGE_SIZE, sort: ordem,
        folder_id: pasta || undefined, subfolders: pasta ? sub : undefined,
        date_from: dateFrom || undefined, date_to: dateTo || undefined,
        file_type: tipo || undefined, sector: setor || undefined,
      },
    })
      .then((r) => {
        if (id !== reqId.current) return;  // resposta velha: descarta (A6-08)
        setData(r.data); setState("idle");
        const next = [q, ...loadRecent().filter((x) => x !== q)].slice(0, 8);
        localStorage.setItem(RECENT_KEY, JSON.stringify(next)); setRecent(next);
      })
      .catch(() => { if (id === reqId.current) setState("error"); });
  }, [current?.id, q, pasta, sub, dateFrom, dateTo, ordem, tipo, setor, pagina, retry]); // eslint-disable-line react-hooks/exhaustive-deps

  const folderOpts = useMemo(() => [{ value: "", label: "Todas as pastas" }, ...[...folders].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ value: f.id, label: f.name, depth: f.path.split(".").length - 1 }))], [folders]);
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtros = !!(pasta || periodo || tipo || setor);
  const results = data?.results ?? [];

  return (
    <div className="space-y-5 max-w-[1280px] w-full mx-auto">
      <h1 className="text-mac-title2 font-semibold text-(--text-primary)">Busca</h1>

      <form role="search" onSubmit={(e) => { e.preventDefault(); setP({ q: text.trim() || null }); }} className="relative">
        <label htmlFor={`${uid}-q`} className="sr-only">Buscar no nome, no texto e nos metadados dos documentos</label>
        <SearchIcon className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-(--text-secondary) pointer-events-none" aria-hidden="true" />
        <input
          id={`${uid}-q`} type="text" value={text} onChange={(e) => setText(e.target.value)} autoFocus
          placeholder="Nome, trecho do texto, CNPJ, CPF ou número da nota"
          className="w-full h-11 pl-10 pr-10 text-mac-body pointer-coarse:text-[16px] bg-(--bg-card) border border-(--border-control) rounded-full text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
        />
        {text && (
          <button type="button" onClick={() => { setText(""); setP({ q: null }); }} aria-label="Limpar busca"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </form>

      <div className="grid grid-cols-1 lg:grid-cols-[240px_1fr] xl:grid-cols-[240px_1fr_320px] gap-5">
        {/* Filtros (A6-03) */}
        <aside aria-label="Filtros" className="space-y-4">
          <div>
            <label id={`${uid}-pasta`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Pasta</label>
            <Dropdown ariaLabelledby={`${uid}-pasta`} value={pasta} onChange={(v) => setP({ pasta: v || null, sub: null })} options={folderOpts} />
            {pasta && (
              <label className="mt-1.5 flex items-center gap-2 text-mac-caption text-(--text-primary)">
                <Checkbox checked={sub} onChange={(e) => setP({ sub: e.target.checked ? null : "0" })} /> Incluir subpastas
              </label>
            )}
          </div>
          <div>
            <label id={`${uid}-per`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Enviado em</label>
            <Dropdown ariaLabelledby={`${uid}-per`} value={periodo} onChange={(v) => setP({ periodo: v || null, de: null, ate: null })} options={PERIODS} />
            {periodo === "custom" && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-mac-caption text-(--text-secondary)">De
                  <input type="date" value={de} max={ate || undefined} onChange={(e) => setP({ de: e.target.value || null })}
                    className="mt-0.5 h-9 w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-2 text-mac-caption text-(--text-primary)" />
                </label>
                <label className="text-mac-caption text-(--text-secondary)">Até
                  <input type="date" value={ate} min={de || undefined} onChange={(e) => setP({ ate: e.target.value || null })}
                    className="mt-0.5 h-9 w-full rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-2 text-mac-caption text-(--text-primary)" />
                </label>
              </div>
            )}
          </div>
          <div>
            <label id={`${uid}-ord`} className="block text-mac-caption font-medium text-(--text-secondary) mb-1">Ordenar por</label>
            <Dropdown ariaLabelledby={`${uid}-ord`} value={ordem} onChange={(v) => setP({ ordem: v === "relevancia" ? null : v })} options={SORTS} />
          </div>
          {data?.facets && (data.facets.file_type.length > 0 || data.facets.sector.length > 0) && (
            <div className="space-y-2">
              {data.facets.file_type.length > 0 && (
                <fieldset>
                  <legend className="text-mac-caption font-medium text-(--text-secondary) mb-1">Tipo</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {data.facets.file_type.map((f) => (
                      <button key={f.value} type="button" aria-pressed={tipo === f.value} onClick={() => setP({ tipo: tipo === f.value ? null : f.value })}
                        className={`h-8 pointer-coarse:h-10 px-3 text-mac-caption font-medium rounded-full border transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${tipo === f.value ? "bg-teal-600 border-teal-600 text-white" : "border-(--border-control) text-(--text-primary) hover:bg-(--bg-hover)"}`}>
                        {f.value.toUpperCase()} <span className="opacity-75">{f.count}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              {data.facets.sector.length > 0 && (
                <fieldset>
                  <legend className="text-mac-caption font-medium text-(--text-secondary) mb-1">Setor</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {data.facets.sector.map((f) => (
                      <button key={f.value} type="button" aria-pressed={setor === f.value} onClick={() => setP({ setor: setor === f.value ? null : f.value })}
                        className={`h-8 pointer-coarse:h-10 px-3 text-mac-caption font-medium rounded-full border transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${setor === f.value ? "bg-teal-600 border-teal-600 text-white" : "border-(--border-control) text-(--text-primary) hover:bg-(--bg-hover)"}`}>
                        {f.value} <span className="opacity-75">{f.count}</span>
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
          )}
          {filtros && <Button variant="ghost" size="sm" onClick={() => setP({ pasta: null, sub: null, periodo: null, de: null, ate: null, tipo: null, setor: null })}>Limpar filtros</Button>}
          {salvas.length > 0 && (
            <div>
              <p className="text-mac-caption font-medium text-(--text-secondary) mb-1">Buscas salvas</p>
              <ul className="space-y-0.5">
                {salvas.map((x) => (
                  <li key={x.id} className="group flex items-center gap-1">
                    <button type="button" onClick={() => setParams(new URLSearchParams(x.query), { replace: false })}
                      aria-current={salvaAtual?.id === x.id ? "true" : undefined}
                      className={`flex-1 min-w-0 flex items-center gap-1.5 h-8 pointer-coarse:h-10 px-2 rounded-(--radius-control) text-left text-mac-caption hover:bg-(--bg-hover) ${salvaAtual?.id === x.id ? "text-(--text-accent) font-medium" : "text-(--text-primary)"}`}>
                      <Bookmark className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{x.name}</span>
                    </button>
                    <button type="button" aria-label={`Apagar a busca salva ${x.name}`} onClick={() => apagarBusca(x.id)}
                      className="w-7 h-7 pointer-coarse:w-10 pointer-coarse:h-10 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) opacity-60 group-hover:opacity-100 focus-visible:opacity-100">
                      <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <section aria-label="Resultados" className="min-w-0 space-y-3">
          <p className="sr-only" role="status" aria-live="polite">
            {state === "loading" ? "Buscando" : state === "error" ? "A busca falhou" : q && data ? `${total} ${total === 1 ? "resultado" : "resultados"}` : ""}
          </p>

          {!q ? (
            <div className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 space-y-3">
              <p className="text-mac-body text-(--text-primary)">Busque pelo nome do arquivo, por qualquer trecho do texto lido nos documentos ou por um valor de metadado.</p>
              <p className="text-mac-caption text-(--text-secondary)">Dica: CNPJ, CPF e números funcionam com ou sem pontuação. Aspas buscam a frase exata; um sinal de menos tira uma palavra (ex.: nota -cancelada).</p>
              {recent.length > 0 && (
                <div>
                  <p className="text-mac-caption font-medium text-(--text-secondary) mb-1.5">Buscas recentes</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {recent.map((r) => (
                      <li key={r}><button onClick={() => setP({ q: r })} className="inline-flex items-center gap-1.5 h-8 pointer-coarse:h-10 px-3 rounded-full border border-(--border-control) text-mac-caption text-(--text-primary) hover:bg-(--bg-hover)">
                        <Clock className="w-3 h-3" aria-hidden="true" />{r}</button></li>
                    ))}
                    <li><button onClick={() => { localStorage.removeItem(RECENT_KEY); setRecent([]); }} className="h-8 pointer-coarse:h-10 px-2 text-mac-caption text-(--text-accent) hover:underline">Apagar histórico</button></li>
                  </ul>
                </div>
              )}
            </div>
          ) : state === "error" && !data ? (
            <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) flex flex-wrap items-center gap-3 px-5 py-4">
              <AlertTriangle className="w-4 h-4 text-(--text-warning)" aria-hidden="true" />
              <p className="flex-1 text-mac-body text-(--text-primary)">A busca falhou. Confira a conexão e tente de novo.</p>
              <Button variant="secondary" size="sm" onClick={() => setRetry((n) => n + 1)}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
            </div>
          ) : !data ? (
            <div className="space-y-2" aria-label="Buscando">{[0, 1, 2, 3].map((i) => <div key={i} className="h-[72px] rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>
          ) : results.length === 0 ? (
            <div className="glass-panel glass-blur-card rounded-(--radius-panel) p-5 space-y-2">
              <p className="text-mac-body font-medium text-(--text-primary)">Nada encontrado para “{q}”{filtros ? " com estes filtros" : ""}.</p>
              <ul className="list-disc pl-5 text-mac-caption text-(--text-secondary) space-y-0.5">
                {filtros && <li><button className="text-(--text-accent) hover:underline" onClick={() => setP({ pasta: null, sub: null, periodo: null, de: null, ate: null, tipo: null, setor: null })}>Buscar sem os filtros</button></li>}
                <li>Confira a grafia ou use menos palavras (a busca já ignora acentos).</li>
                {!!data.sem_texto && <li>{data.sem_texto} {data.sem_texto === 1 ? "documento ainda não teve" : "documentos ainda não tiveram"} o texto lido e só {data.sem_texto === 1 ? "aparece" : "aparecem"} pelo nome.</li>}
              </ul>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                {data.aproximado ? (
                  <p role="status" className="text-mac-body text-(--text-secondary)">
                    Nada exato para “{q}”. {total === 1 ? "Este documento tem" : `Estes ${total} documentos têm`} palavras parecidas (pode ser erro de digitação ou de leitura do texto).
                  </p>
                ) : (
                <p className="text-mac-body text-(--text-secondary)">
                  {total.toLocaleString("pt-BR")} {total === 1 ? "resultado" : "resultados"} para “{q}”
                  {pages > 1 && ` · página ${pagina} de ${pages}`}
                </p>
                )}
                {!!data.sem_texto && (
                  <p className="inline-flex items-center gap-1 text-mac-caption text-(--text-secondary)"><FileWarning className="w-3.5 h-3.5 text-(--text-warning)" aria-hidden="true" />
                    {data.sem_texto} sem texto lido só aparecem pelo nome</p>
                )}
                {salvaAtual ? (
                  <span className="inline-flex items-center gap-1 text-mac-caption text-(--text-accent)"><Bookmark className="w-3.5 h-3.5 fill-current" aria-hidden="true" /> Salva como “{salvaAtual.name}”</span>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => { setNomeSalva(q.slice(0, 80)); setSalvando(true); }}><Bookmark className="w-3.5 h-3.5" aria-hidden="true" /> Salvar busca</Button>
                )}
              </div>
              {salvando && (
                <Dialog onClose={() => setSalvando(false)} title="Salvar busca" size="sm"
                  description="Guarda o termo e os filtros de agora. Ela fica no painel ao lado, só para você, nesta empresa."
                  footer={<><Button variant="ghost" onClick={() => setSalvando(false)}>Cancelar</Button><Button disabled={!nomeSalva.trim()} onClick={salvarBusca}>Salvar</Button></>}>
                  <form onSubmit={(e) => { e.preventDefault(); salvarBusca(); }}>
                    <Input label="Nome" value={nomeSalva} onChange={(e) => setNomeSalva(e.target.value)} maxLength={80} autoFocus placeholder="Ex.: Notas do fornecedor X em 2026" />
                  </form>
                </Dialog>
              )}
              <ul className={`glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden transition-opacity duration-fast ${state === "loading" ? "opacity-60" : ""}`}>
                {results.map((r) => {
                  const s = getFileStyle(r.name);
                  const Icon = s.icon;
                  return (
                    <li key={r.id} className="border-b border-(--border-default) last:border-0">
                      <Link to={`/documents?folder_id=${r.folder_id ?? ""}&doc=${r.id}&busca=${encodeURIComponent(q)}`}
                        onMouseEnter={() => setAtivo(r)} onFocus={() => setAtivo(r)}
                        aria-current={ativo?.id === r.id ? "true" : undefined}
                        className="flex items-start gap-3 px-4 sm:px-5 py-3 hover:bg-(--bg-hover) transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)">
                        <span className={`w-7 h-7 rounded-badge flex items-center justify-center shrink-0 ${s.bgColor}`} aria-hidden="true">
                          <Icon className={`w-4 h-4 ${s.iconColor} ${s.fillColor}`} />
                        </span>
                        <span className="flex-1 min-w-0 max-w-[75ch]">
                          <span className="block text-mac-body font-medium text-(--text-primary) break-words">{r.name}</span>
                          {r.snippet && highlightSnippet(r.snippet).map((fragment, i) => (
                            <span key={i} className="block text-mac-caption text-(--text-secondary) mt-1 line-clamp-2" dangerouslySetInnerHTML={{ __html: fragment }} />
                          ))}
                          <span className="block text-mac-caption text-(--text-secondary) mt-1">
                            {r.folder_path_label ?? r.folder_name ?? "Sem pasta"} · enviado em {fmtDate(r.created_at)}
                            {r.ocr_status === "failed" ? " · texto não lido" : r.ocr_status === "pending" || r.ocr_status === "processing" ? " · lendo o texto" : ""}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {pages > 1 && (
                <nav aria-label="Páginas de resultados" className="flex items-center justify-center gap-2">
                  <Button variant="secondary" size="sm" disabled={pagina <= 1} onClick={() => setP({ pagina: String(pagina - 1) }, false)}><ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" /> Anterior</Button>
                  <span className="text-mac-body text-(--text-secondary) tabular-nums">{pagina} / {pages}</span>
                  <Button variant="secondary" size="sm" disabled={pagina >= pages} onClick={() => setP({ pagina: String(pagina + 1) }, false)}>Próxima <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" /></Button>
                </nav>
              )}
            </>
          )}
        </section>

        {/* Prévia (J1-13): só em telas largas, ao lado dos resultados. */}
        <aside aria-label="Prévia do resultado" className="hidden xl:block">
          <div className="sticky top-4 glass-panel glass-blur-card rounded-(--radius-panel) p-4 space-y-3 min-h-40">
            {!ativo || !q || !results.some((r) => r.id === ativo.id) ? (
              <p className="text-mac-caption text-(--text-secondary)">Passe o mouse ou o foco num resultado para ver o trecho do texto aqui.</p>
            ) : (() => {
              const st = getFileStyle(ativo.name);
              const Ic = st.icon;
              return (
                <div key={ativo.id} className="reveal space-y-3">
                  <div className="flex items-start gap-2.5">
                    <span className={`w-8 h-8 rounded-badge flex items-center justify-center shrink-0 ${st.bgColor}`} aria-hidden="true"><Ic className={`w-4 h-4 ${st.iconColor} ${st.fillColor}`} /></span>
                    <div className="min-w-0">
                      <p className="text-mac-body font-semibold text-(--text-primary) break-words">{ativo.name}</p>
                      <p className="text-mac-caption text-(--text-secondary)">{ativo.folder_path_label ?? ativo.folder_name ?? "Sem pasta"} · {fmtDate(ativo.created_at)}</p>
                    </div>
                  </div>
                  {previa?.id !== ativo.id ? (
                    <div className="space-y-1.5" aria-label="Carregando a prévia">{[0, 1, 2].map((i) => <div key={i} className="h-3 rounded bg-(--bg-hover) animate-pulse" />)}</div>
                  ) : previa.trecho.trim() ? (
                    <p className="text-mac-caption text-(--text-primary) whitespace-pre-line line-clamp-[14]">{previa.trecho}</p>
                  ) : (
                    <p className="text-mac-caption text-(--text-secondary)">{ativo.ocr_status === "failed" ? "O texto deste documento não pôde ser lido." : "Sem texto lido neste documento."}</p>
                  )}
                  <Link to={`/documents?folder_id=${ativo.folder_id ?? ""}&doc=${ativo.id}`}
                    className="inline-flex items-center gap-1 h-8 px-3 rounded-full bg-teal-600 text-white text-mac-caption font-medium hover:bg-teal-700">
                    Abrir na pasta <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </Link>
                </div>
              );
            })()}
          </div>
        </aside>
      </div>
    </div>
  );
}
