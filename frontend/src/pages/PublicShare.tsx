import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Lock, Download, FolderOpen, AlertCircle, ChevronRight } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

const API_BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:8000") + "/api/v1";

interface FolderItem { id: string; name: string; }
interface DocItem { id: string; name: string; size_bytes: number; mime_type: string }

type ContentState =
  | { type: "document"; name: string; mime_type: string; preview_url: string }
  | { type: "folder"; name: string; folder_id: string; is_root: boolean; folders: FolderItem[]; documents: DocItem[] };

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PublicShare() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<{ resource_type: string; name: string; has_password: boolean } | null>(null);
  const [password, setPassword] = useState("");
  const [content, setContent] = useState<ContentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    fetch(`${API_BASE}/s/${token}/info`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).detail ?? "Link não encontrado.");
        return r.json();
      })
      .then((data) => {
        setInfo(data);
        if (!data.has_password) fetchContent(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function fetchContent(folderId: string | null, pwd?: string) {
    setLoading(true);
    setError(null);
    setPasswordError(null);
    try {
      const qs = folderId ? `?folder_id=${folderId}` : "";
      const r = await fetch(`${API_BASE}/s/${token}/content${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd ?? password ?? null }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail ?? "Não foi possível acessar este link.");
      setContent(data);
      if (data.type === "folder" && folderId && !data.is_root) {
        setPath((p) => [...p, { id: data.folder_id, name: data.name }]);
      } else if (data.type === "folder" && data.is_root) {
        setPath([]);
      }
    } catch (e: any) {
      // Senha errada não pode derrubar a tela pro estado de erro fatal —
      // isso escondia o formulário pra sempre e o visitante não tinha como
      // tentar de novo sem recarregar a página inteira. Só desvia pro erro
      // "retomável" quando existe de fato um formulário de senha na tela pra
      // mostrá-lo; sem isso (link sem senha, ou erro depois de já estarmos
      // dentro do conteúdo) precisa cair no estado de erro fatal, senão o
      // erro não aparece em lugar nenhum.
      if (!content && info?.has_password) setPasswordError(e.message);
      else setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function downloadDoc(docId: string) {
    try {
      const r = await fetch(`${API_BASE}/s/${token}/download/${docId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password || null }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail);
      const a = document.createElement("a");
      a.href = data.download_url;
      a.download = data.name;
      a.click();
    } catch (e: any) {
      setError(e.message);
    }
  }

  function navigateTo(folderId: string | null, crumbIndex?: number) {
    if (crumbIndex !== undefined) setPath((p) => p.slice(0, crumbIndex));
    fetchContent(folderId);
  }

  return (
    <div className="relative min-h-screen overflow-hidden flex flex-col items-center px-4 py-10" style={{ background: "var(--wallpaper)" }}>
      {/* Mesmo glow em camadas do Login — este link também é "primeiro contato"
          com a marca pra quem recebe (cliente/parceiro externo sem conta). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-80 dark:opacity-100 transition-opacity duration-slow"
        style={{
          background:
            "radial-gradient(680px circle at 16% 12%, rgba(13,148,136,0.20), transparent 55%)," +
            "radial-gradient(620px circle at 84% 82%, rgba(20,184,166,0.16), transparent 55%)," +
            "radial-gradient(900px circle at 50% 118%, rgba(13,148,136,0.12), transparent 60%)",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[520px] h-[520px] rounded-full blur-[120px] opacity-50 dark:opacity-30"
        style={{ background: "radial-gradient(circle, rgba(20,184,166,0.22), transparent 70%)" }}
      />

      <div className="relative w-full max-w-[560px]">
        <div className="flex items-center justify-center mb-8">
          <div className="brand-wordmark w-[130px] h-[37px]" role="img" aria-label="Docke" />
        </div>

        <div className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] p-6 shadow-modal">
          {loading && !content && !error && !info?.has_password && (
            <div className="flex justify-center py-10">
              <div className="w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center text-center gap-3 py-8">
              <AlertCircle className="w-10 h-10 text-[var(--text-placeholder)]" />
              <p className="text-mac-body text-[var(--text-secondary)]">{error}</p>
            </div>
          )}

          {!error && info?.has_password && !content && (
            <form
              onSubmit={(e) => { e.preventDefault(); fetchContent(null); }}
              className="flex flex-col items-center gap-4 py-4"
            >
              <div className="w-12 h-12 bg-amber-50 dark:bg-amber-900/20 rounded-[12px] flex items-center justify-center">
                <Lock className="w-6 h-6 text-amber-600 dark:text-amber-400" />
              </div>
              <p className="text-mac-body text-[var(--text-primary)] font-medium">"{info.name}" está protegido por senha</p>
              <Input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => { setPassword(e.target.value); setPasswordError(null); }}
                placeholder="Senha"
                error={passwordError ?? undefined}
                disabled={loading}
                className="shadow-[inset_0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_2px_rgba(0,0,0,0.25)]"
              />
              <Button type="submit" loading={loading} className="w-full">
                Acessar
              </Button>
            </form>
          )}

          {!error && content?.type === "document" && (
            <div className="text-center py-4">
              {(() => { const s = getFileStyle(content.name); const Icon = s.icon; return (
                <Icon className={`w-12 h-12 mx-auto mb-4 ${s.iconColor}`} strokeWidth={1.5} />
              ); })()}
              <p className="text-mac-body font-medium text-[var(--text-primary)] break-words mb-4">{content.name}</p>
              {content.mime_type.startsWith("image/") ? (
                <img src={content.preview_url} alt={content.name} className="max-w-full max-h-[400px] mx-auto rounded-[var(--radius-control)] mb-4" />
              ) : content.mime_type === "application/pdf" ? (
                <iframe src={content.preview_url} className="w-full h-[400px] border border-[var(--border-default)] rounded-[var(--radius-control)] mb-4" title={content.name} />
              ) : null}
              <a
                href={content.preview_url}
                download={content.name}
                className="inline-flex items-center gap-1.5 h-8 px-4 bg-teal-600 text-white text-mac-body font-medium rounded-full hover:bg-teal-500 transition-colors duration-fast"
              >
                <Download className="w-3.5 h-3.5" />
                Baixar
              </a>
            </div>
          )}

          {!error && content?.type === "folder" && (
            <div>
              {path.length > 0 && (
                <nav className="flex items-center gap-1 mb-4 text-mac-caption text-[var(--text-secondary)]">
                  <button onClick={() => navigateTo(null, 0)} className="hover:text-teal-500">raiz</button>
                  {path.map((p, i) => (
                    <span key={p.id} className="flex items-center gap-1">
                      <ChevronRight className="w-3 h-3" />
                      <button onClick={() => navigateTo(p.id, i + 1)} className="hover:text-teal-500">{p.name}</button>
                    </span>
                  ))}
                </nav>
              )}
              <p className="text-mac-body font-medium text-[var(--text-primary)] mb-3 flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-teal-500" />
                {content.name}
              </p>
              <ul className="divide-y divide-[var(--border-default)] border border-[var(--border-default)] rounded-[var(--radius-control)] overflow-hidden">
                {content.folders.map((f) => (
                  <li key={f.id}>
                    <button
                      onClick={() => navigateTo(f.id)}
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-mac-body text-left hover:bg-[var(--bg-hover)] transition-colors duration-fast"
                    >
                      <FolderOpen className="w-4 h-4 text-teal-500 flex-shrink-0" />
                      {f.name}
                    </button>
                  </li>
                ))}
                {content.documents.map((d) => {
                  const s = getFileStyle(d.name); const Icon = s.icon;
                  return (
                    <li key={d.id} className="flex items-center gap-2 px-3 py-2.5 text-mac-body">
                      <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${s.bgColor}`}>
                        <Icon className={`w-3.5 h-3.5 ${s.iconColor} ${s.fillColor}`} />
                      </div>
                      <span className="flex-1 truncate text-[var(--text-primary)]">{d.name}</span>
                      <span className="text-mac-caption text-[var(--text-tertiary)]">{fmtSize(d.size_bytes)}</span>
                      <button onClick={() => downloadDoc(d.id)} className="p-1 text-[var(--text-tertiary)] hover:text-teal-500">
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  );
                })}
                {content.folders.length === 0 && content.documents.length === 0 && (
                  <li className="px-3 py-6 text-center text-mac-caption text-[var(--text-tertiary)]">Pasta vazia.</li>
                )}
              </ul>
            </div>
          )}
        </div>

        <p className="text-center text-mac-caption text-[var(--text-tertiary)] mt-6">
          Compartilhado com segurança via <span className="font-medium">Docke</span>
        </p>
      </div>
    </div>
  );
}
