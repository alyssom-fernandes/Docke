import { lazy, Suspense, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Lock, Download, FolderOpen, AlertCircle, ChevronRight, Building2, CalendarClock, RefreshCw } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";

const PdfViewer = lazy(() => import("@/components/documents/PdfViewer"));

const API_BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:8000") + "/api/v1";

interface FolderItem { id: string; name: string; }
interface DocItem { id: string; name: string; size_bytes: number; mime_type: string }
interface ShareInfo {
  resource_type: string; name: string; has_password: boolean; allow_download?: boolean;
  views_left?: number | null; expires_at?: string | null; size_bytes?: number | null;
  company_name?: string | null; sender_name?: string | null;
}

type ContentState =
  | { type: "document"; name: string; mime_type: string; preview_url: string; document_id?: string; allow_download?: boolean }
  | { type: "folder"; name: string; folder_id: string; is_root: boolean; folders: FolderItem[]; documents: DocItem[]; allow_download?: boolean };

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/** Erro de rede vira frase que orienta, não "Failed to fetch" (A1-14). */
function friendly(e: unknown, fallback: string) {
  if (e instanceof TypeError) return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  return e instanceof Error && e.message ? e.message : fallback;
}

function Skeleton() {
  return (
    <div className="space-y-3 py-4" aria-label="Carregando" role="status">
      <div className="h-12 w-12 mx-auto rounded-card bg-(--bg-hover) animate-pulse" />
      <div className="h-4 w-2/3 mx-auto rounded bg-(--bg-hover) animate-pulse" />
      <div className="h-3 w-1/2 mx-auto rounded bg-(--bg-hover) animate-pulse" />
    </div>
  );
}

/**
 * Página de quem recebe um link (A1-11..A1-16): diz quem enviou, de qual
 * empresa, até quando vale e o tamanho; senha com rótulo visível; erros com
 * a próxima ação; título da aba com o nome do arquivo; esqueleto no lugar do
 * spinner e retorno ao clicar em baixar.
 */
export default function PublicShare() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [password, setPassword] = useState("");
  const [content, setContent] = useState<ContentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/s/${token}/info`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail ?? "Link não encontrado.");
        return r.json();
      })
      .then((data: ShareInfo) => {
        setInfo(data);
        document.title = `${data.name} · enviado pelo Docke`;
        if (!data.has_password) fetchContent(null);
        else setLoading(false);
      })
      .catch((e) => { setError(friendly(e, "Link não encontrado.")); setLoading(false); });
  }, [token, retryKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail ?? "Não foi possível abrir este link.");
      setContent(data);
      if (data.type === "folder" && folderId && !data.is_root) {
        setPath((p) => [...p, { id: data.folder_id, name: data.name }]);
      } else if (data.type === "folder" && data.is_root) {
        setPath([]);
      }
    } catch (e) {
      // Senha errada mantém o formulário na tela para tentar de novo.
      if (!content && info?.has_password) setPasswordError(friendly(e, "Senha incorreta."));
      else setError(friendly(e, "Não foi possível abrir este link."));
    } finally {
      setLoading(false);
    }
  }

  async function downloadDoc(docId: string) {
    setDownloading(docId);
    try {
      const r = await fetch(`${API_BASE}/s/${token}/download/${docId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: password || null }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail ?? "Não foi possível baixar agora.");
      const a = document.createElement("a");
      a.href = data.download_url;
      a.download = data.name;
      a.click();
    } catch (e) {
      setError(friendly(e, "Não foi possível baixar agora."));
    } finally {
      window.setTimeout(() => setDownloading(null), 800);
    }
  }

  function navigateTo(folderId: string | null, crumbIndex?: number) {
    if (crumbIndex !== undefined) setPath((p) => p.slice(0, crumbIndex));
    fetchContent(folderId);
  }

  const canDownload = (content?.allow_download ?? info?.allow_download) !== false;
  const validade = info?.expires_at ? new Date(info.expires_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" }) : null;

  return (
    <main className="relative min-h-screen overflow-hidden flex flex-col items-center px-4 py-10" style={{ background: "var(--wallpaper)" }}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-80 dark:opacity-100"
        style={{
          background:
            "radial-gradient(680px circle at 16% 12%, rgba(13,148,136,0.20), transparent 55%)," +
            "radial-gradient(620px circle at 84% 82%, rgba(20,184,166,0.16), transparent 55%)," +
            "radial-gradient(900px circle at 50% 118%, rgba(13,148,136,0.12), transparent 60%)",
        }}
      />

      <div className="relative w-full max-w-[560px]">
        <div className="flex items-center justify-center mb-8">
          <div className="brand-wordmark w-[130px] h-[37px]" role="img" aria-label="Docke" />
        </div>

        <div className="glass-dialog glass-blur-strong rounded-(--radius-dialog) p-6 shadow-modal">
          {/* Quem enviou e até quando vale (A1-11) */}
          {info && !error && (info.company_name || info.sender_name || validade) && (
            <div className="reveal mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-(--border-default) pb-4 text-mac-caption text-(--text-secondary)">
              {(info.company_name || info.sender_name) && (
                <span className="inline-flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Enviado{info.sender_name ? ` por ${info.sender_name}` : ""}{info.company_name ? ` · ${info.company_name}` : ""}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock className="w-3.5 h-3.5" aria-hidden="true" />
                {validade ? `Vale até ${validade}` : "Sem data de validade"}
                {info.views_left != null ? ` · ${info.views_left} ${info.views_left === 1 ? "abertura restante" : "aberturas restantes"}` : ""}
              </span>
            </div>
          )}

          {loading && !content && !error && !info?.has_password && <Skeleton />}

          {error && (
            <div role="alert" className="flex flex-col items-center text-center gap-3 py-8">
              <AlertCircle className="w-10 h-10 text-(--text-secondary)" aria-hidden="true" />
              <p className="text-mac-body text-(--text-primary) max-w-[40ch]">{error}</p>
              {error.startsWith("Sem conexão") && (
                <Button variant="secondary" size="sm" onClick={() => setRetryKey((k) => k + 1)}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
              )}
            </div>
          )}

          {!error && info?.has_password && !content && (
            <form
              onSubmit={(e) => { e.preventDefault(); fetchContent(null); }}
              className="reveal flex flex-col items-stretch gap-4 py-2"
            >
              <div className="flex flex-col items-center gap-2 text-center">
                <div className="w-12 h-12 bg-amber-500/10 rounded-card flex items-center justify-center">
                  <Lock className="w-6 h-6 text-(--text-warning)" aria-hidden="true" />
                </div>
                <p className="text-mac-body text-(--text-primary) font-medium wrap-break-word">“{info.name}” está protegido por senha</p>
                <p className="text-mac-caption text-(--text-secondary)">A senha foi combinada com quem enviou o link.</p>
              </div>
              <Input
                label="Senha do link"
                type="password"
                autoFocus
                autoComplete="off"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setPasswordError(null); }}
                error={passwordError ?? undefined}
                disabled={loading}
              />
              <Button type="submit" loading={loading} className="w-full" disabled={!password}>
                Abrir
              </Button>
            </form>
          )}

          {!error && content?.type === "document" && (
            <div className="reveal text-center py-2">
              {(() => { const s = getFileStyle(content.name); const Icon = s.icon; return (
                <Icon className={`w-12 h-12 mx-auto mb-3 ${s.iconColor}`} strokeWidth={1.5} aria-hidden="true" />
              ); })()}
              <h1 className="text-mac-body font-medium text-(--text-primary) wrap-break-word">{content.name}</h1>
              {info?.size_bytes != null && <p className="text-mac-caption text-(--text-secondary) mb-4">{fmtSize(info.size_bytes)}</p>}
              {content.mime_type.startsWith("image/") ? (
                <img src={content.preview_url} alt={content.name} className="max-w-full max-h-[400px] mx-auto rounded-(--radius-control) mb-4" />
              ) : content.mime_type === "application/pdf" ? (
                <div className="h-[min(70vh,640px)] mb-4 rounded-(--radius-control) border border-(--border-default) overflow-hidden text-left">
                  <Suspense fallback={<div className="h-full flex items-center justify-center text-mac-body text-(--text-secondary)">Abrindo o PDF…</div>}>
                    <PdfViewer url={content.preview_url} />
                  </Suspense>
                </div>
              ) : null}
              {canDownload ? (
                <Button onClick={() => content.document_id && downloadDoc(content.document_id)} loading={downloading === content.document_id}>
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  {downloading === content.document_id ? "Baixando…" : "Baixar"}
                </Button>
              ) : (
                <p className="text-mac-caption text-(--text-secondary)">Quem enviou permitiu só visualizar este documento.</p>
              )}
            </div>
          )}

          {!error && content?.type === "folder" && (
            <div className="reveal" key={content.folder_id}>
              {path.length > 0 && (
                <nav aria-label="Caminho" className="flex flex-wrap items-center gap-1 mb-4 text-mac-caption text-(--text-secondary)">
                  <button onClick={() => navigateTo(null, 0)} className="min-h-6 pointer-coarse:min-h-11 hover:text-(--text-accent)">{info?.name ?? "Início"}</button>
                  {path.map((p, i) => (
                    <span key={p.id} className="flex items-center gap-1">
                      <ChevronRight className="w-3 h-3" aria-hidden="true" />
                      <button onClick={() => navigateTo(p.id, i + 1)} className="min-h-6 pointer-coarse:min-h-11 hover:text-(--text-accent)">{p.name}</button>
                    </span>
                  ))}
                </nav>
              )}
              <h1 className="text-mac-body font-medium text-(--text-primary) mb-3 flex items-center gap-2">
                <FolderOpen className="w-4 h-4 text-(--text-accent)" aria-hidden="true" />
                {content.name}
              </h1>
              {loading ? (
                <div className="space-y-2" role="status" aria-label="Carregando">{[0, 1, 2].map((i) => <div key={i} className="h-11 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>
              ) : (
                <ul className="divide-y divide-(--border-default) border border-(--border-default) rounded-(--radius-control) overflow-hidden">
                  {content.folders.map((f) => (
                    <li key={f.id}>
                      <button
                        onClick={() => navigateTo(f.id)}
                        className="w-full flex items-center gap-2 px-3 min-h-11 text-mac-body text-left text-(--text-primary) hover:bg-(--bg-hover) transition-colors duration-fast"
                      >
                        <FolderOpen className="w-4 h-4 text-(--text-accent) shrink-0" aria-hidden="true" />
                        {f.name}
                      </button>
                    </li>
                  ))}
                  {content.documents.map((d) => {
                    const s = getFileStyle(d.name); const Icon = s.icon;
                    return (
                      <li key={d.id} className="flex items-center gap-2 px-3 min-h-11 text-mac-body">
                        <div className={`w-6 h-6 rounded-badge flex items-center justify-center shrink-0 ${s.bgColor}`} aria-hidden="true">
                          <Icon className={`w-3.5 h-3.5 ${s.iconColor} ${s.fillColor}`} />
                        </div>
                        <span className="flex-1 truncate text-(--text-primary)" title={d.name}>{d.name}</span>
                        <span className="text-mac-caption text-(--text-secondary) tabular-nums">{fmtSize(d.size_bytes)}</span>
                        {canDownload && (
                          <button onClick={() => downloadDoc(d.id)} aria-label={`Baixar ${d.name}`} disabled={downloading === d.id}
                            className="w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 flex items-center justify-center rounded-full text-(--text-secondary) hover:text-(--text-primary) hover:bg-(--bg-hover) disabled:opacity-(--opacity-disabled)">
                            <Download className={`w-3.5 h-3.5 ${downloading === d.id ? "animate-bounce" : ""}`} aria-hidden="true" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                  {content.folders.length === 0 && content.documents.length === 0 && (
                    <li className="px-3 py-6 text-center text-mac-caption text-(--text-secondary)">Pasta vazia.</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>

        <p className="text-center text-mac-caption text-(--text-secondary) mt-6">
          Compartilhado com segurança pelo <span className="font-medium">Docke</span>
        </p>
      </div>
    </main>
  );
}
