import { useEffect, useMemo, useRef, useState } from "react";
import { X, Download, AlertCircle, Loader2, Search, ChevronUp, ChevronDown } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { getFileStyle } from "@/lib/fileType";
import api from "@/lib/api";
import Portal from "@/components/ui/Portal";
import PdfViewer from "./PdfViewer";

interface Doc {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
}

// Fase 12.3 — busca dentro do documento usando o texto já extraído pelo OCR
// (ocr_text), sem precisar reprocessar nada. Pra tipo "text" (txt/csv/xml) dá
// pra destacar E rolar até a ocorrência de verdade, porque o texto renderiza
// como DOM real (<pre>). Pra PDF/imagem o render é em <canvas> (Fase 12.2 —
// PdfViewer não tem camada de texto selecionável), então mostra os trechos
// batidos como lista de contexto em vez de fingir que rola até a página certa.
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatches(text: string, query: string): { index: number; snippet: string }[] {
  if (!query.trim()) return [];
  const re = new RegExp(escapeRegExp(query.trim()), "gi");
  const matches: { index: number; snippet: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = Math.max(0, m.index - 40);
    const end = Math.min(text.length, m.index + m[0].length + 40);
    const snippet = (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ") + (end < text.length ? "…" : "");
    matches.push({ index: m.index, snippet });
    if (m.index === re.lastIndex) re.lastIndex++; // evita loop infinito em match vazio
    if (matches.length >= 200) break; // limite de segurança
  }
  return matches;
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

function fmtCurrency(value?: string | null) {
  if (!value) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function fmtCnpj(value?: string | null) {
  if (!value) return "—";
  return value.length === 14
    ? value.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5")
    : value;
}

function fmtXmlDate(value?: string | null) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString("pt-BR");
}

// Marca d'água dinâmica (usuário + data/hora) sobre o preview — desestimula
// vazamento por print/foto de tela, padrão Box/Dropbox/Egnyte (ADENDO-09 §12.4.2).
// É um dissuasor client-side, não DRM real: não impede download nem captura,
// só identifica quem estava vendo o documento se a captura vazar.
function getWatermarkLabel(): string {
  const when = new Date().toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  try {
    const stored = localStorage.getItem("docke_user");
    const u = stored ? JSON.parse(stored) : null;
    const who = u?.email || u?.full_name || u?.username;
    return who ? `${who} · ${when}` : when;
  } catch {
    return when;
  }
}

function PreviewWatermark({ label }: { label: string }) {
  return (
    <div className="absolute inset-0 z-10 overflow-hidden pointer-events-none select-none" aria-hidden="true">
      <div
        className="absolute flex flex-wrap content-start gap-x-14 gap-y-14 origin-center"
        style={{ inset: "-30%", transform: "rotate(-30deg)" }}
      >
        {Array.from({ length: 48 }).map((_, i) => (
          <span key={i} className="text-mac-caption font-medium whitespace-nowrap text-[var(--text-primary)] opacity-[0.06]">
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function XmlField({ label, value, mono, span }: { label: string; value: string; mono?: boolean; span?: boolean }) {
  return (
    <div className={span ? "col-span-2" : undefined}>
      <dt className="text-mac-caption text-[var(--text-secondary)]">{label}</dt>
      <dd className={`text-mac-body text-[var(--text-primary)] mt-0.5 break-words ${mono ? "font-mono text-mac-caption" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

export default function PreviewModal({ doc, onClose }: PreviewModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  const [url, setUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [xmlFields, setXmlFields] = useState<XmlFields | null>(null);
  const [showRawXml, setShowRawXml] = useState(false);
  const [watermarkLabel] = useState(getWatermarkLabel);

  // Fase 12.3: busca dentro do documento (ocr_text) — search bar opcional,
  // fechada por padrão pra não competir visualmente com o preview.
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const previewBodyRef = useRef<HTMLDivElement>(null);

  const type = resolveType(doc.name, doc.mime_type);
  const isXml = doc.name.toLowerCase().endsWith(".xml") || doc.mime_type === "application/xml";
  const { icon: Icon, iconColor } = getFileStyle(doc.name);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    if (type === "unsupported") { setLoading(false); return; }

    if (type === "text") {
      // Texto/XML/CSV: sempre via download-url (Content-Disposition não importa,
      // o conteúdo é lido via fetch e renderizado num <pre>, não carregado pelo browser).
      api.get<{ download_url: string }>(`/documents/${doc.id}/download-url`)
        .then(async ({ data }) => {
          const resp = await fetch(data.download_url);
          if (!resp.ok) throw new Error("Erro ao carregar arquivo.");
          const txt = await resp.text();
          setTextContent(txt.slice(0, 50_000)); // cap at 50k chars
        })
        .catch((e) => setError(e?.message ?? "Erro ao carregar preview."))
        .finally(() => setLoading(false));
      return;
    }

    // PDF/imagem: preview-url, que usa Content-Disposition: inline — download-url
    // forçaria o browser a baixar o arquivo em vez de exibi-lo no iframe/<img>.
    api.get<{ inline: boolean; preview_url: string | null; message?: string }>(`/documents/${doc.id}/preview-url`)
      .then(({ data }) => {
        if (!data.inline || !data.preview_url) {
          setError(data.message ?? "Arquivo grande demais para pré-visualização inline.");
          return;
        }
        setUrl(data.preview_url);
      })
      .catch((e) => setError(e?.message ?? "Erro ao carregar preview."))
      .finally(() => setLoading(false));
  }, [doc.id, type]);

  useEffect(() => {
    if (!isXml) return;
    api.get<XmlFields>(`/documents/${doc.id}/xml-fields`)
      .then(({ data }) => setXmlFields(data))
      .catch(() => setXmlFields(null));
  }, [doc.id, isXml]);

  // Fase 12.3: pra PDF/imagem o texto pesquisável vem do ocr_text (não temos
  // outro jeito de "ler" o conteúdo de um canvas); pra tipo "text" já usa o
  // textContent que o preview normal já buscou, sem round-trip extra.
  useEffect(() => {
    if (type !== "pdf" && type !== "image") return;
    api.get<{ ocr_text: string | null; ocr_status: string }>(`/documents/${doc.id}`)
      .then(({ data }) => setOcrText(data.ocr_text ?? null))
      .catch(() => setOcrText(null));
  }, [doc.id, type]);

  const searchableText = type === "text" ? textContent : ocrText;
  const matches = useMemo(() => findMatches(searchableText ?? "", searchQuery), [searchableText, searchQuery]);

  useEffect(() => { setActiveMatch(0); }, [searchQuery]);

  useEffect(() => {
    if (matches.length === 0 || type !== "text") return;
    const el = previewBodyRef.current?.querySelector(`[data-match-index="${activeMatch}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeMatch, matches.length, type]);

  // Fase 12.3: monta os segmentos do <pre> com <mark> nas ocorrências — a
  // ocorrência ativa (navegação prev/next) ganha um destaque mais forte.
  const highlightedTextNodes = useMemo(() => {
    if (!searchableText || matches.length === 0) return null;
    const q = searchQuery.trim();
    const parts: JSX.Element[] = [];
    let cursor = 0;
    matches.forEach((m, i) => {
      if (m.index > cursor) parts.push(<span key={`t${i}`}>{searchableText.slice(cursor, m.index)}</span>);
      parts.push(
        <mark
          key={`m${i}`}
          data-match-index={i}
          className={i === activeMatch ? "bg-amber-400 text-black rounded-[2px]" : "bg-amber-200/60 dark:bg-amber-500/30 rounded-[2px]"}
        >
          {searchableText.slice(m.index, m.index + q.length)}
        </mark>
      );
      cursor = m.index + q.length;
    });
    if (cursor < searchableText.length) parts.push(<span key="tail">{searchableText.slice(cursor)}</span>);
    return parts;
  }, [searchableText, matches, activeMatch, searchQuery]);

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
    <Portal>
    <div
      className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={containerRef}
        className="modal-card glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal flex flex-col w-full max-w-4xl"
        style={{ height: "min(90vh, 760px)" }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-[var(--border-default)] flex-shrink-0">
          <Icon className={`w-5 h-5 flex-shrink-0 ${iconColor}`} strokeWidth={1.5} />
          <span
            className="flex-1 text-mac-body font-medium text-[var(--text-primary)] truncate"
            title={doc.name}
          >
            {doc.name}
          </span>
          {!!searchableText && (
            <button
              onClick={() => setSearchOpen((v) => !v)}
              className={`p-1.5 rounded-[6px] transition-colors duration-fast ${searchOpen ? "bg-teal-500/15 text-teal-500" : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"}`}
              aria-label="Buscar no documento"
              title="Buscar no documento (usa o texto extraído por OCR)"
            >
              <Search className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={download}
            className="flex items-center gap-1.5 h-8 px-3 text-mac-caption border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
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

        {/* Fase 12.3: barra de busca dentro do documento */}
        {searchOpen && !!searchableText && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-[var(--border-default)] flex-shrink-0">
            <Search className="w-3.5 h-3.5 text-[var(--text-tertiary)] flex-shrink-0" />
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && matches.length > 0) {
                  setActiveMatch((i) => (e.shiftKey ? (i - 1 + matches.length) % matches.length : (i + 1) % matches.length));
                }
              }}
              placeholder="Buscar no texto extraído (OCR)…"
              className="flex-1 h-7 px-2 text-mac-caption bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[6px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[2px] focus:ring-teal-500/70"
            />
            {searchQuery.trim() && (
              <span className="text-mac-caption text-[var(--text-tertiary)] tabular-nums flex-shrink-0">
                {matches.length === 0 ? "0 resultados" : `${activeMatch + 1} de ${matches.length}`}
              </span>
            )}
            <button
              onClick={() => setActiveMatch((i) => (i - 1 + matches.length) % matches.length)}
              disabled={matches.length === 0}
              className="h-6 w-6 flex items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-fast flex-shrink-0"
              aria-label="Resultado anterior"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setActiveMatch((i) => (i + 1) % matches.length)}
              disabled={matches.length === 0}
              className="h-6 w-6 flex items-center justify-center rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-30 disabled:pointer-events-none transition-colors duration-fast flex-shrink-0"
              aria-label="Próximo resultado"
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

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
              <p className="text-mac-body text-[var(--text-secondary)]">{error}</p>
            </div>
          )}

          {!loading && !error && type === "unsupported" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-8">
              <Icon className={`w-12 h-12 ${iconColor}`} strokeWidth={1.5} />
              <p className="text-mac-body text-[var(--text-secondary)]">
                Nenhuma visualização disponível para este tipo de arquivo.
              </p>
              <button
                onClick={download}
                className="flex items-center gap-1.5 h-9 px-4 text-mac-body bg-teal-600 text-white rounded-[var(--radius-control)] hover:bg-teal-500 transition-colors duration-fast"
              >
                <Download className="w-4 h-4" />
                Fazer download para abrir
              </button>
            </div>
          )}

          {!loading && !error && type !== "unsupported" && <PreviewWatermark label={watermarkLabel} />}

          {/* Fase 12.2: PdfViewer real (canvas próprio, sem toolbar nativa do
              navegador) — o bucket R2 já libera CORS o bastante pro fetch()
              do pdf.js funcionar (confirmado ao vivo), então o <iframe> (que
              caía no visualizador nativo cinza do Chrome/Edge, a coisa mais
              "isso não parece um site de verdade" do app inteiro) não é
              mais necessário. */}
          {!loading && !error && type === "pdf" && url && (
            <PdfViewer url={url} />
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

          {/* Fase 12.3: PDF/imagem renderizam em <canvas>/<img> (sem texto
              selecionável), então a busca mostra os trechos batidos como
              lista de contexto — não dá pra "pular" pra posição exata sem
              coordenadas de OCR por página, que não guardamos hoje. */}
          {!loading && !error && (type === "pdf" || type === "image") && searchOpen && searchQuery.trim() && (
            <div className="absolute bottom-3 right-3 left-3 sm:left-auto sm:w-80 max-h-56 overflow-y-auto glass-panel glass-blur-strong rounded-[var(--radius-panel)] shadow-modal p-2 space-y-1 z-20">
              {matches.length === 0 ? (
                <p className="text-mac-caption text-[var(--text-tertiary)] px-2 py-1">Nenhuma ocorrência no texto extraído por OCR.</p>
              ) : (
                matches.map((m, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveMatch(i)}
                    className={`w-full text-left px-2 py-1.5 rounded-[6px] text-mac-caption transition-colors duration-fast ${
                      i === activeMatch ? "bg-teal-500/15 text-[var(--text-primary)]" : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    {m.snippet}
                  </button>
                ))
              )}
            </div>
          )}

          {!loading && !error && type === "text" && textContent !== null && isXml && xmlFields?.recognized && !showRawXml && (
            <div className="w-full h-full overflow-auto p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-mac-body font-medium text-[var(--text-primary)]">Nota fiscal eletrônica</p>
                <button
                  onClick={() => setShowRawXml(true)}
                  className="px-2.5 py-1 rounded-full text-mac-caption text-teal-500 hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                >
                  Ver XML bruto
                </button>
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
                <XmlField label="Número" value={xmlFields.numero ?? "—"} />
                <XmlField label="Série" value={xmlFields.serie ?? "—"} />
                <XmlField label="Data de emissão" value={fmtXmlDate(xmlFields.data_emissao)} />
                <XmlField label="Valor total" value={fmtCurrency(xmlFields.valor_total)} />
                <XmlField label="Natureza da operação" value={xmlFields.natureza_operacao ?? "—"} span />
                <XmlField label="Emitente" value={xmlFields.emitente_nome ?? "—"} span />
                <XmlField label="CNPJ emitente" value={fmtCnpj(xmlFields.emitente_cnpj)} />
                <XmlField label="Destinatário" value={xmlFields.destinatario_nome ?? "—"} span />
                <XmlField label="CNPJ/CPF destinatário" value={fmtCnpj(xmlFields.destinatario_cnpj)} />
                <XmlField label="Chave de acesso" value={xmlFields.chave_acesso ?? "—"} mono span />
              </dl>
            </div>
          )}

          {!loading && !error && type === "text" && textContent !== null && (!isXml || !xmlFields?.recognized || showRawXml) && (
            <div ref={previewBodyRef} className="w-full h-full overflow-auto">
              {isXml && xmlFields?.recognized && (
                <div className="sticky top-0 bg-[var(--bg-card)] border-b border-[var(--border-default)] px-5 py-2 flex justify-end">
                  <button
                    onClick={() => setShowRawXml(false)}
                    className="px-2.5 py-1 rounded-full text-mac-caption text-teal-500 hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                  >
                    Ver campos extraídos
                  </button>
                </div>
              )}
              <pre className="p-5 text-mac-caption font-mono text-[var(--text-secondary)] leading-relaxed whitespace-pre-wrap break-words">
                {highlightedTextNodes ?? textContent}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
    </Portal>
  );
}
