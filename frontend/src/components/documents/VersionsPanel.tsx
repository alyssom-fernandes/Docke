import { useEffect, useRef, useState } from "react";
import { History, Upload, Download, RotateCcw, Trash2, ChevronDown, ChevronUp, GitCompare, X, Loader2 } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useTaskCenter } from "@/lib/TaskContext";
import { relativeDate } from "@/lib/date";
import Portal from "@/components/ui/Portal";

interface Version {
  id: string;
  version_number: number;
  size_bytes: number;
  mime_type: string;
  created_at: string;
  uploaded_by_name: string | null;
  is_current: boolean;
}

// Fase 12.4 — diff textual entre versões. Só funciona pra arquivos de texto
// puro (txt/csv/xml) — o backend lê o conteúdo direto do storage sem OCR,
// já que o valor já É texto. PDF/imagem dependeriam de OCR por versão, que
// nunca foi implementado (só a versão atual tem texto extraído).
type DiffLine = { type: "same" | "add" | "remove"; text: string };

// Diff linha-a-linha por LCS (subsequência comum mais longa) — O(n*m), mas
// documentos de texto puro aqui são pequenos o bastante (relatórios, SPED,
// XML) pra isso nunca ser um problema real de performance.
function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length, m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { result.push({ type: "same", text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { result.push({ type: "remove", text: a[i] }); i++; }
    else { result.push({ type: "add", text: b[j] }); j++; }
  }
  while (i < n) { result.push({ type: "remove", text: a[i] }); i++; }
  while (j < m) { result.push({ type: "add", text: b[j] }); j++; }
  return result;
}

function DiffModal({ documentId, versionA, versionB, onClose }: {
  documentId: string; versionA: Version; versionB: Version; onClose: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [diff, setDiff] = useState<DiffLine[] | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

  // Sempre compara na ordem cronológica (mais antiga → mais nova), independente
  // da ordem de seleção — "remove"/"add" só faz sentido cronologicamente.
  const [older, newer] = versionA.version_number < versionB.version_number ? [versionA, versionB] : [versionB, versionA];

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.get<{ available: boolean; text: string | null; reason: string | null }>(`/documents/${documentId}/versions/${older.id}/content`),
      api.get<{ available: boolean; text: string | null; reason: string | null }>(`/documents/${documentId}/versions/${newer.id}/content`),
    ])
      .then(([a, b]) => {
        if (!a.data.available || !b.data.available) {
          setUnavailableReason(a.data.reason ?? b.data.reason ?? "Comparação não disponível.");
          return;
        }
        setDiff(diffLines(a.data.text ?? "", b.data.text ?? ""));
      })
      .catch(() => setUnavailableReason("Não foi possível carregar o conteúdo das versões."))
      .finally(() => setLoading(false));
  }, [documentId, older.id, newer.id]);

  return (
    <Portal>
      <div className="fixed inset-0 bg-(--overlay-scrim) flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="glass-dialog glass-blur-strong rounded-(--radius-dialog) shadow-modal modal-card w-full max-w-2xl flex flex-col" style={{ height: "min(80vh, 640px)" }}>
          <div className="flex items-center justify-between px-5 py-4 border-b border-(--border-default) shrink-0">
            <h2 className="text-mac-body font-semibold text-(--text-primary) flex items-center gap-2">
              <GitCompare className="w-4 h-4 text-teal-500" />
              v{older.version_number} → v{newer.version_number}
            </h2>
            <button onClick={onClose} className="p-1 rounded-[6px] text-(--text-secondary) hover:bg-(--bg-hover)">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="h-full flex items-center justify-center">
                <Loader2 className="w-6 h-6 text-(--text-placeholder) animate-spin" />
              </div>
            ) : unavailableReason ? (
              <div className="h-full flex items-center justify-center px-8 text-center">
                <p className="text-mac-body text-(--text-secondary)">{unavailableReason}</p>
              </div>
            ) : diff && diff.every((l) => l.type === "same") ? (
              <div className="h-full flex items-center justify-center px-8 text-center">
                <p className="text-mac-body text-(--text-secondary)">Nenhuma diferença de texto entre estas duas versões.</p>
              </div>
            ) : (
              <pre className="p-4 text-mac-caption font-mono leading-relaxed">
                {diff?.map((line, i) => (
                  <div
                    key={i}
                    className={
                      line.type === "add" ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" :
                      line.type === "remove" ? "bg-red-500/15 text-red-700 dark:text-red-400 line-through decoration-1" :
                      "text-(--text-secondary)"
                    }
                  >
                    {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}{line.text}
                  </div>
                ))}
              </pre>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function VersionsPanel({ documentId, documentName, onChanged }: { documentId: string; documentName: string; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const { addTask, updateTask } = useTaskCenter();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Fase 12.4: até 2 versões selecionadas por vez pra comparar.
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [diffPair, setDiffPair] = useState<[Version, Version] | null>(null);

  function toggleCompare(id: string) {
    setCompareIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }

  function load() {
    setLoading(true);
    api.get<Version[]>(`/documents/${documentId}/versions`)
      .then((r) => setVersions(Array.isArray(r.data) ? r.data : []))
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => { if (open) load(); }, [open, documentId]);

  async function uploadNewVersion(file: File) {
    setUploading(true);
    // ADR-031 (Task Center × Versionamento): rótulo diferenciado de um upload
    // normal, pra não parecer que um documento novo está sendo criado.
    const taskId = addTask({ kind: "upload", label: `Nova versão de ${documentName}`, status: "running" });
    try {
      const { data } = await api.post(`/documents/${documentId}/versions/upload-url`, {
        size_bytes: file.size,
        content_type: file.type || "application/octet-stream",
      });
      const putResp = await fetch(data.upload_url, {
        method: "PUT", body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putResp.ok) throw new Error("Falha no upload para o storage.");
      await api.post(`/documents/${documentId}/versions/${data.version_id}/confirm`);
      updateTask(taskId, { status: "done" });
      success(`Versão ${data.version_number} enviada.`);
      load();
      onChanged();
    } catch (e: any) {
      updateTask(taskId, { status: "failed", error: e?.response?.data?.detail ?? e?.message ?? "Erro ao enviar nova versão." });
      showError(e?.response?.data?.detail ?? e?.message ?? "Erro ao enviar nova versão.");
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
      showError("Erro ao baixar esta versão.");
    }
  }

  async function restoreVersion(v: Version) {
    setBusyId(v.id);
    try {
      await api.post(`/documents/${documentId}/versions/${v.id}/restore`);
      success(`Versão ${v.version_number} restaurada como nova versão atual.`);
      load();
      onChanged();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Erro ao restaurar versão.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteVersion(v: Version) {
    if (v.is_current) return;
    setBusyId(v.id);
    try {
      await api.delete(`/documents/${documentId}/versions/${v.id}`);
      success(`Versão ${v.version_number} excluída.`);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Erro ao excluir versão.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="border-t border-(--border-default) pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-mac-body text-(--text-primary) hover:text-teal-500 transition-colors duration-fast"
      >
        <span className="flex items-center gap-2">
          <History className="w-4 h-4" />
          Versões
        </span>
        {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadNewVersion(f); e.target.value = ""; }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="w-full h-8 flex items-center justify-center gap-1.5 text-mac-caption border border-(--border-default) rounded-(--radius-control) text-(--text-secondary) hover:bg-(--bg-hover) transition-colors duration-fast disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            {uploading ? "Enviando…" : "Enviar nova versão"}
          </button>

          {loading ? (
            <div className="h-16 bg-(--bg-hover) rounded-(--radius-control) animate-pulse" />
          ) : versions.length === 0 ? (
            <p className="text-mac-caption text-(--text-tertiary) text-center py-2">Nenhum histórico ainda.</p>
          ) : (
            <>
              {/* Fase 12.4: aparece só quando exatamente 2 versões marcadas */}
              {versions.length > 1 && compareIds.length === 2 && (
                <button
                  onClick={() => {
                    const [a, b] = compareIds.map((id) => versions.find((v) => v.id === id)!);
                    setDiffPair([a, b]);
                  }}
                  className="w-full h-8 flex items-center justify-center gap-1.5 text-mac-caption bg-teal-600 text-white rounded-(--radius-control) hover:bg-teal-500 transition-colors duration-fast"
                >
                  <GitCompare className="w-3.5 h-3.5" />
                  Comparar versões selecionadas
                </button>
              )}
            <ul className="space-y-1.5">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-(--radius-control) text-mac-caption ${
                    v.is_current ? "bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-900/40" : "bg-(--bg-page)"
                  }`}
                >
                  {versions.length > 1 && (
                    <input
                      type="checkbox"
                      checked={compareIds.includes(v.id)}
                      onChange={() => toggleCompare(v.id)}
                      title="Selecionar para comparar"
                      className="shrink-0 accent-teal-500"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-(--text-primary)">
                      v{v.version_number} {v.is_current && <span className="text-teal-500">· atual</span>}
                    </p>
                    <p className="text-(--text-tertiary) truncate">
                      {fmtSize(v.size_bytes)} · {relativeDate(v.created_at)} {v.uploaded_by_name ? `· ${v.uploaded_by_name}` : ""}
                    </p>
                  </div>
                  <button onClick={() => downloadVersion(v)} title="Baixar esta versão" className="p-1 rounded text-(--text-tertiary) hover:text-(--text-primary) hover:bg-(--bg-hover)">
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  {!v.is_current && (
                    <>
                      <button
                        onClick={() => restoreVersion(v)}
                        disabled={busyId === v.id}
                        title="Restaurar esta versão"
                        className="p-1 rounded text-(--text-tertiary) hover:text-teal-500 hover:bg-(--bg-hover) disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteVersion(v)}
                        disabled={busyId === v.id}
                        title="Excluir esta versão"
                        className="p-1 rounded text-(--text-tertiary) hover:text-(--text-primary) hover:bg-(--bg-hover) disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            </>
          )}
          <p className="text-[10px] text-(--text-tertiary) text-center">Limite de 10 versões por documento.</p>
        </div>
      )}

      {diffPair && (
        <DiffModal documentId={documentId} versionA={diffPair[0]} versionB={diffPair[1]} onClose={() => setDiffPair(null)} />
      )}
    </div>
  );
}
