import { useEffect, useRef, useState } from "react";
import { History, Upload, Download, RotateCcw, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { relativeDate } from "@/lib/date";

interface Version {
  id: string;
  version_number: number;
  size_bytes: number;
  mime_type: string;
  created_at: string;
  uploaded_by_name: string | null;
  is_current: boolean;
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function VersionsPanel({ documentId, onChanged }: { documentId: string; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      success(`Versão ${data.version_number} enviada.`);
      load();
      onChanged();
    } catch (e: any) {
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
    <div className="border-t border-[var(--border-default)] pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm text-[var(--text-primary)] hover:text-teal-600 transition-colors duration-fast"
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
            className="w-full h-8 flex items-center justify-center gap-1.5 text-xs border border-[var(--border-default)] rounded-[8px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast disabled:opacity-50"
          >
            <Upload className="w-3.5 h-3.5" />
            {uploading ? "Enviando…" : "Enviar nova versão"}
          </button>

          {loading ? (
            <div className="h-16 bg-[var(--bg-hover)] rounded-[8px] animate-pulse" />
          ) : versions.length === 0 ? (
            <p className="text-xs text-[var(--text-tertiary)] text-center py-2">Nenhum histórico ainda.</p>
          ) : (
            <ul className="space-y-1.5">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className={`flex items-center gap-2 px-2.5 py-2 rounded-[8px] text-xs ${
                    v.is_current ? "bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-900/40" : "bg-[var(--bg-page)]"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-[var(--text-primary)]">
                      v{v.version_number} {v.is_current && <span className="text-teal-600">· atual</span>}
                    </p>
                    <p className="text-[var(--text-tertiary)] truncate">
                      {fmtSize(v.size_bytes)} · {relativeDate(v.created_at)} {v.uploaded_by_name ? `· ${v.uploaded_by_name}` : ""}
                    </p>
                  </div>
                  <button onClick={() => downloadVersion(v)} title="Baixar esta versão" className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]">
                    <Download className="w-3.5 h-3.5" />
                  </button>
                  {!v.is_current && (
                    <>
                      <button
                        onClick={() => restoreVersion(v)}
                        disabled={busyId === v.id}
                        title="Restaurar esta versão"
                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-teal-600 hover:bg-[var(--bg-hover)] disabled:opacity-50"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteVersion(v)}
                        disabled={busyId === v.id}
                        title="Excluir esta versão"
                        className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-hover)] disabled:opacity-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-[var(--text-tertiary)] text-center">Limite de 10 versões por documento.</p>
        </div>
      )}
    </div>
  );
}
