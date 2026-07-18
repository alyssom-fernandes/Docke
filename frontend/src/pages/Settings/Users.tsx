import { useEffect, useRef, useState } from "react";
import { Users as UsersIcon, UserPlus, X, Shield, RefreshCw, Plus, Folder, ChevronDown } from "lucide-react";
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
import Dropdown from "@/components/ui/Dropdown";
import Portal from "@/components/ui/Portal";

interface Grant {
  access_id: string;
  user_id: string;
  full_name: string;
  username: string;
  role: string;
  folder_id: string | null;
  folder_name: string | null;
}

interface FolderOption {
  id: string;
  name: string;
  path: string;
}

const ROLE_LABEL: Record<string, string> = { visualizador: "Visualizador", operador: "Operador", admin: "Admin" };
const ROLE_VARIANT: Record<string, "teal" | "info" | "default"> = { admin: "teal", operador: "info", visualizador: "default" };

const ROLES = [
  { role: "visualizador", label: "Visualizador", description: "Pode ver, baixar documentos e acompanhar o log de atividade. Não pode criar, mover ou excluir nada." },
  { role: "operador", label: "Operador", description: "Além de visualizar, pode fazer upload e mover documentos dentro do seu escopo — mas só pode excluir os documentos que ele mesmo inseriu. Não cria, renomeia ou exclui pastas." },
  { role: "admin", label: "Admin", description: "Acesso completo à empresa: upload, mover, excluir, versionar, gerenciar usuários e dados da organização." },
];

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function folderDepth(path: string) {
  return path.split(".").length;
}

function FolderSelect({ folders, value, onChange }: { folders: FolderOption[]; value: string; onChange: (v: string) => void }) {
  return (
    <Dropdown
      value={value}
      placeholder="Empresa toda"
      onChange={onChange}
      options={[
        { value: "", label: "Empresa toda" },
        ...folders.map((f) => ({ value: f.id, label: f.name, depth: Math.max(0, folderDepth(f.path) - 1) })),
      ]}
    />
  );
}

function CreateMemberModal({ companyId, folders, onClose, onDone }: { companyId: string; folders: FolderOption[]; onClose: () => void; onDone: () => void }) {
  const { success, error: showError } = useToast();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState(generatePassword());
  const [role, setRole] = useState("visualizador");
  const [folderId, setFolderId] = useState("");
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
        folder_id: folderId || null,
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
    <Portal>
    <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[440px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Novo usuário</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Nome completo</label>
            <input
              autoFocus
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Maria Silva"
              className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          </div>
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, "."))}
              placeholder="maria.silva"
              className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          </div>
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">E-mail (credencial de login)</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="maria@empresa.com"
              className="w-full h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
            />
          </div>
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Senha inicial</label>
            <div className="flex gap-2">
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex-1 h-9 px-3 text-mac-body font-mono bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
              />
              <button
                type="button"
                onClick={() => setPassword(generatePassword())}
                title="Gerar outra senha"
                className="h-9 w-9 flex items-center justify-center rounded-full border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
            <p className="text-mac-caption text-[var(--text-tertiary)] mt-1">Repasse essa senha por um canal seguro — a pessoa pode trocá-la depois em Configurações → Segurança.</p>
          </div>
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Papel</label>
            <Dropdown
              value={role}
              placeholder="Selecione…"
              onChange={setRole}
              options={[
                { value: "visualizador", label: "Visualizador" },
                { value: "operador", label: "Operador" },
                { value: "admin", label: "Admin" },
              ]}
            />
          </div>
          {role !== "admin" && (
            <div>
              <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Escopo (pasta)</label>
              <FolderSelect folders={folders} value={folderId} onChange={setFolderId} />
              <p className="text-mac-caption text-[var(--text-tertiary)] mt-1">Restrinja o acesso a uma pasta específica (ex: só o RH), ou deixe "Empresa toda" para acesso amplo.</p>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" loading={saving} onClick={create} disabled={!email.trim() || !username.trim() || !fullName.trim()}>
            Criar usuário
          </Button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

function AddGrantModal({ companyId, memberId, memberName, folders, onClose, onDone }: {
  companyId: string; memberId: string; memberName: string; folders: FolderOption[]; onClose: () => void; onDone: () => void;
}) {
  const { success, error: showError } = useToast();
  const [role, setRole] = useState("visualizador");
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  async function save() {
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/members/${memberId}/access`, {
        permission_level: role,
        folder_id: folderId || null,
      });
      success(`Nova concessão adicionada para ${memberName}.`);
      onDone();
      onClose();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível adicionar a concessão.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Portal>
    <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={containerRef} className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[400px]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
          <h2 className="text-mac-body font-semibold text-[var(--text-primary)]">Nova concessão — {memberName}</h2>
          <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Papel</label>
            <Dropdown
              value={role}
              placeholder="Selecione…"
              onChange={setRole}
              options={[
                { value: "visualizador", label: "Visualizador" },
                { value: "operador", label: "Operador" },
                { value: "admin", label: "Admin" },
              ]}
            />
          </div>
          <div>
            <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Escopo (pasta)</label>
            <FolderSelect folders={folders} value={folderId} onChange={setFolderId} />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" loading={saving} onClick={save}>Adicionar</Button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

export default function Users() {
  usePageTitle("Usuários");
  const { current } = useCompany();
  const { user } = useAuthContext();
  const { success, error: showError } = useToast();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [addingGrantFor, setAddingGrantFor] = useState<{ id: string; name: string } | null>(null);
  const [removingGrant, setRemovingGrant] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [rolesOpen, setRolesOpen] = useState(false);

  const canManage = user?.role === "supremo" || current?.permission_level === "admin";

  function load() {
    if (!current) return;
    setLoading(true);
    Promise.all([
      api.get<Grant[]>(`/companies/${current.id}/members`),
      api.get<FolderOption[]>(`/folders`, { params: { company_id: current.id, flat: true } }),
    ])
      .then(([membersRes, foldersRes]) => {
        setGrants(Array.isArray(membersRes.data) ? membersRes.data : []);
        setFolders(Array.isArray(foldersRes.data) ? foldersRes.data : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(load, [current?.id]);

  async function removeGrant(g: Grant) {
    if (!current) return;
    setBusy(true);
    try {
      await api.delete(`/companies/${current.id}/access/${g.access_id}`);
      success(`Concessão de ${g.full_name} removida.`);
      setRemovingGrant(null);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível remover a concessão.");
    } finally {
      setBusy(false);
    }
  }

  // Agrupa concessões por usuário — um mesmo usuário pode ter várias linhas
  // (uma por pasta escopada), cada uma com seu próprio access_id.
  const byUser = grants.reduce<Record<string, Grant[]>>((acc, g) => {
    (acc[g.user_id] ??= []).push(g);
    return acc;
  }, {});

  return (
    <div className="space-y-4">
      {canManage && current && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setCreating(true)}>
            <UserPlus className="w-3.5 h-3.5" />
            Novo usuário
          </Button>
        </div>
      )}

      {/* Uma única janela de vidro pra usuários + níveis de acesso (antes
          eram dois glass-panel empilhados, lendo como "duas caixas" — mesmo
          ajuste de unificação feito em Settings/Documents) — a segunda seção
          fica separada só por um border-t, igual ao padrão de Preferences.tsx
          (Tema/Densidade dentro do mesmo cartão). */}
      <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
        {loading ? (
          <div className="p-5 space-y-2">
            {[0, 1, 2].map((i) => <div key={i} className="h-14 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />)}
          </div>
        ) : Object.keys(byUser).length === 0 ? (
          <div className="py-8">
            <EmptyState title="Nenhum usuário" icon={<UsersIcon className="w-6 h-6" />} />
          </div>
        ) : (
          <ul>
            {Object.values(byUser).map((userGrants) => {
              const first = userGrants[0];
              return (
                <li key={first.user_id} className="flex items-start gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] border-b border-[var(--border-default)] last:border-0 group">
                  <Avatar name={first.full_name} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-mac-body font-medium text-[var(--text-primary)] truncate">{first.full_name}</p>
                    <p className="text-mac-caption text-[var(--text-secondary)] truncate mb-1.5">@{first.username}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {userGrants.map((g) => (
                        <span key={g.access_id} className="inline-flex items-center gap-1.5 pl-0.5 pr-1.5 py-0.5 rounded-full bg-[var(--bg-page)] border border-[var(--border-default)]">
                          <Badge variant={ROLE_VARIANT[g.role] ?? "default"}>{ROLE_LABEL[g.role] ?? g.role}</Badge>
                          <span className="text-mac-caption text-[var(--text-secondary)] flex items-center gap-1">
                            {g.folder_id ? (<><Folder className="w-3 h-3" />{g.folder_name ?? "Pasta"}</>) : "Empresa toda"}
                          </span>
                          {canManage && (
                            <button
                              onClick={() => setRemovingGrant(g)}
                              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors duration-fast"
                              title="Remover esta concessão"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          )}
                        </span>
                      ))}
                      {canManage && (
                        <button
                          onClick={() => setAddingGrantFor({ id: first.user_id, name: first.full_name })}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-dashed border-[var(--border-default)] text-mac-caption text-[var(--text-tertiary)] hover:text-teal-500 hover:border-teal-400 transition-colors duration-fast"
                        >
                          <Plus className="w-3 h-3" />
                          Adicionar
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Recolhível — é texto de referência/ajuda, não uma configuração em
            si, então não deve competir em espaço com a lista de usuários
            (a razão do pane existir). Fechado por padrão. */}
        <button
          onClick={() => setRolesOpen((v) => !v)}
          className="w-full px-5 py-3 border-t border-[var(--border-default)] flex items-center gap-2 text-left hover:bg-[var(--bg-hover)] transition-colors duration-fast"
        >
          <Shield className="w-4 h-4 text-teal-500" />
          <h3 className="text-mac-body font-medium text-[var(--text-primary)] flex-1">Sobre os níveis de acesso</h3>
          <ChevronDown className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform duration-fast ${rolesOpen ? "rotate-180" : ""}`} />
        </button>
        {rolesOpen && (
          <ul className="border-t border-[var(--border-default)]">
            {ROLES.map((r) => (
              <li key={r.role} className="flex items-start gap-4 px-5 py-4 border-b border-[var(--border-default)] last:border-0">
                <Badge variant={ROLE_VARIANT[r.role] ?? "default"}>{r.label}</Badge>
                <p className="text-mac-body text-[var(--text-secondary)]">{r.description}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {creating && current && (
        <CreateMemberModal companyId={current.id} folders={folders} onClose={() => setCreating(false)} onDone={load} />
      )}

      {addingGrantFor && current && (
        <AddGrantModal
          companyId={current.id}
          memberId={addingGrantFor.id}
          memberName={addingGrantFor.name}
          folders={folders}
          onClose={() => setAddingGrantFor(null)}
          onDone={load}
        />
      )}

      {removingGrant && (
        <ConfirmModal
          title={`Remover concessão de ${removingGrant.full_name}?`}
          description={removingGrant.folder_id
            ? `A pessoa perde o acesso "${ROLE_LABEL[removingGrant.role]}" à pasta "${removingGrant.folder_name}". Outras concessões dela não são afetadas.`
            : "A pessoa perde o acesso à empresa toda concedido por esta linha. Outras concessões dela não são afetadas."}
          confirmLabel="Remover"
          danger
          loading={busy}
          onConfirm={() => removeGrant(removingGrant)}
          onClose={() => setRemovingGrant(null)}
        />
      )}
    </div>
  );
}
