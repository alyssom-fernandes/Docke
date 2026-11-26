import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import XmlCode from "./XmlCode";
import { X, Download, AlertCircle, Search, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Printer, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import api from "@/lib/api";
import Dialog, { DialogCloseButton } from "@/components/ui/Dialog";
import Code128 from "./Code128";
import type { PdfViewerHandle } from "./PdfViewer";

// pdf.js (~400 KB) só é baixado quando alguém abre um PDF.
const PdfViewer = lazy(() => import("./PdfViewer"));

interface Doc {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
}

/** Sem acento e sem caixa (achado A5-60). */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Ocorrências em texto, comparando sem acento; índices no texto original (NFD preserva o comprimento base). */
function findMatches(text: string, query: string): { index: number; length: number; snippet: string }[] {
  const q = fold(query.trim());
  if (q.length < 2 || !text) return [];
  // Normaliza caractere a caractere para manter os índices do texto original.
  const map: number[] = [];
  let folded = "";
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]);
    for (let k = 0; k < f.length; k++) map.push(i);
    folded += f;
  }
  const out: { index: number; length: number; snippet: string }[] = [];
  let from = 0;
  while (out.length < 500) {
    const at = folded.indexOf(q, from);
    if (at < 0) break;
    const start = map[at];
    const end = (map[at + q.length - 1] ?? start) + 1;
    const s0 = Math.max(0, start - 40);
    const s1 = Math.min(text.length, end + 40);
    out.push({ index: start, length: end - start, snippet: (s0 > 0 ? "…" : "") + text.slice(s0, s1).replace(/\s+/g, " ") + (s1 < text.length ? "…" : "") });
    from = at + q.length;
  }
  return out;
}

type PreviewType = "pdf" | "image" | "text" | "unsupported";

function resolveType(name: string, mime: string): PreviewType {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  // DOCX/XLSX/DOC/XLS: o backend devolve o PDF derivado (LibreOffice) no preview-url.
  if (["docx", "doc", "xlsx", "xls"].includes(ext)) return "pdf";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
  if (mime.startsWith("text/") || ["txt", "csv", "xml"].includes(ext)) return "text";
  return "unsupported";
}

interface XmlFields {
  recognized: boolean;
  chave_acesso?: string | null;
  numero?: string | null;
  serie?: string | null;
  data_emissao?: string | null;
  natureza_operacao?: string | null;
  emitente_nome?: string | null;
  emitente_cnpj?: string | null;
  destinatario_nome?: string | null;
  destinatario_cnpj?: string | null;
  valor_total?: string | null;
}

const fmtCurrency = (v?: string | null) => (!v ? "—" : Number.isNaN(Number(v)) ? v : Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }));
/** Texto e campos da NF-e já baixados nesta sessão (A5-58). */
const textCache = new Map<string, { text: string; truncated: boolean; fields?: XmlFields | null }>();

const fmtCnpj = (v?: string | null) => (!v ? "—" : v.length === 14 ? v.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5") : v.length === 11 ? v.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : v);
const fmtXmlDate = (v?: string | null) => { if (!v) return "—"; const d = new Date(v); return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("pt-BR"); };
const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1).replace(".", ",")} KB` : `${(b / 1048576).toFixed(1).replace(".", ",")} MB`);

// Marca d'água (usuário + data): dissuade vazamento por foto da tela.
function getWatermarkLabel(): string {
  const when = new Date().toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  try {
    const u = JSON.parse(localStorage.getItem("docke_user") ?? "null");
    const who = u?.email || u?.full_name || u?.username;
    return who ? `${who} · ${when}` : when;
  } catch {
    return when;
  }
}

function PreviewWatermark({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-10 overflow-hidden pointer-events-none select-none" aria-hidden="true">
      <div className="absolute flex flex-wrap content-start gap-14 origin-center" style={{ inset: "-30%", transform: "rotate(-30deg)" }}>
        {Array.from({ length: 48 }).map((_, i) => (
          <span key={i} className="text-mac-caption font-medium whitespace-nowrap text-(--text-primary) opacity-[0.05]">{label}</span>
        ))}
      </div>
    </div>
  );
}

/** Imprime só um nó (o DANFE): copia para a raiz e esconde o resto na impressão. */
function printNode(node: HTMLElement | null) {
  if (!node) return;
  const holder = document.createElement("div");
  holder.className = "area-impressao";
  holder.appendChild(node.cloneNode(true));
  document.body.appendChild(holder);
  document.body.classList.add("imprimindo-area");
  const done = () => { document.body.classList.remove("imprimindo-area"); holder.remove(); window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  window.setTimeout(done, 1500);
}

/** Imprime o arquivo (PDF ou imagem) sem baixar: blob local num iframe oculto. */
async function printFile(url: string) {
  const blob = await (await fetch(url)).blob();
  const objectUrl = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
  frame.src = objectUrl;
  document.body.appendChild(frame);
  frame.onload = () => {
    try { frame.contentWindow?.focus(); frame.contentWindow?.print(); } catch { window.open(objectUrl, "_blank"); }
    window.setTimeout(() => { frame.remove(); URL.revokeObjectURL(objectUrl); }, 60_000);
  };
}

const chunk4 = (s?: string | null) => (s ? s.match(/.{1,4}/g)?.join(" ") ?? s : "—");

function Danfe({ fields, docName }: { fields: XmlFields; docName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const box = "border border-black rounded-[2px] p-2";
  const cap = "text-[8.5px] uppercase tracking-wide text-black/80";
  return (
    <div>
      <div className="flex items-center justify-end mb-3 gap-2">
        <button onClick={() => printNode(ref.current)}
          className="inline-flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body bg-teal-600 text-white hover:bg-teal-700">
          <Printer className="w-3.5 h-3.5" aria-hidden /> Imprimir DANFE
        </button>
      </div>
      <div ref={ref} className="danfe max-w-[760px] mx-auto bg-white text-black rounded-[3px] shadow-[0_2px_16px_rgba(0,0,0,0.15)] p-5 font-sans text-[11px] leading-snug">
        <div className="grid grid-cols-[1.4fr_1fr_1.6fr] gap-2 mb-2">
          <section className={box} aria-label="Emitente">
            <p className={cap}>Emitente</p>
            <p className="font-bold text-[12px]">{fields.emitente_nome ?? "—"}</p>
            <p className="whitespace-nowrap">CNPJ {fmtCnpj(fields.emitente_cnpj)}</p>
          </section>
          <section className={`${box} text-center`} aria-label="Identificação do DANFE">
            <h3 className="font-bold text-[15px]">DANFE</h3>
            <p className="text-[9px]">Documento Auxiliar da Nota Fiscal Eletrônica</p>
            <p className="mt-1 font-semibold">Nº {fields.numero ?? "—"}</p>
            <p>Série {fields.serie ?? "—"}</p>
          </section>
          <section className={box} aria-label="Chave de acesso">
            <p className={cap}>Chave de acesso</p>
            {fields.chave_acesso && <Code128 value={fields.chave_acesso} height={40} label={`Código de barras da chave ${fields.chave_acesso}`} />}
            <p className="font-mono text-[10.5px] tracking-wide mt-1 break-all">{chunk4(fields.chave_acesso)}</p>
            <p className="text-[8.5px] mt-1">Consulte a autenticidade no portal nacional da NF-e (www.nfe.fazenda.gov.br/portal) ou no site da SEFAZ autorizadora.</p>
          </section>
        </div>
        <div className="grid grid-cols-[2fr_1fr] gap-2 mb-2">
          <section className={box}><p className={cap}>Natureza da operação</p><p>{fields.natureza_operacao ?? "—"}</p></section>
          <section className={box}><p className={cap}>Data de emissão</p><p>{fmtXmlDate(fields.data_emissao)}</p></section>
        </div>
        <section className={`${box} mb-2`} aria-label="Destinatário">
          <p className={cap}>Destinatário / remetente</p>
          <div className="grid grid-cols-[2fr_1fr] gap-2">
            <p className="font-medium">{fields.destinatario_nome ?? "—"}</p>
            <p className="whitespace-nowrap">CNPJ/CPF {fmtCnpj(fields.destinatario_cnpj)}</p>
          </div>
        </section>
        <section className={`${box} flex items-center justify-between`} aria-label="Cálculo do imposto">
          <p className={cap}>Valor total da nota</p>
          <p className="font-bold text-[15px]">{fmtCurrency(fields.valor_total)}</p>
        </section>
        <p className="text-[8.5px] text-center mt-3 text-black/70">Representação simplificada gerada pelo Docke a partir do XML ({docName}). O documento fiscal válido é o XML.</p>
      </div>
    </div>
  );
}

interface PreviewModalProps {
  doc: Doc;
  /** Lista da pasta, para ir ao anterior/próximo com as setas (achado A5-34). */
  docs?: Doc[];
  onClose: () => void;
  /** Centro do item clicado: a prévia cresce dali (A5-38). */
  origin?: { x: number; y: number } | null;
  /** Termo vindo da Busca: a busca interna já abre com ele (B2.6.6). */
  initialQuery?: string | null;
}

/**
 * Visualizador no nível do Quick Look (achados A5-34..A5-50): diálogo acessível
 * em tela ampla, setas ← → entre documentos da pasta, busca sem acento que
 * realça no próprio PDF e salta para a página (Ctrl+F abre a busca daqui),
 * imagem com zoom e girar, impressão do arquivo e DANFE com Code-128 real.
 */
export default function PreviewModal({ doc: initialDoc, docs, onClose, origin = null, initialQuery = null }: PreviewModalProps) {
  const list = docs && docs.length ? docs : [initialDoc];
  const [index, setIndex] = useState(() => Math.max(0, list.findIndex((d) => d.id === initialDoc.id)));
  const swipe = useRef<{ x: number; y: number; t: number } | null>(null);
  const doc = list[index] ?? initialDoc;

  const [url, setUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [xmlFields, setXmlFields] = useState<XmlFields | null>(null);
  const [xmlFieldsFailed, setXmlFieldsFailed] = useState(false);
  const [view, setView] = useState<"danfe" | "campos" | "xml">("danfe");
  const [watermarkLabel] = useState(getWatermarkLabel);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [pdfPages, setPdfPages] = useState<string[] | null>(null);
  const [searchOpen, setSearchOpen] = useState(!!initialQuery);
  const [query, setQuery] = useState(initialQuery ?? "");
  const [active, setActive] = useState(0);
  const [imgZoom, setImgZoom] = useState(1);
  const [imgRotation, setImgRotation] = useState(0);
  const pdfRef = useRef<PdfViewerHandle>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const type = resolveType(doc.name, doc.mime_type);
  const isXml = doc.name.toLowerCase().endsWith(".xml") || doc.mime_type.includes("xml");
  const { icon: Icon, iconColor } = getFileStyle(doc.name);

  // Carrega o documento atual (e zera o estado do anterior).
  useEffect(() => {
    let cancelled = false;
    setUrl(null); setTextContent(null); setTruncated(false); setError(null); setXmlFields(null); setXmlFieldsFailed(false); setView("danfe");
    setOcrText(null); setPdfPages(null); setActive(0); setImgZoom(1); setImgRotation(0); setLoading(true);
    const fail = (e: any) => {
      if (cancelled) return;
      setError(e?.response?.data?.detail ?? (e?.response ? "Não foi possível abrir a pré-visualização." : "Sem conexão com o servidor. Confira a internet e tente de novo."));
    };
    if (type === "unsupported") { setLoading(false); return; }
    // Cache da sessão (A5-58): reabrir o mesmo arquivo não baixa de novo.
    const cacheKey = `${doc.id}:${doc.size_bytes}`;
    const hit = textCache.get(cacheKey);
    if (type === "text" && hit) {
      setTextContent(hit.text); setTruncated(hit.truncated); setLoading(false);
      if (isXml && hit.fields !== undefined) { setXmlFields(hit.fields); if (!hit.fields) setXmlFieldsFailed(true); }
      if (!isXml || hit.fields !== undefined) return () => { cancelled = true; };
    } else if (type === "text") {
      api.get<{ download_url: string }>(`/documents/${doc.id}/download-url`)
        .then(async ({ data }) => {
          const resp = await fetch(data.download_url);
          if (!resp.ok) throw new Error("O arquivo não foi encontrado no armazenamento.");
          const txt = await resp.text();
          if (cancelled) return;
          setTextContent(txt.slice(0, 200_000));
          setTruncated(txt.length > 200_000);
          textCache.set(cacheKey, { ...(textCache.get(cacheKey) ?? {}), text: txt.slice(0, 200_000), truncated: txt.length > 200_000 });
        })
        .catch(fail)
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      api.get<{ inline: boolean; preview_url: string | null; message?: string }>(`/documents/${doc.id}/preview-url`)
        .then(({ data }) => {
          if (cancelled) return;
          if (!data.inline || !data.preview_url) setError(data.message ?? "Arquivo grande demais para pré-visualização. Use Baixar.");
          else setUrl(data.preview_url);
        })
        .catch(fail)
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    if (isXml && !(hit && hit.fields !== undefined)) {
      api.get<XmlFields>(`/documents/${doc.id}/xml-fields`)
        .then(({ data }) => {
          const c = textCache.get(cacheKey); if (c) c.fields = data;
          if (!cancelled) { setXmlFields(data); if (!data?.recognized) setXmlFieldsFailed(true); }
        })
        // Antes a falha caía no XML cru sem aviso (A5-55).
        .catch(() => { if (!cancelled) setXmlFieldsFailed(true); });
    }
    return () => { cancelled = true; };
  }, [doc.id, type, isXml]); // eslint-disable-line react-hooks/exhaustive-deps

  // Texto por página do PDF (camada nativa) para a busca saltar à página certa.
  const ensurePdfText = useCallback(async () => {
    if (type !== "pdf" || pdfPages || !pdfRef.current) return;
    setPdfPages(await pdfRef.current.pageTexts());
  }, [type, pdfPages]);

  const matches = useMemo(() => {
    if (type === "pdf" && pdfPages) {
      const out: { page: number; snippet: string }[] = [];
      pdfPages.forEach((t, i) => findMatches(t, query).forEach((m) => out.push({ page: i + 1, snippet: m.snippet })));
      return out;
    }
    const base = type === "text" ? textContent : ocrText;
    return findMatches(base ?? "", query).map((m) => ({ ...m, page: 0 }));
  }, [type, pdfPages, textContent, ocrText, query]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    if (type === "text" && matches.length) {
      bodyRef.current?.querySelector(`[data-match="${active}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [active, matches.length, type]);

  // Imagem: o texto lido só é buscado quando a lupa abre (A5-64).
  const ensureImageText = useCallback(() => {
    if (type !== "image" || ocrText !== null) return;
    api.get<{ text: string }>(`/documents/${doc.id}/text`).then(({ data }) => setOcrText(data.text ?? "")).catch(() => setOcrText(""));
  }, [type, ocrText, doc.id]);

  // Aberta já com um termo (vindo da Busca): imagem busca o texto lido na hora.
  useEffect(() => { if (searchOpen && type === "image") ensureImageText(); }, [searchOpen, type, ensureImageText]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    ensurePdfText();
    ensureImageText();
    window.setTimeout(() => searchRef.current?.focus(), 30);
  }, [ensurePdfText, ensureImageText]);

  // Teclado: ← → trocam de documento (fora de campos e do PDF), Ctrl+F busca.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { e.preventDefault(); openSearch(); return; }
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === "ArrowRight" && index < list.length - 1) { e.preventDefault(); setIndex(index + 1); }
      else if (e.key === "ArrowLeft" && index > 0) { e.preventDefault(); setIndex(index - 1); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, list.length, openSearch]);

  const highlighted = useMemo(() => {
    if (type !== "text" || !textContent || !matches.length) return null;
    const parts: ReactElement[] = [];
    let cursor = 0;
    (matches as unknown as { index: number; length: number }[]).forEach((m, i) => {
      if (m.index > cursor) parts.push(<span key={`t${i}`}>{textContent.slice(cursor, m.index)}</span>);
      parts.push(<mark key={`m${i}`} data-match={i} className={i === active ? "bg-amber-400 text-black rounded-[2px]" : "bg-amber-200/70 dark:bg-amber-500/35 text-inherit rounded-[2px]"}>{textContent.slice(m.index, m.index + m.length)}</mark>);
      cursor = m.index + m.length;
    });
    parts.push(<span key="fim">{textContent.slice(cursor)}</span>);
    return parts;
  }, [type, textContent, matches, active]);

  async function download() {
    try {
      const r = await api.get<{ download_url: string }>(`/documents/${doc.id}/download-url`);
      const a = document.createElement("a");
      a.href = r.data.download_url;
      a.download = doc.name;
      a.click();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Não foi possível baixar agora. Tente de novo.");
    }
  }

  const noText = type !== "unsupported" && ((type === "image" && ocrText === "") || (type === "text" && !textContent));
  const iconBtn = "h-8 w-8 pointer-coarse:h-11 pointer-coarse:w-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover) hover:text-(--text-primary) disabled:opacity-(--opacity-disabled) disabled:pointer-events-none shrink-0";

  const header = (
    <div className="flex items-center gap-2 px-3 sm:px-4 py-2.5 border-b border-(--border-default) shrink-0">
      <Icon className={`w-5 h-5 shrink-0 ${iconColor}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-mac-body font-semibold text-(--text-primary) truncate" title={doc.name}>{doc.name}</p>
        <p className="text-mac-caption text-(--text-secondary) truncate">
          {fmtSize(doc.size_bytes)}{list.length > 1 ? ` · ${index + 1} de ${list.length} nesta pasta` : ""}
        </p>
      </div>
      {list.length > 1 && (
        <div className="hidden sm:flex items-center">
          <button className={iconBtn} onClick={() => setIndex(index - 1)} disabled={index === 0} aria-label="Documento anterior (←)" title="Documento anterior (←)"><ChevronLeft className="w-4 h-4" aria-hidden /></button>
          <button className={iconBtn} onClick={() => setIndex(index + 1)} disabled={index >= list.length - 1} aria-label="Próximo documento (→)" title="Próximo documento (→)"><ChevronRight className="w-4 h-4" aria-hidden /></button>
        </div>
      )}
      {type !== "unsupported" && (
        <button className={iconBtn} onClick={() => (searchOpen ? setSearchOpen(false) : openSearch())} aria-label="Buscar no documento (Ctrl+F)" aria-pressed={searchOpen} title="Buscar no documento (Ctrl+F)">
          <Search className="w-4 h-4" aria-hidden />
        </button>
      )}
      {(type === "pdf" || type === "image") && url && (
        <button className={`${iconBtn} hidden sm:flex`} onClick={() => printFile(url).catch(() => setError("Não foi possível preparar a impressão."))} aria-label="Imprimir" title="Imprimir">
          <Printer className="w-4 h-4" aria-hidden />
        </button>
      )}
      <button onClick={download} className="hidden sm:flex items-center gap-1.5 h-8 pointer-coarse:h-11 px-3 text-mac-body border border-(--border-control) rounded-full text-(--text-primary) hover:bg-(--bg-hover)">
        <Download className="w-3.5 h-3.5" aria-hidden /> Baixar
      </button>
      <button className={`${iconBtn} sm:hidden`} onClick={download} aria-label="Baixar"><Download className="w-4 h-4" aria-hidden /></button>
      <DialogCloseButton className={iconBtn} label="Fechar (Esc)"><X className="w-4 h-4" aria-hidden /></DialogCloseButton>
    </div>
  );

  return (
    // Fundo opaco (J1-05): no tema claro o vidro deixava a tela de trás aparecer em volta da página.
    <Dialog onClose={onClose} origin={origin} title={`Pré-visualização de ${doc.name}`} size="full" header={header} className="bg-(--bg-card)!" bodyClassName="p-0! overflow-hidden! flex flex-col">
      {searchOpen && (
        <div className="reveal flex items-center gap-2 px-4 py-2 border-b border-(--border-default) shrink-0" role="search">
          <Search className="w-3.5 h-3.5 text-(--text-tertiary) shrink-0" aria-hidden />
          <label htmlFor="busca-interna" className="sr-only">Buscar neste documento</label>
          <input
            id="busca-interna"
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches.length) setActive((i) => (e.shiftKey ? (i - 1 + matches.length) % matches.length : (i + 1) % matches.length));
              if (e.key === "Escape") { e.stopPropagation(); setSearchOpen(false); }
            }}
            placeholder={noText ? "Este documento não tem texto reconhecido" : "Buscar neste documento (acentos não importam)"}
            disabled={noText}
            className="flex-1 h-8 pointer-coarse:h-11 px-3 text-mac-body bg-(--bg-card) border border-(--border-control) rounded-full text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)"
          />
          <span className="text-mac-caption text-(--text-secondary) tabular-nums shrink-0" aria-live="polite">
            {query.trim().length >= 2 ? (matches.length ? `${active + 1} de ${matches.length}` : "nada encontrado") : ""}
          </span>
          <button className={iconBtn} onClick={() => setActive((i) => (i - 1 + matches.length) % matches.length)} disabled={!matches.length} aria-label="Resultado anterior (Shift+Enter)"><ChevronUp className="w-4 h-4" aria-hidden /></button>
          <button className={iconBtn} onClick={() => setActive((i) => (i + 1) % matches.length)} disabled={!matches.length} aria-label="Próximo resultado (Enter)"><ChevronDown className="w-4 h-4" aria-hidden /></button>
        </div>
      )}
      {/* Deslizar para o lado troca de documento no toque (A5-39). */}
      <div className="relative flex-1 min-h-0" ref={bodyRef}
        onTouchStart={(e) => { if (e.touches.length === 1) swipe.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }; }}
        onTouchEnd={(e) => {
          const st = swipe.current; swipe.current = null;
          if (!st || e.changedTouches.length !== 1 || Date.now() - st.t > 600) return;
          const dx = e.changedTouches[0].clientX - st.x, dy = e.changedTouches[0].clientY - st.y;
          if (Math.abs(dx) < 70 || Math.abs(dy) > 50) return;
          if (window.visualViewport && window.visualViewport.scale > 1.05) return;
          if (dx < 0 && index < list.length - 1) setIndex(index + 1);
          else if (dx > 0 && index > 0) setIndex(index - 1);
        }}>
        {loading && (
          <div className="absolute inset-0 p-8" aria-label="Carregando pré-visualização">
            <div className="mx-auto max-w-[640px] aspect-[1/1.3] rounded-[4px] bg-(--bg-hover) animate-pulse" />
          </div>
        )}
        {!loading && error && (
          <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
            <AlertCircle className="w-10 h-10 text-(--text-tertiary)" aria-hidden />
            <p className="text-mac-body text-(--text-secondary) max-w-sm">{error}</p>
            <button onClick={download} className="inline-flex items-center gap-1.5 h-9 pointer-coarse:h-11 px-4 rounded-full bg-teal-600 text-white text-mac-body hover:bg-teal-700"><Download className="w-4 h-4" aria-hidden /> Baixar o arquivo</button>
          </div>
        )}
        {!loading && !error && type === "unsupported" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
            <Icon className={`w-12 h-12 ${iconColor}`} aria-hidden />
            <p className="text-mac-body text-(--text-secondary)">Este tipo de arquivo não tem pré-visualização. Baixe para abrir no programa certo.</p>
            <button onClick={download} className="inline-flex items-center gap-1.5 h-9 pointer-coarse:h-11 px-4 rounded-full bg-teal-600 text-white text-mac-body hover:bg-teal-700"><Download className="w-4 h-4" aria-hidden /> Baixar</button>
          </div>
        )}
        {!loading && !error && (type === "pdf" || type === "image") && <PreviewWatermark label={watermarkLabel} />}
        {!loading && !error && type === "pdf" && url && (
          <Suspense fallback={<div className="p-8"><div className="mx-auto max-w-[640px] aspect-[1/1.3] rounded-[4px] bg-(--bg-hover) animate-pulse" /></div>}>
            <PdfViewer
              ref={pdfRef}
              url={url}
              query={searchOpen ? query : ""}
              focusPage={matches.length && searchOpen ? (matches[active] as { page: number }).page : null}
              onLoaded={() => { if (searchOpen) ensurePdfText(); }}
            />
          </Suspense>
        )}
        {!loading && !error && type === "image" && url && (
          <div className="relative w-full h-full">
            <div className="w-full h-full overflow-auto bg-(--bg-page) flex items-center justify-center p-4">
              <img src={url} alt={doc.name} style={{ transform: `rotate(${imgRotation}deg) scale(${imgZoom})`, transition: "transform 200ms cubic-bezier(0.2,0.8,0.2,1)" }}
                className="max-w-full max-h-full object-contain rounded-[3px] origin-center" />
            </div>
            <div className="absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none">
              <div className="pointer-events-auto glass-panel glass-blur-strong glass-shadow rounded-full flex items-center gap-0.5 px-1.5 py-1">
                <button className={iconBtn} onClick={() => setImgZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Diminuir zoom"><ZoomOut className="w-4 h-4" aria-hidden /></button>
                <span className="text-mac-caption text-(--text-secondary) min-w-[40px] text-center tabular-nums" aria-live="polite">{Math.round(imgZoom * 100)}%</span>
                <button className={iconBtn} onClick={() => setImgZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))} aria-label="Aumentar zoom"><ZoomIn className="w-4 h-4" aria-hidden /></button>
                <button className={iconBtn} onClick={() => setImgRotation((r) => (r + 90) % 360)} aria-label="Girar 90°"><RotateCw className="w-4 h-4" aria-hidden /></button>
              </div>
            </div>
          </div>
        )}
        {!loading && !error && type === "image" && searchOpen && query.trim().length >= 2 && (
          <ul className="absolute top-3 right-3 left-3 sm:left-auto sm:w-80 max-h-56 overflow-y-auto glass-panel glass-blur-strong rounded-(--radius-panel) shadow-modal p-2 space-y-1 z-20" aria-label="Trechos encontrados no texto reconhecido">
            {matches.length === 0 ? (
              <li className="text-mac-caption text-(--text-secondary) px-2 py-1">Nada encontrado no texto reconhecido da imagem.</li>
            ) : matches.map((m, i) => (
              <li key={i}><button onClick={() => setActive(i)} aria-current={i === active || undefined}
                className={`w-full text-left px-2 py-1.5 rounded-[6px] text-mac-caption ${i === active ? "bg-teal-500/15 text-(--text-primary)" : "text-(--text-secondary) hover:bg-(--bg-hover)"}`}>{m.snippet}</button></li>
            ))}
          </ul>
        )}
        {!loading && !error && type === "text" && textContent !== null && (
          <div className="w-full h-full overflow-auto">
            {isXml && xmlFields?.recognized && (
              <div className="sticky top-0 z-10 flex items-center gap-1 bg-(--bg-card) border-b border-(--border-default) px-4 py-2" role="tablist" aria-label="Como ver a nota">
                {([["danfe", "DANFE"], ["campos", "Campos"], ["xml", "XML"]] as const).map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={view === k} onClick={() => setView(k)}
                    className={`h-8 pointer-coarse:h-11 px-3 rounded-full text-mac-body ${view === k ? "bg-teal-600 text-white" : "text-(--text-secondary) hover:bg-(--bg-hover)"}`}>{label}</button>
                ))}
              </div>
            )}
            {isXml && xmlFieldsFailed && (
              <p role="status" className="px-5 pt-3 text-mac-caption text-(--text-secondary)">Este XML não foi reconhecido como NF-e (ou a leitura falhou agora): mostrando o arquivo como está.</p>
            )}
            {isXml && xmlFields?.recognized && view === "danfe" ? (
              <div key="danfe" className="reveal p-4 sm:p-6"><Danfe fields={xmlFields} docName={doc.name} /></div>
            ) : isXml && xmlFields?.recognized && view === "campos" ? (
              <dl key="campos" className="reveal grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 p-6 max-w-[760px]">
                {([
                  ["Número", xmlFields.numero], ["Série", xmlFields.serie], ["Data de emissão", fmtXmlDate(xmlFields.data_emissao)],
                  ["Valor total", fmtCurrency(xmlFields.valor_total)], ["Natureza da operação", xmlFields.natureza_operacao],
                  ["Emitente", xmlFields.emitente_nome], ["CNPJ do emitente", fmtCnpj(xmlFields.emitente_cnpj)],
                  ["Destinatário", xmlFields.destinatario_nome], ["CNPJ/CPF do destinatário", fmtCnpj(xmlFields.destinatario_cnpj)],
                  ["Chave de acesso", chunk4(xmlFields.chave_acesso)],
                ] as [string, string | null | undefined][]).map(([k, v]) => (
                  <div key={k}><dt className="text-mac-caption text-(--text-secondary)">{k}</dt><dd className="text-mac-body text-(--text-primary) mt-0.5 break-words select-text">{v || "—"}</dd></div>
                ))}
              </dl>
            ) : (
              <>
                {truncated && <p className="px-5 pt-3 text-mac-caption text-(--text-warning)">Mostrando os primeiros 200 mil caracteres. Baixe o arquivo para ver tudo.</p>}
                {isXml && !highlighted ? (
                  <div key="xml" className="reveal"><XmlCode text={textContent} /></div>
                ) : (
                  <pre className="p-5 text-[12px] leading-relaxed font-mono text-(--text-primary) whitespace-pre-wrap break-words select-text">{highlighted ?? textContent}</pre>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {list.length > 1 && (
        <div className="sm:hidden flex items-center justify-between border-t border-(--border-default) px-2 py-1 shrink-0">
          <button className={iconBtn} onClick={() => setIndex(index - 1)} disabled={index === 0} aria-label="Documento anterior"><ChevronLeft className="w-5 h-5" aria-hidden /></button>
          <span className="text-mac-caption text-(--text-secondary)">{index + 1} de {list.length}</span>
          <button className={iconBtn} onClick={() => setIndex(index + 1)} disabled={index >= list.length - 1} aria-label="Próximo documento"><ChevronRight className="w-5 h-5" aria-hidden /></button>
        </div>
      )}
    </Dialog>
  );
}
