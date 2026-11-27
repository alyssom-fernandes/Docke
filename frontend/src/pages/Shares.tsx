import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Link2, Lock, Folder, AlertTriangle, RefreshCw, Eye, Pencil, Ban, History } from "lucide-react";
import { getFileStyle } from "@/lib/fileType";
import { relativeDate, fullDate } from "@/lib/date";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useAuthContext } from "@/lib/AuthContext";
import { useToast } from "@/lib/toast";
import EmptyState from "@/components/shared/EmptyState";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import ShareModal from "@/components/documents/ShareModal";

interface ShareLink {
  id: string;
  resource_type: "document" | "folder";
  resource_id: string;
  resource_name: string | null;
  document_folder_id: string | null;
  expires_at: string | null;
  expired_at?: string | null;
  revoked_at: string | null;
  view_count: number;
  max_views?: number | null;
  allow_download?: boolean;
  last_accessed_at: string | null;
  created_at: string;
  has_password: boolean;
  created_by?: string | null;
  created_by_name?: string | null;
}

type Filtro = "ativos" | "encerrados" | "meus";

function situacao(s: ShareLink): { ativo: boolean; texto: string } {
  if (s.revoked_at) return { ativo: false, texto: `revogado ${relativeDate(s.revoked_at)}` };
  if (s.expired_at) return { ativo: false, texto: "encerrado (o item mudou ou saiu)" };
  if (s.expires_at && new Date(s.expires_at).getTime() < Date.now()) return { ativo: false, texto: `expirou ${relativeDate(s.expires_at)}` };
  if (s.max_views && s.view_count >= s.max_views) return { ativo: false, texto: "limite de aberturas atingido" };
  return { ativo: true, texto: s.expires_at ? `vale até ${new Date(s.expires_at).toLocaleDateString("pt-BR")}` : "sem prazo" };
}

/**
 * Links (A6-16..A6-21): mesmo nome do Dock; ativos, encerrados e "meus";
 * quem criou, último acesso e quantas aberturas; histórico de acessos;
 * editar validade, senha e limite; revogar com confirmação e indicador.
 */
export default function Shares() {
  usePageTitle("Links");
  const { current } = useCompany();
  const { user } = useAuthContext();
  const { success, error: showError } = useToast();
  const [shares, setShares] = useState<ShareLink[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filtro, setFiltro] = useState<Filtro>("ativos");
  const [revoking, setRevoking] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ShareLink | null>(null);
  const [accesses, setAccesses] = useState<ShareLink | null>(null);

  function load() {
    if (!current) return;
    setFailed(false);
    api.get<ShareLink[]>("/shares", { params: { company_id: current.id } })
      .then((r) => setShares(Array.isArray(r.data) ? r.data : []))
      .catch(() => setFailed(true));
  }
  useEffect(load, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function confirmRevoke() {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.delete(`/shares/${revoking.id}`);
      success("Link revogado: quem tiver o endereço não abre mais.");
      setRevoking(null);
      load();
    } catch {
      showError("Não foi possível revogar o link. Tente de novo.");
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(() => {
    const list = shares ?? [];
    if (filtro === "meus") return list.filter((s) => s.created_by === user?.id && situacao(s).ativo);
    return list.filter((s) => situacao(s).ativo === (filtro === "ativos"));
  }, [shares, filtro, user?.id]);

  const href = (s: ShareLink) => (s.resource_type === "folder" ? `/documents?folder_id=${s.resource_id}` : `/documents?folder_id=${s.document_folder_id ?? ""}&doc=${s.resource_id}`);
  const ativos = (shares ?? []).filter((s) => situacao(s).ativo).length;

  return (
    <div className="space-y-6 max-w-[1100px] w-full mx-auto">
      <div>
        <h1 className="text-mac-title1 sm:text-mac-large font-bold display-type text-(--text-primary)">Links</h1>
        <p className="text-mac-caption text-(--text-secondary) mt-0.5">Links que levam documentos e pastas para fora do Docke. Admins veem os de toda a empresa.</p>
      </div>

      {failed ? (
        <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) flex flex-wrap items-center gap-3 px-5 py-4">
          <AlertTriangle className="w-4 h-4 text-(--text-warning)" aria-hidden="true" />
          <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar os links.</p>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
        </div>
      ) : !shares ? (
        <div className="space-y-2" aria-label="Carregando">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>
      ) : shares.length === 0 ? (
        <EmptyState title="Nenhum link criado" icon={<Link2 className="w-6 h-6" />}
          description="No menu de um documento ou pasta, escolha “Compartilhar por link” para mandar a quem não usa o Docke, com prazo e senha se quiser." />
      ) : (
        <>
          <div role="group" aria-label="Quais links" className="flex flex-wrap items-center gap-0.5 p-0.5 rounded-full bg-(--bg-hover) w-fit">
            {([["ativos", `Ativos (${ativos})`], ["meus", "Criados por mim"], ["encerrados", "Expirados e revogados"]] as const).map(([v, l]) => (
              <button key={v} aria-pressed={filtro === v} onClick={() => setFiltro(v)}
                className={`px-3 h-8 pointer-coarse:h-10 rounded-full text-mac-body font-medium transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${filtro === v ? "bg-(--bg-card) text-(--text-primary) shadow-sm" : "text-(--text-secondary) hover:text-(--text-primary)"}`}>{l}</button>
            ))}
          </div>
          {visible.length === 0 ? (
            <p className="text-mac-body text-(--text-secondary)">Nenhum link aqui.</p>
          ) : (
            <ul className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden">
              {visible.map((s) => {
                const st = situacao(s);
                const fs = getFileStyle(s.resource_name ?? "");
                const Icon = s.resource_type === "folder" ? Folder : fs.icon;
                return (
                  <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 sm:px-5 py-3 border-b border-(--border-default) last:border-0">
                    <span className={`w-8 h-8 rounded-badge flex items-center justify-center shrink-0 ${s.resource_type === "folder" ? "bg-(--tint-accent)" : fs.bgColor}`} aria-hidden="true">
                      <Icon className={`w-4 h-4 ${s.resource_type === "folder" ? "text-(--text-accent)" : `${fs.iconColor} ${fs.fillColor}`}`} />
                    </span>
                    <div className="flex-1 min-w-[14rem]">
                      <Link to={href(s)} className="block truncate text-mac-body text-(--text-primary) hover:underline">{s.resource_name ?? "Item excluído"}</Link>
                      <p className="text-mac-caption text-(--text-secondary)">
                        <span className={st.ativo ? "" : "text-(--text-warning)"}>{st.texto}</span>
                        {" · "}{s.view_count}{s.max_views ? ` de ${s.max_views}` : ""} {s.view_count === 1 ? "abertura" : "aberturas"}
                        {s.last_accessed_at ? <> · última <time dateTime={s.last_accessed_at} title={fullDate(s.last_accessed_at)}>{relativeDate(s.last_accessed_at)}</time></> : " · nunca aberto"}
                        {s.has_password && <> · <Lock className="inline w-3 h-3 -mt-0.5" aria-hidden="true" /> com senha</>}
                        {s.allow_download === false && " · só visualizar"}
                      </p>
                      <p className="text-mac-caption text-(--text-secondary)">Criado <time dateTime={s.created_at} title={fullDate(s.created_at)}>{relativeDate(s.created_at)}</time>{s.created_by_name ? ` por ${s.created_by_name}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="sm" onClick={() => setAccesses(s)} aria-label={`Ver acessos do link de ${s.resource_name ?? "item"}`}><History className="w-3.5 h-3.5" aria-hidden="true" /> Acessos</Button>
                      {st.ativo && (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setEditing(s)} aria-label={`Editar link de ${s.resource_name ?? "item"}`}><Pencil className="w-3.5 h-3.5" aria-hidden="true" /> Editar</Button>
                          <Button variant="ghost" size="sm" onClick={() => setRevoking(s)} aria-label={`Revogar link de ${s.resource_name ?? "item"}`}><Ban className="w-3.5 h-3.5" aria-hidden="true" /> Revogar</Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-mac-caption text-(--text-secondary)">Por segurança o endereço completo só aparece quando o link é criado. Para mandar de novo, crie outro link no item.</p>
        </>
      )}

      {revoking && (
        <ConfirmModal
          title="Revogar este link?"
          description={<>Quem tiver o endereço de “{revoking.resource_name ?? "item"}” não abre mais. O documento continua no Docke.</>}
          confirmLabel="Revogar" danger loading={busy}
          onClose={() => setRevoking(null)} onConfirm={confirmRevoke}
        />
      )}
      {editing && (
        <ShareModal resourceType={editing.resource_type} resourceId={editing.resource_id} name={editing.resource_name ?? "item"}
          onClose={() => { setEditing(null); load(); }} />
      )}
      {accesses && <AccessesDialog share={accesses} onClose={() => setAccesses(null)} />}
    </div>
  );
}

function AccessesDialog({ share, onClose }: { share: ShareLink; onClose: () => void }) {
  const [rows, setRows] = useState<{ id: string; accessed_at: string; success: boolean; user_agent: string | null }[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    api.get(`/shares/${share.id}/accesses`).then((r) => setRows(r.data ?? [])).catch(() => setFailed(true));
  }, [share.id]);
  const browser = (ua: string | null) => {
    if (!ua) return "navegador desconhecido";
    if (/Edg\//.test(ua)) return "Edge"; if (/Chrome\//.test(ua)) return "Chrome"; if (/Firefox\//.test(ua)) return "Firefox";
    if (/Safari\//.test(ua)) return "Safari"; return "outro navegador";
  };
  return (
    <Dialog onClose={onClose} title={`Acessos ao link de “${share.resource_name ?? "item"}”`} size="md"
      description="Cada abertura do link, com data e se deu certo. Por privacidade o endereço IP não é guardado em claro.">
      {failed ? <p className="text-mac-body text-(--text-danger)">Não foi possível carregar os acessos.</p> : !rows ? <div className="h-24 rounded bg-(--bg-hover) animate-pulse" /> : rows.length === 0 ? (
        <p className="text-mac-body text-(--text-secondary)">Ninguém abriu este link ainda.</p>
      ) : (
        <ul className="divide-y divide-(--border-default)">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 py-2">
              <Eye className={`w-4 h-4 shrink-0 ${r.success ? "text-(--text-success)" : "text-(--text-danger)"}`} aria-hidden="true" />
              <span className="flex-1 text-mac-body text-(--text-primary)">{new Date(r.accessed_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</span>
              <span className="text-mac-caption text-(--text-secondary)">{r.success ? "abriu" : "barrado (senha, prazo ou limite)"} · {browser(r.user_agent)}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
