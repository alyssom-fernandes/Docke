import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { History, Upload, Download, RotateCcw, Trash2, ChevronDown, GitCompare, Loader2, Eye, MoreHorizontal, Tag, ChevronUp, X } from "lucide-react";
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
        ? <mark key={i} className={`rounded-[2px] px-px text-(--text-primary) ${line.type === "add" ? "bg-emerald-500/40" : "bg-red-500/40"}`}>{p.text}</mark>
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
function DiffModal({ documentId, documentName, versionA, versionB, onClose }: {
  documentId: string; documentName: string; versionA: Version; versionB: Version; onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<DiffResult | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [cursor, setCursor] = useState(-1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [older, newer] = versionA.version_number < versionB.version_number ? [versionA, versionB] : [versionB, versionA];

  useEffect(() => {
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
          setUnavailableReason(a.data.reason ?? b.data.reason ?? "Comparação não disponível.");
          setLoading(false);
          return;
        }
        worker = new Worker(new URL("./diff.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (e: MessageEvent<DiffResult>) => {
          if (!alive) return;
          if (!e.data.lines) setUnavailableReason("As duas versões são diferentes demais para comparar linha a linha. Abra cada uma no visualizador.");
          setResult(e.data);
          setLoading(false);
        };
        worker.onerror = () => { setUnavailableReason("Não foi possível comparar agora. Tente de novo."); setLoading(false); };
        worker.postMessage({ a: a.data.text ?? "", b: b.data.text ?? "" });
      })
      .catch(() => { if (alive) { setUnavailableReason("Não foi possível carregar o conteúdo das versões."); setLoading(false); } });
    return () => { alive = false; worker?.terminate(); };
  }, [documentId, older.id, newer.id]);

  const lines = result?.lines ?? null;
  // Índices das linhas mudadas e, no modo "só mudanças", o que fica visível (2 de contexto).
  const { visible, changeStarts } = useMemo(() => {
    if (!lines) return { visible: [] as (number | "gap")[], changeStarts: [] as number[] };
    const changeStarts: number[] = [];
    lines.forEach((l, i) => { if (l.type !== "same" && (i === 0 || lines[i - 1].type === "same")) changeStarts.push(i); });
    if (!onlyChanges) return { visible: lines.map((_, i) => i), changeStarts };
    const keep = new Set<number>();
    lines.forEach((l, i) => { if (l.type !== "same") for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < lines.length) keep.add(k); });
    const visible: (number | "gap")[] = [];
    let last = -1;
    [...keep].sort((x, y) => x - y).forEach((i) => { if (last >= 0 && i > last + 1) visible.push("gap"); visible.push(i); last = i; });
    return { visible, changeStarts };
  }, [lines, onlyChanges]);

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
          <Button variant="secondary" onClick={exportText}><Download className="w-3.5 h-3.5" aria-hidden="true" /> Baixar comparação</Button>
          <Button onClick={onClose}>Fechar</Button>
        </>
      ) : undefined}>
      {summary && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-(--border-default)">
          <p role="status" className="flex-1 min-w-[12rem] text-mac-caption font-medium text-(--text-primary)">{summary}</p>
          {changeStarts.length > 0 && (
            <>
              <label className="inline-flex items-center gap-1.5 text-mac-caption text-(--text-secondary)">
                <input type="checkbox" checked={onlyChanges} onChange={(e) => setOnlyChanges(e.target.checked)} className="accent-teal-600 w-4 h-4" /> Só as mudanças
              </label>
              <span className="text-mac-caption text-(--text-secondary) tabular-nums" aria-live="polite">{cursor >= 0 ? `${cursor + 1} de ${changeStarts.length}` : `${changeStarts.length} ${changeStarts.length === 1 ? "trecho" : "trechos"}`}</span>
              <button onClick={() => goChange(-1)} aria-label="Mudança anterior" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><ChevronUp className="w-4 h-4" aria-hidden="true" /></button>
              <button onClick={() => goChange(1)} aria-label="Próxima mudança" className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--bg-hover)"><ChevronDown className="w-4 h-4" aria-hidden="true" /></button>
            </>
          )}
        </div>
      )}
      <div ref={bodyRef} className="h-[min(62vh,560px)] overflow-auto">
        {loading ? (
          <div className="h-full flex items-center justify-center gap-2 text-mac-body text-(--text-secondary)" role="status"><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> Comparando…</div>
        ) : unavailableReason ? (
          <div className="h-full flex items-center justify-center px-8 text-center"><p className="text-mac-body text-(--text-secondary)">{unavailableReason}</p></div>
        ) : lines && changeStarts.length === 0 ? (
          <div className="h-full flex items-center justify-center px-8 text-center"><p className="text-mac-body text-(--text-secondary)">Nenhuma diferença de texto entre estas duas versões.</p></div>
        ) : lines && (
          <div className="py-2 text-mac-caption font-mono leading-relaxed">
            {visible.map((v, k) => v === "gap" ? (
              <div key={`g${k}`} className="my-1 px-4 text-(--text-secondary) select-none" aria-hidden="true">⋯</div>
            ) : (
              <div key={v} data-line={v}
                className={`flex gap-2 px-4 whitespace-pre-wrap break-words ${lines[v].type === "add" ? "bg-emerald-500/12" : lines[v].type === "remove" ? "bg-red-500/12" : ""} ${changeStarts[cursor] === v ? "ring-2 ring-inset ring-(--focus-ring)" : ""}`}>
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
      <div className="flex-1 min-h-0 bg-(--bg-page)">
        {!isPdf && !isImage ? (
          <p className="p-8 text-center text-mac-body text-(--text-secondary)">Este formato não abre no visualizador. Baixe a versão pelo menu dela.</p>
        ) : failed ? (
          <p role="alert" className="p-8 text-center text-mac-body text-(--text-secondary)">Não foi possível abrir esta versão agora. Tente de novo.</p>
        ) : !url ? (
          <div className="h-full flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-(--text-secondary)" aria-label="Carregando" /></div>
        ) : isPdf ? (
          <Suspense fallback={<div className="h-full flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-(--text-secondary)" aria-label="Carregando" /></div>}>
            <PdfViewer url={url} />
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
            <div role="status" className="flex items-center gap-2 rounded-(--radius-control) bg-teal-500/10 px-3 py-2 text-mac-caption text-(--text-primary)">
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
                    v.is_current ? "bg-teal-500/10 border border-teal-500/30" : "bg-(--bg-page) border border-transparent"
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
