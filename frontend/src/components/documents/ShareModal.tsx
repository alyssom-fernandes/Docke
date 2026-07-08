import { useEffect, useRef, useState } from "react";
import { X, Link2, Copy, Trash2, Lock } from "lucide-react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import api from "@/lib/api";
import { useToast } from "@/lib/toast";
import { relativeDate } from "@/lib/date";
import Button from "@/components/ui/Button";
import ConfirmModal from "@/components/ui/ConfirmModal";

interface ShareLink {
  id: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  last_accessed_at: string | null;
  created_at: string;
  has_password: boolean;
}

export default function ShareModal({
  resourceType, resourceId, name, onClose,
}: { resourceType: "document" | "folder"; resourceId: string; name: string; onClose: () => void }) {
  const { success, error: showError } = useToast();
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [expiresIn, setExpiresIn] = useState("7d");
  const [alwaysLatest, setAlwaysLatest] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newLink, setNewLink] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  function load() {
    setLoading(true);
    api.get<ShareLink[]>("/shares", { params: { resource_type: resourceType, resource_id: resourceId } })
      .then((r) => setLinks(Array.isArray(r.data) ? r.data.filter((l) => !l.revoked_at) : []))
      .catch(() => setLinks([]))
      .finally(() => setLoading(false));
  }

  useEffect(load, [resourceType, resourceId]);

  async function createLink() {
    setCreating(true);
    try {
      const { data } = await api.post("/shares", {
        resource_type: resourceType,
        resource_id: resourceId,
        password: usePassword ? password : null,
        expires_in: expiresIn,
        always_latest: alwaysLatest,
      });
      const url = `${window.location.origin}/s/${data.token}`;
      setNewLink(url);
      await navigator.clipboard.writeText(url).catch(() => {});
      success("Link criado e copiado para a área de transferência.");
      setPassword("");
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar o link.");
    } finally {
      setCreating(false);
    }
  }

  async function confirmRevoke() {
    if (!revokingId) return;
    try {
      await api.delete(`/shares/${revokingId}`);
      success("Link revogado.");
      load();
    } catch {
      showError("Erro ao revogar o link.");
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] shadow-modal modal-card w-full max-w-[480px] max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">Compartilhar "{name}"</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5" /> Proteger com senha
            </label>
            <input type="checkbox" checked={usePassword} onChange={(e) => setUsePassword(e.target.checked)} className="accent-teal-600 w-4 h-4" />
          </div>
          {usePassword && (
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Senha do link"
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
          )}

          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Expiração</label>
            <select
              value={expiresIn}
              onChange={(e) => setExpiresIn(e.target.value)}
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            >
              <option value="24h">24 horas</option>
              <option value="7d">7 dias</option>
              <option value="30d">30 dias</option>
              <option value="never">Nunca expira</option>
            </select>
          </div>

          {resourceType === "document" && (
            <div className="flex items-center justify-between">
              <label className="text-xs text-[var(--text-secondary)]">Vincular à versão mais recente (em vez de fixar a atual)</label>
              <input type="checkbox" checked={alwaysLatest} onChange={(e) => setAlwaysLatest(e.target.checked)} className="accent-teal-600 w-4 h-4" />
            </div>
          )}

          <Button size="sm" className="w-full" loading={creating} onClick={createLink} disabled={usePassword && !password.trim()}>
            <Link2 className="w-3.5 h-3.5" />
            Gerar link
          </Button>

          {newLink && (
            <div className="flex items-center gap-2 px-3 py-2 bg-teal-50 dark:bg-teal-900/20 border border-teal-200 dark:border-teal-900/40 rounded-[8px]">
              <span className="flex-1 text-xs text-teal-700 dark:text-teal-400 truncate font-mono">{newLink}</span>
              <button onClick={() => navigator.clipboard.writeText(newLink)} className="p-1 text-teal-600 hover:bg-teal-100 dark:hover:bg-teal-900/40 rounded">
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          <div className="pt-3 border-t border-[var(--border-default)]">
            <p className="text-xs font-medium text-[var(--text-secondary)] mb-2">Links ativos</p>
            {loading ? (
              <div className="h-10 bg-[var(--bg-hover)] rounded-[8px] animate-pulse" />
            ) : links.length === 0 ? (
              <p className="text-xs text-[var(--text-tertiary)]">Nenhum link ativo.</p>
            ) : (
              <ul className="space-y-1.5">
                {links.map((l) => (
                  <li key={l.id} className="flex items-center gap-2 px-2.5 py-2 bg-[var(--bg-page)] rounded-[8px] text-xs">
                    <div className="flex-1 min-w-0">
                      <p className="text-[var(--text-primary)]">
                        {l.has_password && <Lock className="w-3 h-3 inline mr-1" />}
                        {l.view_count} acesso{l.view_count !== 1 ? "s" : ""}
                      </p>
                      <p className="text-[var(--text-tertiary)]">
                        {l.expires_at ? `Expira ${relativeDate(l.expires_at)}` : "Nunca expira"}
                      </p>
                    </div>
                    <button onClick={() => setRevokingId(l.id)} title="Revogar" className="p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {revokingId && (
        <ConfirmModal
          title="Revogar link de compartilhamento?"
          description={`Quem tiver esse link de "${name}" perderá o acesso imediatamente. Essa ação não pode ser desfeita.`}
          confirmLabel="Revogar"
          danger
          onConfirm={confirmRevoke}
          onClose={() => setRevokingId(null)}
        />
      )}
    </div>
  );
}
