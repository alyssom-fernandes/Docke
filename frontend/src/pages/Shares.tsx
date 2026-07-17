import { useEffect, useState } from "react";
import { Link2, Lock, Trash2, FolderOpen, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { getFileStyle } from "@/lib/fileType";
import { relativeDate } from "@/lib/date";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import EmptyState from "@/components/shared/EmptyState";
import ConfirmModal from "@/components/ui/ConfirmModal";

interface ShareLink {
  id: string;
  resource_type: "document" | "folder";
  resource_id: string;
  resource_name: string | null;
  document_folder_id: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_accessed_at: string | null;
  created_at: string;
  has_password: boolean;
}

export default function Shares() {
  usePageTitle("Compartilhados");
  const { current } = useCompany();
  const navigate = useNavigate();
  const { success, error: showError } = useToast();
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<ShareLink | null>(null);

  function load() {
    if (!current) return;
    setLoading(true);
    api
      .get<ShareLink[]>("/shares", { params: { company_id: current.id } })
      .then((r) => setShares(Array.isArray(r.data) ? r.data.filter((s) => !s.revoked_at) : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, [current?.id]);

  async function confirmRevoke() {
    if (!revoking) return;
    try {
      await api.delete(`/shares/${revoking.id}`);
      setShares((prev) => prev.filter((s) => s.id !== revoking.id));
      success("Link revogado.");
    } catch {
      showError("Não foi possível revogar o link.");
    } finally {
      setRevoking(null);
    }
  }

  function openResource(share: ShareLink) {
    if (share.resource_type === "folder") {
      navigate(`/documents?folder_id=${share.resource_id}`);
    } else {
      navigate(`/documents?folder_id=${share.document_folder_id ?? ""}&doc=${share.resource_id}`);
    }
  }

  const isExpired = (s: ShareLink) => s.expires_at !== null && new Date(s.expires_at).getTime() < Date.now();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-mac-title2 font-semibold text-[var(--text-primary)]">Compartilhados</h1>
        <p className="text-mac-body text-[var(--text-secondary)] mt-1">
          Todos os links de compartilhamento externo ativos nesta empresa — seus próprios links e, se você for admin, os de toda a equipe.
        </p>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] animate-pulse" />
          ))}
        </div>
      ) : shares.length === 0 ? (
        <EmptyState
          title="Nenhum link ativo"
          description="Compartilhe um documento ou pasta usando o botão de compartilhar nos detalhes do item."
          icon={<Link2 className="w-6 h-6" />}
          action={
            <button
              onClick={() => navigate("/documents")}
              className="px-4 py-2 text-mac-body font-medium text-white bg-teal-600 rounded-full hover:bg-teal-500 transition-colors duration-fast"
            >
              Ir para Documentos
            </button>
          }
        />
      ) : (
        <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
          <ul>
            {shares.map((s) => (
              <li
                key={s.id}
                className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] transition-colors duration-fast border-b border-[var(--border-default)] last:border-0 group"
              >
                <button
                  onClick={() => openResource(s)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                  title="Abrir item compartilhado"
                >
                  {s.resource_type === "folder" ? (
                    <FolderOpen className="w-4 h-4 text-teal-500 flex-shrink-0" />
                  ) : (
                    (() => { const style = getFileStyle(s.resource_name ?? ""); const Icon = style.icon; return (
                      <div className={`w-6 h-6 rounded-[4px] flex items-center justify-center flex-shrink-0 ${style.bgColor}`}>
                        <Icon className={`w-3.5 h-3.5 ${style.iconColor} ${style.fillColor}`} />
                      </div>
                    ); })()
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="block text-mac-body text-[var(--text-primary)] truncate">
                      {s.resource_name ?? "(item removido)"}
                    </span>
                    <span className="block text-mac-caption text-[var(--text-tertiary)]">
                      {s.has_password && <Lock className="w-3 h-3 inline mr-1" />}
                      {s.view_count} acesso{s.view_count !== 1 ? "s" : ""} ·{" "}
                      {s.expires_at
                        ? isExpired(s)
                          ? "expirado"
                          : `expira ${relativeDate(s.expires_at)}`
                        : "nunca expira"}
                      {" · criado "}{relativeDate(s.created_at)}
                    </span>
                  </span>
                </button>
                <ExternalLink className="w-3.5 h-3.5 text-[var(--text-tertiary)] flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-fast" />
                <button
                  onClick={() => setRevoking(s)}
                  className="p-1.5 rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-all duration-fast flex-shrink-0"
                  title="Revogar link"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {revoking && (
        <ConfirmModal
          title="Revogar link de compartilhamento?"
          description={`Quem tiver o link de "${revoking.resource_name ?? "este item"}" perderá o acesso imediatamente. Essa ação não pode ser desfeita.`}
          confirmLabel="Revogar"
          danger
          onConfirm={confirmRevoke}
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
