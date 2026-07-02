import { useEffect, useRef, useState } from "react";
import { Users as UsersIcon, UserPlus, X, Trash2, Shield, RefreshCw } from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { useAuthContext } from "@/lib/AuthContext";
import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import EmptyState from "@/components/shared/EmptyState";
import ConfirmModal from "@/components/ui/ConfirmModal";

interface Member {
  user_id: string;
  full_name: string;
  username: string;
  role: string;
}

const ROLE_LABEL: Record<string, string> = { visualizador: "Visualizador", auditor: "Auditor", admin: "Admin" };
const ROLE_VARIANT: Record<string, "teal" | "info" | "default"> = { admin: "teal", auditor: "info", visualizador: "default" };

const ROLES = [
  { role: "visualizador", label: "Visualizador", description: "Pode ver e baixar documentos, mas não pode criar, mover, excluir ou ver o log de atividade." },
  { role: "auditor", label: "Auditor", description: "Acesso somente leitura: vê e baixa documentos, e também acompanha o log de atividade da empresa. Não pode alterar nada." },
  { role: "admin", label: "Admin", description: "Acesso completo à empresa: upload, mover, excluir, versionar, gerenciar usuários e dados da organização." },
];

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function CreateMemberModal({ companyId, onClose, onDone }: { companyId: string; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState(generatePassword());
  const [role, setRole] = useState("visualizador");
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  async function create() {
    if (!email.trim() || !username.trim() || !fullName.trim()) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/members`, {
        email: email.trim(),
        password,
        username: username.trim(),
        full_name: fullName.trim(),
        permission_level: role,
      });
      success(`Usuário ${fullName.trim()} criado. Senha inicial: ${password}`);
      onDone();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar o usuário.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] shadow-modal modal-card w-full max-w-[440px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Novo usuário</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Nome completo</label>
            <input
              autoFocus
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Maria Silva"
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, "."))}
              placeholder="maria.silva"
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">E-mail (credencial de login)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="maria@empresa.com"
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Senha inicial</label>
            <div className="flex gap-2">
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex-1 h-9 px-3 text-sm font-mono bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-400"
              />
              <button
                type="button"
                onClick={() => setPassword(generatePassword())}
                title="Gerar outra senha"
                className="h-9 w-9 flex items-center justify-center rounded-[8px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-xs text-[var(--text-tertiary)] mt-1">Repasse essa senha por um canal seguro — a pessoa pode trocá-la depois em Configurações → Segurança.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">Papel</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full h-9 px-3 text-sm bg-[var(--bg-page)] border border-[var(--border-default)] rounded-[8px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-teal-400"
            >
              <option value="visualizador">Visualizador</option>
              <option value="auditor">Auditor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" loading={saving} onClick={create} disabled={!email.trim() || !username.trim() || !fullName.trim()}>
            Criar usuário
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Users() {
  usePageTitle("Usuários");
  const { current } = useCompany();
  const { user } = useAuthContext();
  const { success, error: showError } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

  const canManage = user?.role === "supremo" || current?.permission_level === "admin";

  function load() {
    if (!current) return;
    setLoading(true);
    api
      .get<Member[]>(`/companies/${current.id}/members`)
      .then((r) => setMembers(Array.isArray(r.data) ? r.data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, [current?.id]);

  async function removeMember(m: Member) {
    if (!current) return;
    setBusy(true);
    try {
      await api.delete(`/companies/${current.id}/members/${m.user_id}`);
      success(`Acesso de ${m.full_name} removido.`);
      setRemoving(null);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível remover o acesso.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">Usuários & Papéis</h2>
        {canManage && current && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <UserPlus className="w-3.5 h-3.5" />
            Novo usuário
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-14 bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[8px] animate-pulse" />)}
        </div>
      ) : members.length === 0 ? (
        <EmptyState title="Nenhum usuário" icon={<UsersIcon className="w-6 h-6" />} />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
          <ul>
            {members.map((m) => (
              <li
                key={m.user_id}
                className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] border-b border-[var(--border-default)] last:border-0 group"
              >
                <Avatar name={m.full_name} size="sm" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-primary)] truncate">{m.full_name}</p>
                  <p className="text-xs text-[var(--text-secondary)] truncate">@{m.username}</p>
                </div>
                <Badge variant={ROLE_VARIANT[m.role] ?? "default"}>{ROLE_LABEL[m.role] ?? m.role}</Badge>
                {canManage && (
                  <button
                    onClick={() => setRemoving(m)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-[6px] text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-all duration-fast"
                    title="Remover acesso"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[12px] overflow-hidden">
        <div className="px-5 py-3 border-b border-[var(--border-default)] flex items-center gap-2">
          <Shield className="w-4 h-4 text-teal-600" />
          <h3 className="text-sm font-medium text-[var(--text-primary)]">Níveis de acesso</h3>
        </div>
        <ul>
          {ROLES.map((r) => (
            <li key={r.role} className="flex items-start gap-4 px-5 py-4 border-b border-[var(--border-default)] last:border-0">
              <Badge variant={ROLE_VARIANT[r.role] ?? "default"}>{r.label}</Badge>
              <p className="text-sm text-[var(--text-secondary)]">{r.description}</p>
            </li>
          ))}
        </ul>
      </div>

      {creating && current && (
        <CreateMemberModal companyId={current.id} onClose={() => setCreating(false)} onDone={load} />
      )}

      {removing && (
        <ConfirmModal
          title={`Remover acesso de ${removing.full_name}?`}
          description="A pessoa deixa de ter acesso a esta empresa. Você pode conceder acesso novamente depois, se precisar."
          confirmLabel="Remover"
          danger
          loading={busy}
          onConfirm={() => removeMember(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
