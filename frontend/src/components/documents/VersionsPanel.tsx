import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { History, Upload, Download, RotateCcw, Trash2, ChevronDown, GitCompare, Loader2, Eye, MoreHorizontal, Tag, ChevronUp, X, Lock, Printer } from "lucide-react";
import api from "@/lib/api";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { useToast } from "@/lib/toast";
import { useTaskCenter } from "@/lib/TaskContext";
import { relativeDate, fullDate } from "@/lib/date";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import Menu from "@/components/ui/Menu";
import { diffToText, type DiffLine, type DiffResult } from "@/lib/diff";

const PdfViewer = lazy(() => import("./PdfViewer"));

interface Version {
  id: string;
  version_number: number;
  size_bytes: number;
  mime_type: string;
  created_at: string;
  uploaded_by_name: string | null;
  is_current: boolean;
  /** Impressão digital (SHA-256) desta versão; nula nas enviadas antes do registro por versão. */
  sha256?: string | null;
  /** Nome dado à versão ("aprovada pelo jurídico"). */
  label?: string | null;
}

const MAX_VERSIONS = 10;

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

const versionTitle = (v: Version) => `Versão ${v.version_number}${v.label ? ` · ${v.label}` : ""}`;
const versionMeta = (v: Version) => `${fullDate(v.created_at)}${v.uploaded_by_name ? `, ${v.uploaded_by_name}` : ""}`;

/** Linha com realce da palavra alterada (A5-72). */
function LineText({ line }: { line: DiffLine }) {
  if (!line.parts) return <>{line.text || " "}</>;
  return (
    <>
      {line.parts.map((p, i) => p.changed
        ? <mark key={i} className={`rounded-(--radius-hair) px-px text-(--text-primary) ${line.type === "add" ? "bg-emerald-500/40" : "bg-red-500/40"}`}>{p.text}</mark>
        : <span key={i}>{p.text}</span>)}
    </>
  );
}

/**
 * Comparação entre duas versões (A5-71..A5-76): texto do arquivo (TXT, CSV,
 * XML) ou texto extraído (PDF, DOCX, XLSX, imagem com OCR); realce por
 * palavra; resumo; "só mudanças"; anterior/próxima mudança; baixar o
 * resultado. O cálculo roda num Web Worker.
 */
/**
 * Sobreposição com opacidade (B2.7.6): para plantas, fotos e imagens, a
 * versão nova por cima da antiga, com o controle de transparência.
 */
function ImageOverlay({ documentId, documentName, older, newer }: { documentId: string; documentName: string; older: Version; newer: Version }) {
  const [urls, setUrls] = useState<[string, string] | null>(null);
  const [falhou, setFalhou] = useState(false);
  const [opacidade, setOpacidade] = useState(50);
  useEffect(() => {
    Promise.all([older, newer].map((v) => api.get<{ download_url: string }>(`/documents/${documentId}/versions/${v.id}/download-url`, { params: { inline: true } })))
      .then(([a, b]) => setUrls([a.data.download_url, b.data.download_url])).catch(() => setFalhou(true));
  }, [documentId, older.id, newer.id]);
  if (falhou) return <p role="alert" className="p-8 text-center text-mac-body text-(--text-secondary)">Não foi possível carregar as imagens agora.</p>;
  if (!urls) return <div className="h-full flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-(--text-secondary)" aria-label="Carregando" /></div>;
  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 border-b border-(--border-default) text-mac-caption text-(--text-secondary)">
        <span>Versão {older.version_number}</span>
        <input type="range" min={0} max={100} value={opacidade} onChange={(e) => setOpacidade(Number(e.target.value))}
          aria-label={`Transparência da versão ${newer.version_number} por cima da ${older.version_number}`} className="flex-1 min-w-32 accent-teal-600" />
        <span>Versão {newer.version_number} ({opacidade}%)</span>
      </div>
      <div className="relative flex-1 min-h-0 overflow-auto p-4">
        <div className="relative mx-auto w-fit">
          <img src={urls[0]} alt={`${documentName}, versão ${older.version_number}`} className="block max-w-full max-h-[52vh] object-contain" />
          <img src={urls[1]} alt={`${documentName}, versão ${newer.version_number}, por cima`} style={{ opacity: opacidade / 100 }}
            className="absolute inset-0 w-full h-full object-contain" />
        </div>
      </div>
    </div>
  );
}

/** O que mudou, por parte (B2.7.5): arquivo, páginas, anotações e metadados. */
interface Partes {
  arquivo: { tamanho_antes: number; tamanho_depois: number; identico: boolean };
  paginas: { antes: number; depois: number; alteradas: number[]; incluidas: number[]; removidas: number[] } | null;
  anotacoes: { antes: { body: string; page: number | null }[]; depois: { body: string; page: number | null }[] };
  metadados: { created_at: string; autor: string | null; campo: string | null; antes: string | null; depois: string | null }[];
}

function ResumoPartes({ documentId, a, b }: { documentId: string; a: string; b: string }) {
  const [p, setP] = useState<Partes | null>(null);
  const [aberto, setAberto] = useState(false);
  useEffect(() => {
    api.get<Partes>(`/documents/${documentId}/versions/compare-summary`, { params: { a, b } }).then((r) => setP(r.data)).catch(() => setP(null));
  }, [documentId, a, b]);
  if (!p) return null;
  const lista = (ns: number[]) => (ns.length > 6 ? `${ns.slice(0, 6).join(", ")} e mais ${ns.length - 6}` : ns.join(", "));
  const pag = p.paginas;
  const textoPag = !pag ? null
    : pag.alteradas.length + pag.incluidas.length + pag.removidas.length === 0 ? `Páginas: ${pag.depois}, sem mudança de texto`
    : [`Páginas: ${pag.antes} → ${pag.depois}`, pag.alteradas.length ? `texto mudou na ${lista(pag.alteradas)}` : "", pag.incluidas.length ? `entraram ${lista(pag.incluidas)}` : "", pag.removidas.length ? `saíram ${lista(pag.removidas)}` : ""].filter(Boolean).join("; ");
  const textoAnot = `Anotações: ${p.anotacoes.antes.length} na anterior, ${p.anotacoes.depois.length} nesta`;
  const textoMeta = p.metadados.length ? `Metadados: ${p.metadados.length} ${p.metadados.length === 1 ? "alteração" : "alterações"} entre as duas` : "Metadados: sem alteração entre as duas";
  return (
    <div className="px-4 py-2 border-b border-(--border-default) text-mac-caption">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-(--text-secondary)" aria-label="O que mudou, por parte">
        <li>{p.arquivo.identico ? "Arquivo idêntico (mesma impressão digital)" : `Arquivo: ${fmtSize(p.arquivo.tamanho_antes)} → ${fmtSize(p.arquivo.tamanho_depois)}`}</li>
        {textoPag && <li>{textoPag}</li>}
        <li>{textoAnot}</li>
        <li>{textoMeta}</li>
      </ul>
      {(p.metadados.length > 0 || p.anotacoes.antes.length + p.anotacoes.depois.length > 0) && (
        <button type="button" onClick={() => setAberto((v) => !v)} aria-expanded={aberto} className="mt-1 text-(--text-accent) hover:underline">{aberto ? "Esconder detalhes" : "Ver detalhes"}</button>
      )}
      {aberto && (
        <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-3 text-(--text-primary)">
          {p.metadados.length > 0 && (
            <ul className="space-y-0.5">{p.metadados.map((m, i) => <li key={i}>{m.campo}: “{m.antes ?? "vazio"}” → “{m.depois ?? "vazio"}”{m.autor ? ` (${m.autor})` : ""}</li>)}</ul>
          )}
          <ul className="space-y-0.5">
            {p.anotacoes.antes.map((x, i) => <li key={`a${i}`}>Anterior{x.page ? `, pág. ${x.page}` : ""}: {x.body}</li>)}
            {p.anotacoes.depois.map((x, i) => <li key={`d${i}`}>Esta{x.page ? `, pág. ${x.page}` : ""}: {x.body}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Lado a lado (B1.4.4, B2.7.3): versão antiga à esquerda e nova à direita,
 * linha a linha na mesma grade. A rolagem é uma só, então as duas colunas
 * andam juntas; em cada bloco de mudança, o que saiu fica em frente ao que
 * entrou no lugar.
 */
function LadoALado({ lines, visible, older, newer, cursorLine }: {
  lines: DiffLine[]; visible: (number | "gap")[]; older: number; newer: number; cursorLine?: number;
}) {
  const mostrar = new Set(visible.filter((v): v is number => v !== "gap"));
  type Celula = { i: number; l: DiffLine } | null;
  const linhas: { esq: Celula; dir: Celula }[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].type === "same") { linhas.push({ esq: { i, l: lines[i] }, dir: { i, l: lines[i] } }); i++; continue; }
    const rem: Celula[] = [], add: Celula[] = [];
    while (i < lines.length && lines[i].type !== "same") { (lines[i].type === "remove" ? rem : add).push({ i, l: lines[i] }); i++; }
    for (let k = 0; k < Math.max(rem.length, add.length); k++) linhas.push({ esq: rem[k] ?? null, dir: add[k] ?? null });
  }
  const cel = (c: Celula, lado: "esq" | "dir") => (
    <div data-line={c?.i} className={`px-3 whitespace-pre-wrap break-words min-h-5 ${!c ? "bg-(--bg-hover)/40" : c.l.type === "add" ? "bg-(--tint-success)" : c.l.type === "remove" ? "bg-(--tint-danger)" : ""} ${lado === "esq" ? "border-r border-(--border-default)" : ""} ${c && cursorLine === c.i ? "ring-2 ring-inset ring-(--focus-ring)" : ""}`}>
      {c && c.l.type !== "same" && <span className="sr-only">{c.l.type === "add" ? "Entrou: " : "Saiu: "}</span>}
      {c ? <span className={c.l.type === "same" ? "text-(--text-secondary)" : "text-(--text-primary)"}><LineText line={c.l} /></span> : null}
    </div>
  );
  let anterior = true;
  return (
    <div className="text-mac-caption font-mono leading-relaxed">
      <div className="sticky top-0 z-[1] grid grid-cols-2 bg-(--bg-card) border-b border-(--border-default) text-(--text-secondary) font-sans font-semibold">
        <div className="px-3 py-1.5 border-r border-(--border-default)">Versão {older}</div>
        <div className="px-3 py-1.5">Versão {newer}</div>
      </div>
      {linhas.map((r, k) => {
        const ve = (r.esq && mostrar.has(r.esq.i)) || (r.dir && mostrar.has(r.dir.i));
        const gap = !ve && anterior;
        anterior = !!ve;
        if (!ve) return gap ? <div key={`g${k}`} className="my-1 px-4 text-(--text-secondary) select-none" aria-hidden="true">⋯</div> : null;
        return <div key={k} className="grid grid-cols-2">{cel(r.esq, "esq")}{cel(r.dir, "dir")}</div>;
      })}
    </div>
  );
}

/** Resultado de cada par de versões, guardado na aba (B2.7.10). */
const diffCache = new Map<string, DiffResult | { motivo: string }>();

function DiffModal({ documentId, documentName, versionA, versionB, onClose }: {
  documentId: string; documentName: string; versionA: Version; versionB: Version; onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [tipoMudanca, setTipoMudanca] = useState<"todas" | "add" | "remove">("todas");
  // B2.7.2: por linha ou por frase; B1.4.4/B2.7.3: em sequência ou lado a lado.
  const [unidade, setUnidade] = useState<"linha" | "frase">("linha");
  const [lado, setLado] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [older, newer] = versionA.version_number < versionB.version_number ? [versionA, versionB] : [versionB, versionA];
  const imagens = older.mime_type.startsWith("image/") && newer.mime_type.startsWith("image/");
  const [modo, setModo] = useState<"texto" | "sobrepor">(imagens ? "sobrepor" : "texto");

  useEffect(() => {
    const chave = `${older.id}:${newer.id}:${unidade}`;
    setUnavailableReason(null);
    const cached = diffCache.get(chave);
    if (cached) {
      if ("motivo" in cached) setUnavailableReason(cached.motivo);
      else { if (!cached.lines) setUnavailableReason("As duas versões são diferentes demais para comparar linha a linha. Abra cada uma no visualizador."); setResult(cached); }
      setLoading(false);
      return;
    }
    setLoading(true);
    let worker: Worker | null = null;
    let alive = true;
    type Content = { available: boolean; text: string | null; reason: string | null };
    Promise.all([
      api.get<Content>(`/documents/${documentId}/versions/${older.id}/content`),
      api.get<Content>(`/documents/${documentId}/versions/${newer.id}/content`),
    ])
      .then(([a, b]) => {
        if (!alive) return;
        if (!a.data.available || !b.data.available) {
          const motivo = a.data.reason ?? b.data.reason ?? "Comparação não disponível.";
          diffCache.set(chave, { motivo });
          setUnavailableReason(motivo);
          setLoading(false);
          return;
        }
        worker = new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e: MessageEvent<DiffResult>) => {
          if (!alive) return;
          if (!e.data.lines) setUnavailableReason("As duas versões são diferentes demais para comparar linha a linha. Abra cada uma no visualizador.");
          diffCache.set(chave, e.data);
          setResult(e.data);
          setLoading(false);
        };
        worker.onerror = () => { setUnavailableReason("Não foi possível comparar agora. Tente de novo."); setLoading(false); };
        worker.postMessage({ a: a.data.text ?? "", b: b.data.text ?? "", unit: unidade });
      })
      .catch(() => { if (alive) { setUnavailableReason("Não foi possível carregar o conteúdo das versões."); setLoading(false); } });
    return () => { alive = false; worker?.terminate(); };
  }, [documentId, older.id, newer.id, unidade]);

  const lines = result?.lines ?? null;
  // Índices das linhas mudadas e, no modo "só mudanças", o que fica visível (2 de contexto).
  const { visible, changeStarts } = useMemo(() => {
    if (!lines) return { visible: [] as (number | "gap")[], changeStarts: [] as number[] };
    const conta = (t: string) => t !== "same" && (tipoMudanca === "todas" || t === tipoMudanca);
    const changeStarts: number[] = [];
    lines.forEach((l, i) => { if (conta(l.type) && (i === 0 || !conta(lines[i - 1].type))) changeStarts.push(i); });
    if (!onlyChanges && tipoMudanca === "todas") return { visible: lines.map((_, i) => i), changeStarts };
    const keep = new Set<number>();
    lines.forEach((l, i) => {
      if (!conta(l.type)) return;
      const ctx = onlyChanges ? 2 : 0;
      for (let k = i - ctx; k <= i + ctx; k++) if (k >= 0 && k < lines.length && (lines[k].type === "same" || conta(lines[k].type))) keep.add(k);
    });
    const visible: (number | "gap")[] = [];
    let last = -1;
    [...keep].sort((x, y) => x - y).forEach((i) => { if (last >= 0 && i > last + 1) visible.push("gap"); visible.push(i); last = i; });
    return { visible, changeStarts };
  }, [lines, onlyChanges, tipoMudanca]);

  function goChange(delta: number) {
    if (!changeStarts.length) return;
    const next = Math.min(changeStarts.length - 1, Math.max(0, cursor + delta));
    setCursor(next);
    bodyRef.current?.querySelector(`[data-line="${changeStarts[next]}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function exportText() {
    if (!lines) return;
    const header = `${documentName}\nVersão ${older.version_number} (${versionMeta(older)}) → versão ${newer.version_number} (${versionMeta(newer)})`;
    const blob = new Blob([diffToText(lines, header)], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `comparacao_v${older.version_number}_v${newer.version_number}_${documentName.replace(/\.[^.]+$/, "")}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /**
   * PDF com marcações (B2.7.8): a comparação vai para a impressão do
   * navegador com verde no que entrou e vermelho riscado no que saiu; "Salvar
   * como PDF" na janela de impressão gera o arquivo.
   */
  function exportPdf() {
    if (!lines) return;
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const corpo = lines.map((l) => {
      const cls = l.type === "add" ? "add" : l.type === "remove" ? "rem" : "";
      const sinal = l.type === "add" ? "+" : l.type === "remove" ? "−" : " ";
      return `<div class="l ${cls}"><span class="s">${sinal}</span>${esc(l.text) || "&nbsp;"}</div>`;
    }).join("");
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Comparação ${esc(documentName)}</title>
<style>
  body{font:12px/1.5 -apple-system,"Segoe UI",Inter,sans-serif;color:#1d1d1f;margin:24px}
  h1{font-size:15px;margin:0 0 4px} p{margin:0 0 12px;color:#555}
  .l{font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;padding:0 6px}
  .s{display:inline-block;width:14px;color:#888}
  .add{background:#e3f7e8} .add .s{color:#1f7a3a}
  .rem{background:#fde8e8;text-decoration:line-through} .rem .s{color:#b42318}
  @page{margin:16mm}
</style></head><body>
<h1>${esc(documentName)}</h1>
<p>Versão ${older.version_number} (${esc(versionMeta(older))}) → versão ${newer.version_number} (${esc(versionMeta(newer))}). ${esc(summary ?? "")}</p>
${corpo}</body></html>`;
    const quadro = document.createElement("iframe");
    Object.assign(quadro.style, { position: "fixed", width: "0", height: "0", border: "0" });
    document.body.appendChild(quadro);
    const d = quadro.contentDocument;
    if (!d) { quadro.remove(); return; }
    d.open(); d.write(html); d.close();
    window.setTimeout(() => {
      try { quadro.contentWindow?.focus(); quadro.contentWindow?.print(); } finally { window.setTimeout(() => quadro.remove(), 60_000); }
    }, 100);
  }

  const summary = result && lines
    ? [
        result.changed ? `${result.changed} ${result.changed === 1 ? "linha alterada" : "linhas alteradas"}` : "",
        result.added ? `${result.added} ${result.added === 1 ? "entrou" : "entraram"}` : "",
        result.removed ? `${result.removed} ${result.removed === 1 ? "saiu" : "saíram"}` : "",
      ].filter(Boolean).join(" · ") || "Nenhuma diferença de texto"
    : null;

  return (
    <Dialog onClose={onClose} size="xl" className="bg-(--bg-card)!"
      title={`Versão ${older.version_number} → versão ${newer.version_number}`}
      description={`${versionTitle(older)} (${versionMeta(older)}) comparada com ${versionTitle(newer)} (${versionMeta(newer)}).`}
      bodyClassName="p-0! flex flex-col"
      footer={lines ? (
        <>
          <Button variant="secondary" onClick={exportPdf}><Printer className="w-3.5 h-3.5" aria-hidden="true" /> Imprimir ou PDF</Button>
          <Button variant="secondary" onClick={exportText}><Download className="w-3.5 h-3.5" aria-hidden="true" /> Baixar comparação</Button>
          <Button onClick={onClose}>Fechar</Button>
        </>
      ) : undefined}>
      <ResumoPartes documentId={documentId} a={older.id} b={newer.id} />
      {summary && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-(--border-default)">
          <p role="status" className="flex-1 min-w-[12rem] text-mac-caption font-medium text-(--text-primary)">{summary}</p>
          {changeStarts.length > 0 && (
            <>
              <label className="inline-flex items-center gap-1.5 text-mac-caption text-(--text-secondary)">
                <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} className="accent-teal-600 w-4 h-4" /> Só as mudanças
              </label>
              <div role="tablist" aria-label="Comparar por" className="mac-segmented">
                {([["linha", "Linha"], ["frase", "Frase"]] as const).map(([v, l]) => (
                  <button key={v} role="tab" aria-selected={unidade === v} onClick={() => { setUnidade(v); setCursor(-1); }} className="mac-segment">{l}</button>
                ))}
              </div>
              <div role="tablist" aria-label="Arrumação" className="mac-segmented">
                <button role="tab" aria-selected={!lado} onClick={() => setLado(false)} className="mac-segment">Em sequência</button>
                <button role="tab" aria-selected={lado} onClick={() => setLado(true)} className="mac-segment">Lado a lado</button>
              </div>
              <div role="tablist" aria-label="Tipo de mudança" className="mac-segmented">
                {([["todas", "Todas"], ["add", "Entrou"], ["remove", "Saiu"]] as const).map(([v, l]) => (
                  <button key={v} role="tab" aria-selected={tipoMudanca === v} onClick={() => { setTipoMudanca(v); setCursor(-1); }} className="mac-segment">{l}</button>
                ))}
              </div>
              <span className="text-mac-caption text-(--text-secondary) tabular-nums" aria-live="polite">{cursor >= 0 ? `${cursor + 1} de ${changeStarts.length}` : `${changeStarts.length} ${changeStarts.length === 1 ? "trecho" : "trechos"}`}</span>
              <button onClick={() => goChange(-1)} aria-label="Mudança anterior" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><ChevronUp className="w-4 h-4" aria-hidden="true" /></button>
              <button onClick={() => goChange(1)} aria-label="Próxima mudança" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><ChevronDown className="w-4 h-4" aria-hidden="true" /></button>
            </>
          )}
        </div>
      )}
      {imagens && (
        <div className="px-4 pt-2">
          <div role="tablist" aria-label="Modo de comparação" className="mac-segmented">
            {([["sobrepor", "Sobrepor imagens"], ["texto", "Texto lido"]] as const).map(([v, l]) => (
              <button key={v} role="tab" aria-selected={modo === v} onClick={() => setModo(v)} className="mac-segment">{l}</button>
            ))}
          </div>
        </div>
      )}
      <div ref={bodyRef} className="h-[min(62vh,560px)] overflow-auto">
        {imagens && modo === "sobrepor" ? (
          <ImageOverlay documentId={documentId} documentName={documentName} older={older} newer={newer} />
        ) : loading ? (
          <div className="h-full flex items-center justify-center gap-2 text-mac-body text-(--text-secondary)" role="status"><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> Comparando…</div>
        ) : unavailableReason ? (
          <div className="h-full flex items-center justify-center px-8 text-center"><p className="text-mac-body text-(--text-secondary)">{unavailableReason}</p></div>
        ) : lines && changeStarts.length === 0 ? (
          <div className="h-full flex items-center justify-center px-8 text-center"><p className="text-mac-body text-(--text-secondary)">Nenhuma diferença de texto entre estas duas versões.</p></div>
        ) : lines && lado ? (
          <LadoALado lines={lines} visible={visible} older={older.version_number} newer={newer.version_number} cursorLine={changeStarts[cursor]} />
        ) : lines && (
          <div className="py-2 text-mac-caption font-mono leading-relaxed">
            {visible.map((v, k) => v === "gap" ? (
              <div key={`g${k}`} className="my-1 px-4 text-(--text-secondary) select-none" aria-hidden="true">⋯</div>
            ) : (
              <div key={v} data-line={v}
                className={`flex gap-2 px-4 whitespace-pre-wrap break-words ${lines[v].type === "add" ? "bg-(--tint-success)" : lines[v].type === "remove" ? "bg-(--tint-danger)" : ""} ${changeStarts[cursor] === v ? "ring-2 ring-inset ring-(--focus-ring)" : ""}`}>
                <span aria-hidden="true" className={`w-3 shrink-0 select-none ${lines[v].type === "add" ? "text-(--text-success)" : lines[v].type === "remove" ? "text-(--text-danger)" : "text-(--text-secondary)"}`}>{lines[v].type === "add" ? "+" : lines[v].type === "remove" ? "−" : ""}</span>
                {lines[v].type !== "same" && <span className="sr-only">{lines[v].type === "add" ? "Entrou: " : "Saiu: "}</span>}
                <span className={`flex-1 ${lines[v].type === "same" ? "text-(--text-secondary)" : "text-(--text-primary)"}`}><LineText line={lines[v]} /></span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Abre uma versão antiga no visualizador, sem baixar (A5-66). */
function ViewVersionDialog({ documentId, documentName, version, onClose }: { documentId: string; documentName: string; version: Version; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const isPdf = version.mime_type === "application/pdf";
  const isImage = version.mime_type.startsWith("image/");
  useEffect(() => {
    if (!isPdf && !isImage) return;
    api.get<{ download_url: string }>(`/documents/${documentId}/versions/${version.id}/download-url`, { params: { inline: true } })
      .then((r) => setUrl(r.data.download_url)).catch(() => setFailed(true));
  }, [documentId, version.id, isPdf, isImage]);
  return (
    <Dialog onClose={onClose} size="full" className="bg-(--bg-card)!" title={`${documentName} · ${versionTitle(version)}`} description={versionMeta(version)} bodyClassName="p-0! overflow-hidden! flex flex-col">
      {/* Versão antiga é só para ler (B2.7.9): o aviso fica à vista o tempo todo. */}
      <p role="note" className="shrink-0 flex items-center gap-2 px-4 py-1.5 bg-(--tint-warning) text-mac-caption text-(--text-primary) border-b border-(--border-default)">
        <Lock className="w-3.5 h-3.5 text-(--text-warning) shrink-0" aria-hidden="true" />
        Você está vendo a versão {version.version_number}{version.label ? ` (${version.label})` : ""}, somente leitura. Para voltar a ela, use “Restaurar como atual…” no menu dela.
      </p>
      <div className="flex-1 min-h-0 bg-(--bg-page)">
        {!isPdf && !isImage ? (
          <p className="p-8 text-center text-mac-body text-(--text-secondary)">Este formato não abre no visualizador. Baixe a versão pelo menu dela.</p>
        ) : failed ? (
          <p role="alert" className="p-8 text-center text-mac-body text-(--text-secondary)">Não foi possível abrir esta versão agora. Tente de novo.</p>
        ) : !url ? (
          <div className="h-full flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-(--text-secondary)" aria-label="Carregando" /></div>
        ) : isPdf ? (
          <Suspense fallback={<div className="h-full flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-(--text-secondary)" aria-label="Carregando" /></div>}>
            <PdfViewer url={url} rememberKey={`${documentId}:v${version.version_number}`} />
          </Suspense>
        ) : (
          <div className="h-full overflow-auto flex items-center justify-center p-4"><img src={url} alt={`${documentName}, ${versionTitle(version)}`} className="max-w-full max-h-full object-contain" /></div>
        )}
      </div>
    </Dialog>
  );
}

function NameDialog({ version, onClose, onSave }: { version: Version; onClose: () => void; onSave: (label: string) => Promise<void> }) {
  const [label, setLabel] = useState(version.label ?? "");
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await onSave(label); onClose(); } finally { setBusy(false); } }
  return (
    <Dialog onClose={onClose} size="sm" busy={busy} title={`Nome da versão ${version.version_number}`}
      description="Ajuda a achar a versão certa depois (ex.: aprovada pelo jurídico, enviada ao cliente). Deixe vazio para tirar o nome."
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={busy} onClick={save}>Salvar</Button></>}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <Input label="Nome" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} autoFocus placeholder="Ex.: Aprovada pelo jurídico" />
      </form>
    </Dialog>
  );
}

export default function VersionsPanel({ documentId, documentName, onChanged }: { documentId: string; documentName: string; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const { addTask, updateTask } = useTaskCenter();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [diffPair, setDiffPair] = useState<[Version, Version] | null>(null);
  const [pickFor, setPickFor] = useState<Version | null>(null);
  const [viewing, setViewing] = useState<Version | null>(null);
  const [naming, setNaming] = useState<Version | null>(null);
  const [menu, setMenu] = useState<{ v: Version; el: HTMLElement } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Version | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<Version | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const current = versions.find((v) => v.is_current) ?? null;
  const full = versions.length >= MAX_VERSIONS;

  function load() {
    setLoading(true);
    setFailed(false);
    api.get<Version[]>(`/documents/${documentId}/versions`)
      .then((r) => setVersions(Array.isArray(r.data) ? r.data : []))
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }

  useEffect(() => { if (open) load(); }, [open, documentId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pickFor) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPickFor(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pickFor]);

  async function uploadNewVersion(file: File) {
    setUploading(true);
    const taskId = addTask({ kind: "upload", label: `Nova versão de ${documentName}`, status: "running" });
    try {
      const { data } = await api.post(`/documents/${documentId}/versions/upload-url`, {
        size_bytes: file.size,
        content_type: file.type || "application/octet-stream",
      });
      const putResp = await fetch(data.upload_url, {
        method: "PUT", body: file,
        // Mesmo tipo da assinatura da URL (XML falhava com 403).
        headers: { "Content-Type": data.content_type ?? (file.type || "application/octet-stream") },
      }).catch(() => new Response(null, { status: 0 }));
      if (!putResp.ok) {
        api.delete(`/documents/${documentId}/versions/${data.version_id}`).catch(() => {});
        throw new Error(
          putResp.status === 0
            ? "A conexão caiu durante o envio. Confira a internet e tente de novo."
            : `O armazenamento recusou o arquivo (código ${putResp.status}). Tente de novo.`,
        );
      }
      await api.post(`/documents/${documentId}/versions/${data.version_id}/confirm`);
      updateTask(taskId, { status: "done" });
      success(`Versão ${data.version_number} enviada.`);
      setFresh(data.version_id);
      load();
      onChanged();
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? "Não foi possível enviar a nova versão.";
      updateTask(taskId, { status: "failed", error: msg });
      showError(msg);
    } finally {
      setUploading(false);
    }
  }

  async function downloadVersion(v: Version) {
    try {
      const r = await api.get(`/documents/${documentId}/versions/${v.id}/download-url`);
      const a = document.createElement("a");
      a.href = r.data.download_url;
      a.download = r.data.name;
      a.click();
    } catch {
      showError("Não foi possível baixar esta versão. Tente de novo.");
    }
  }

  async function restoreVersion(v: Version) {
    setConfirmRestore(null);
    setBusyId(v.id);
    try {
      const r = await api.post(`/documents/${documentId}/versions/${v.id}/restore`);
      success(`Versão ${v.version_number} voltou como versão atual.`);
      setFresh(r.data?.new_version_id ?? null);
      load();
      onChanged();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível restaurar esta versão.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteVersion(v: Version) {
    if (v.is_current) return;
    setConfirmDelete(null);
    setBusyId(v.id);
    try {
      await api.delete(`/documents/${documentId}/versions/${v.id}`);
      success(`Versão ${v.version_number} excluída.`);
      setVersions((prev) => prev.filter((x) => x.id !== v.id));
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível excluir esta versão.");
    } finally {
      setBusyId(null);
    }
  }

  async function saveLabel(v: Version, label: string) {
    try {
      const r = await api.patch(`/documents/${documentId}/versions/${v.id}`, { label });
      setVersions((prev) => prev.map((x) => (x.id === v.id ? { ...x, label: r.data.label } : x)));
      success(r.data.label ? `Versão ${v.version_number} agora se chama "${r.data.label}".` : `Nome da versão ${v.version_number} retirado.`);
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível salvar o nome.");
      throw e;
    }
  }

  const iconBtn = "w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover) disabled:opacity-(--opacity-disabled) shrink-0";

  return (
    <div className="border-t border-(--border-default) pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={`versoes-${documentId}`}
        className="w-full flex items-center justify-between min-h-8 pointer-coarse:min-h-11 text-mac-body text-(--text-primary) hover:text-(--text-accent) transition-colors duration-fast"
      >
        <span className="flex items-center gap-2">
          <History className="w-4 h-4" aria-hidden="true" />
          Versões{open && versions.length > 0 ? ` (${versions.length})` : ""}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform duration-fast ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div id={`versoes-${documentId}`} className="reveal mt-3 space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadNewVersion(f); e.target.value = ""; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || full}
            className="w-full h-8 pointer-coarse:h-11 flex items-center justify-center gap-1.5 text-mac-caption border border-(--border-control) rounded-full text-(--text-primary) hover:bg-(--bg-hover) transition-colors duration-fast disabled:opacity-(--opacity-disabled)"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            {uploading ? "Enviando…" : "Enviar nova versão"}
          </button>
          {full && <p className="text-mac-caption text-(--text-warning)">Limite de {MAX_VERSIONS} versões atingido: exclua uma antiga para enviar ou restaurar outra.</p>}

          {pickFor && (
            <div role="status" className="flex items-center gap-2 rounded-(--radius-control) bg-(--tint-accent) px-3 py-2 text-mac-caption text-(--text-primary)">
              <GitCompare className="w-3.5 h-3.5 text-(--text-accent)" aria-hidden="true" />
              <span className="flex-1">Escolha a versão para comparar com a {pickFor.version_number}.</span>
              <button onClick={() => setPickFor(null)} aria-label="Cancelar comparação" className={iconBtn}><X className="w-3.5 h-3.5" aria-hidden="true" /></button>
            </div>
          )}

          {loading && versions.length === 0 ? (
            <div className="h-16 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" aria-label="Carregando versões" />
          ) : failed ? (
            <p role="alert" className="text-mac-caption text-(--text-secondary)">Não foi possível carregar as versões. <button onClick={load} className="text-(--text-accent) font-medium hover:underline">Tentar de novo</button></p>
          ) : versions.length === 0 ? (
            <p className="text-mac-caption text-(--text-secondary) text-center py-2">Nenhum histórico ainda.</p>
          ) : (
            <ul className="space-y-1.5" aria-label="Versões do documento">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className={`${fresh === v.id ? "reveal" : ""} flex items-start gap-1.5 pl-3 pr-1 py-2 rounded-(--radius-control) text-mac-caption ${
                    v.is_current ? "bg-(--tint-accent) border border-teal-500/30" : "bg-(--bg-page) border border-transparent"
                  }`}
                >
                  <div className="flex-1 min-w-0 py-0.5">
                    <p className="font-medium text-(--text-primary)">
                      v{v.version_number}{v.is_current && <span className="text-(--text-accent)"> · atual</span>}
                      {v.label && <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-(--bg-hover) px-1.5 text-(--text-primary) font-normal"><Tag className="w-3 h-3" aria-hidden="true" />{v.label}</span>}
                    </p>
                    <p className="text-(--text-secondary)">
                      {fmtSize(v.size_bytes)} · <time dateTime={v.created_at} title={fullDate(v.created_at)}>{relativeDate(v.created_at)}</time>{v.uploaded_by_name ? ` · ${v.uploaded_by_name}` : ""}
                    </p>
                    {v.sha256 && (
                      <p className="font-mono text-mac-caption2 text-(--text-secondary)" title={`SHA-256 ${v.sha256}`}>
                        SHA-256 {v.sha256.slice(0, 4)}…{v.sha256.slice(-4)}
                      </p>
                    )}
                  </div>
                  {pickFor ? (
                    pickFor.id !== v.id && (
                      <Button size="sm" variant="secondary" onClick={() => { setDiffPair([pickFor, v]); setPickFor(null); }}>
                        Comparar com esta
                      </Button>
                    )
                  ) : (
                    <>
                      <button onClick={() => setViewing(v)} aria-label={`Abrir a versão ${v.version_number}`} title="Abrir" className={iconBtn}>
                        <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                      {!v.is_current && current && (
                        <button onClick={() => setDiffPair([v, current])} aria-label={`Comparar a versão ${v.version_number} com a atual`} title="Comparar com a atual" className={iconBtn}>
                          <GitCompare className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      )}
                      <button onClick={(e) => setMenu({ v, el: e.currentTarget })} aria-haspopup="menu" aria-label={`Mais ações da versão ${v.version_number}`} disabled={busyId === v.id} className={iconBtn}>
                        {busyId === v.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <MoreHorizontal className="w-3.5 h-3.5" aria-hidden="true" />}
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-mac-caption text-(--text-secondary) text-center">{versions.length} de {MAX_VERSIONS} versões usadas.</p>
        </div>
      )}

      {menu && (
        <Menu
          anchor={menu.el}
          align="end"
          label={`Versão ${menu.v.version_number}`}
          onClose={() => setMenu(null)}
          items={[
            { label: "Abrir", icon: <Eye />, onSelect: () => setViewing(menu.v) },
            { label: "Baixar", icon: <Download />, onSelect: () => downloadVersion(menu.v) },
            { label: menu.v.label ? "Renomear versão…" : "Dar nome à versão…", icon: <Tag />, onSelect: () => setNaming(menu.v) },
            ...(versions.length > 1 ? [{ label: "Comparar com…", icon: <GitCompare />, onSelect: () => setPickFor(menu.v) }] : []),
            ...(!menu.v.is_current ? [
              { label: "Restaurar como atual…", icon: <RotateCcw />, separatorBefore: true, disabled: full, hint: full ? "limite" : undefined, onSelect: () => setConfirmRestore(menu.v) },
              { label: "Excluir versão…", icon: <Trash2 />, danger: true, onSelect: () => setConfirmDelete(menu.v) },
            ] : []),
          ]}
        />
      )}

      {diffPair && <DiffModal documentId={documentId} documentName={documentName} versionA={diffPair[0]} versionB={diffPair[1]} onClose={() => setDiffPair(null)} />}
      {viewing && <ViewVersionDialog documentId={documentId} documentName={documentName} version={viewing} onClose={() => setViewing(null)} />}
      {naming && <NameDialog version={naming} onClose={() => setNaming(null)} onSave={(label) => saveLabel(naming, label)} />}
      {confirmRestore && (
        <ConfirmModal
          title={`Restaurar a versão ${confirmRestore.version_number}?`}
          description={<>Ela volta como uma <b>nova versão atual</b> (v{Math.max(...versions.map((x) => x.version_number)) + 1}); as outras continuam no histórico. Usa uma das {MAX_VERSIONS} vagas ({versions.length} de {MAX_VERSIONS} usadas). O texto é lido de novo para a busca.</>}
          confirmLabel="Restaurar"
          onConfirm={() => restoreVersion(confirmRestore)}
          onClose={() => setConfirmRestore(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          title={`Excluir a versão ${confirmDelete.version_number}?`}
          description="O arquivo desta versão é apagado de vez e a exclusão fica registrada na trilha. A versão atual não muda."
          confirmLabel="Excluir versão"
          danger
          onConfirm={() => deleteVersion(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
