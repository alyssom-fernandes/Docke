import { useEffect, useRef, useState } from "react";
import { Users as UsersIcon, UserPlus, X, Shield, RefreshCw, Plus, Folder, ChevronDown, UsersRound, Trash2, HelpCircle, Check, XCircle } from "lucide-react";
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

interface GroupSummary {
  id: string;
  name: string;
  created_at: string;
  member_count: number;
  grant_count: number;
}

interface GroupMember {
  user_id: string;
  full_name: string;
  username: string;
  added_at: string;
}

interface GroupGrant {
  access_id: string;
  role: string;
  folder_id: string | null;
  folder_name: string | null;
  created_at: string;
}

interface GroupDetail extends GroupSummary {
  members: GroupMember[];
  grants: GroupGrant[];
}

interface ExplainCandidate {
  source: "direto" | "grupo";
  group_name: string | null;
  permission_level: string;
  folder_path: string | null;
  folder_name: string | null;
  specificity: number;
  is_winner: boolean;
}

interface ExplainResult {
  resolved: string | null;
  candidates: ExplainCandidate[];
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

function ExplainAccessModal({ companyId, userId, userName, folders, onClose }: {
  companyId: string; userId: string; userName: string; folders: FolderOption[]; onClose: () => void;
}) {
  const [folderId, setFolderId] = useState("");
  const [result, setResult] = useState<ExplainResult | null>(null);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef);

  function load(fid: string) {
    setLoading(true);
    api.get<ExplainResult>(`/companies/${companyId}/explain-access`, {
      params: { user_id: userId, folder_id: fid || undefined },
    })
      .then((res) => setResult(res.data))
      .catch(() => setResult(null))
      .finally(() => setLoading(false));
  }
  useEffect(() => load(folderId), [folderId]);

  return (
    <Portal>
      <div className="fixed inset-0 bg-[var(--overlay-scrim)] flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div ref={containerRef} className="glass-dialog glass-blur-strong rounded-[var(--radius-dialog)] shadow-modal modal-card w-full max-w-[480px]">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)]">
            <h2 className="text-mac-body font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <HelpCircle className="w-4 h-4 text-teal-500" />
              Por que {userName} tem esse acesso?
            </h2>
            <button onClick={onClose} className="p-1 rounded-[6px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="p-5 space-y-4">
            <div>
              <label className="block text-mac-caption font-medium text-[var(--text-secondary)] mb-1.5">Escopo a verificar</label>
              <FolderSelect folders={folders} value={folderId} onChange={setFolderId} />
            </div>

            {loading ? (
              <div className="space-y-2">
                {[0, 1].map((i) => <div key={i} className="h-8 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />)}
              </div>
            ) : !result || result.candidates.length === 0 ? (
              <div className="space-y-2">
                <p className="text-mac-body text-[var(--text-primary)]">{userName} NÃO possui acesso a este escopo porque:</p>
                <ul className="space-y-1.5">
                  <li className="flex items-center gap-2 text-mac-body text-[var(--text-secondary)]">
                    <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" /> Não possui concessão direta que cubra este escopo
                  </li>
                  <li className="flex items-center gap-2 text-mac-body text-[var(--text-secondary)]">
                    <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" /> Não pertence a nenhum grupo com acesso a este escopo
                  </li>
                </ul>
                <div className="pt-2 border-t border-[var(--border-default)] flex items-center justify-between">
                  <span className="text-mac-caption text-[var(--text-tertiary)]">Resultado</span>
                  <Badge variant="default">Sem acesso</Badge>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-mac-body text-[var(--text-primary)]">{userName} possui acesso porque:</p>
                <ul className="space-y-1.5">
                  {result.candidates.map((c, i) => (
                    <li key={i} className={`flex items-start gap-2 text-mac-body ${c.is_winner ? "text-[var(--text-primary)]" : "text-[var(--text-tertiary)] line-through decoration-[var(--border-default)]"}`}>
                      {c.is_winner ? <Check className="w-4 h-4 text-teal-500 flex-shrink-0 mt-0.5" /> : <span className="w-4 h-4 flex-shrink-0" />}
                      <span>
                        {c.source === "grupo" ? <>Está no grupo <strong>{c.group_name}</strong>, que tem</> : "Tem concessão direta de"}{" "}
                        <Badge variant={ROLE_VARIANT[c.permission_level] ?? "default"}>{ROLE_LABEL[c.permission_level] ?? c.permission_level}</Badge>{" "}
                        {c.folder_path ? `na pasta "${c.folder_name ?? "?"}"` : "na empresa toda"}
                        {!c.is_winner && <span className="text-mac-caption"> (perde para uma concessão mais específica)</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="pt-2 border-t border-[var(--border-default)] flex items-center justify-between">
                  <span className="text-mac-caption text-[var(--text-tertiary)]">Resultado</span>
                  <Badge variant={ROLE_VARIANT[result.resolved ?? ""] ?? "default"}>{ROLE_LABEL[result.resolved ?? ""] ?? result.resolved}</Badge>
                </div>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-[var(--border-default)]">
            <Button variant="secondary" size="sm" onClick={onClose}>Fechar</Button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function GroupDetailPanel({ companyId, group, members, folders, canManage, onClose, onChanged }: {
  companyId: string; group: GroupSummary; members: { user_id: string; full_name: string; username: string }[];
  folders: FolderOption[]; canManage: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { success, error: showError } = useToast();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [addingMember, setAddingMember] = useState(false);
  const [memberToAdd, setMemberToAdd] = useState("");
  const [addingGrant, setAddingGrant] = useState(false);
  const [grantRole, setGrantRole] = useState("visualizador");
  const [grantFolder, setGrantFolder] = useState("");
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    api.get<GroupDetail>(`/companies/${companyId}/groups/${group.id}`)
      .then((res) => setDetail(res.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }
  useEffect(load, [group.id]);

  const memberOptions = members.filter((m) => !detail?.members.some((dm) => dm.user_id === m.user_id));

  async function addMember() {
    if (!memberToAdd) return;
    setBusy(true);
    try {
      await api.post(`/companies/${companyId}/groups/${group.id}/members`, { user_id: memberToAdd });
      success("Membro adicionado ao grupo.");
      setAddingMember(false);
      setMemberToAdd("");
      load();
      onChanged();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível adicionar o membro.");
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(userId: string) {
    setBusy(true);
    try {
      await api.delete(`/companies/${companyId}/groups/${group.id}/members/${userId}`);
      load();
      onChanged();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível remover o membro.");
    } finally {
      setBusy(false);
    }
  }

  async function addGrant() {
    setBusy(true);
    try {
      await api.post(`/companies/${companyId}/groups/${group.id}/access`, {
        permission_level: grantRole,
        folder_id: grantFolder || null,
      });
      success("Concessão adicionada ao grupo.");
      setAddingGrant(false);
      setGrantFolder("");
      load();
      onChanged();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível adicionar a concessão.");
    } finally {
      setBusy(false);
    }
  }

  async function removeGrant(accessId: string) {
    setBusy(true);
    try {
      await api.delete(`/companies/${companyId}/groups/${group.id}/access/${accessId}`);
      load();
      onChanged();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível remover a concessão.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-[var(--border-default)] last:border-0 bg-[var(--bg-page)]/40">
      <div className="px-5 py-3">
        {loading || !detail ? (
          <div className="h-6 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse w-1/3" />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-mac-caption font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Membros</p>
              {canManage && !addingMember && (
                <button onClick={() => setAddingMember(true)} className="inline-flex items-center gap-1 text-mac-caption text-teal-500 hover:text-teal-600">
                  <Plus className="w-3 h-3" /> Adicionar
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {detail.members.length === 0 && <span className="text-mac-caption text-[var(--text-tertiary)]">Nenhum membro ainda.</span>}
              {detail.members.map((m) => (
                <span key={m.user_id} className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded-full bg-[var(--bg-card)] border border-[var(--border-default)] text-mac-caption text-[var(--text-primary)]">
                  {m.full_name}
                  {canManage && (
                    <button onClick={() => removeMember(m.user_id)} disabled={busy} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {addingMember && (
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Dropdown
                    value={memberToAdd}
                    placeholder="Selecione um usuário…"
                    onChange={setMemberToAdd}
                    options={memberOptions.map((m) => ({ value: m.user_id, label: `${m.full_name} (@${m.username})` }))}
                  />
                </div>
                <Button size="sm" onClick={addMember} loading={busy} disabled={!memberToAdd}>Adicionar</Button>
                <Button size="sm" variant="secondary" onClick={() => { setAddingMember(false); setMemberToAdd(""); }}>Cancelar</Button>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-[var(--border-default)]">
              <p className="text-mac-caption font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">Acesso concedido ao grupo</p>
              {canManage && !addingGrant && (
                <button onClick={() => setAddingGrant(true)} className="inline-flex items-center gap-1 text-mac-caption text-teal-500 hover:text-teal-600">
                  <Plus className="w-3 h-3" /> Conceder
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {detail.grants.length === 0 && <span className="text-mac-caption text-[var(--text-tertiary)]">Nenhuma concessão ainda — o grupo não dá acesso a nada.</span>}
              {detail.grants.map((g) => (
                <span key={g.access_id} className="inline-flex items-center gap-1.5 pl-0.5 pr-1.5 py-0.5 rounded-full bg-[var(--bg-page)] border border-[var(--border-default)]">
                  <Badge variant={ROLE_VARIANT[g.role] ?? "default"}>{ROLE_LABEL[g.role] ?? g.role}</Badge>
                  <span className="text-mac-caption text-[var(--text-secondary)] flex items-center gap-1">
                    {g.folder_id ? (<><Folder className="w-3 h-3" />{g.folder_name ?? "Pasta"}</>) : "Empresa toda"}
                  </span>
                  {canManage && (
                    <button onClick={() => removeGrant(g.access_id)} disabled={busy} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {addingGrant && (
              <div className="flex items-end gap-2 flex-wrap">
                <div className="w-[160px]">
                  <label className="block text-mac-caption text-[var(--text-tertiary)] mb-1">Papel</label>
                  <Dropdown value={grantRole} placeholder="Selecione…" onChange={setGrantRole} options={[
                    { value: "visualizador", label: "Visualizador" },
                    { value: "operador", label: "Operador" },
                    { value: "admin", label: "Admin" },
                  ]} />
                </div>
                <div className="flex-1 min-w-[180px]">
                  <label className="block text-mac-caption text-[var(--text-tertiary)] mb-1">Escopo</label>
                  <FolderSelect folders={folders} value={grantFolder} onChange={setGrantFolder} />
                </div>
                <Button size="sm" onClick={addGrant} loading={busy}>Conceder</Button>
                <Button size="sm" variant="secondary" onClick={() => { setAddingGrant(false); setGrantFolder(""); }}>Cancelar</Button>
              </div>
            )}
          </div>
        )}
      </div>
      <button onClick={onClose} className="w-full px-5 py-1.5 border-t border-[var(--border-default)] text-mac-caption text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors duration-fast">
        Recolher
      </button>
    </li>
  );
}

function GroupsSection({ companyId, members, folders, canManage }: {
  companyId: string; members: { user_id: string; full_name: string; username: string }[]; folders: FolderOption[]; canManage: boolean;
}) {
  const { success, error: showError } = useToast();
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<GroupSummary | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    api.get<GroupSummary[]>(`/companies/${companyId}/groups`)
      .then((res) => setGroups(Array.isArray(res.data) ? res.data : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }
  useEffect(load, [companyId]);

  async function createGroup() {
    const name = newName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/groups`, { name });
      success(`Grupo "${name}" criado.`);
      setNewName("");
      setCreating(false);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível criar o grupo.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteGroup(g: GroupSummary) {
    setBusy(true);
    try {
      await api.delete(`/companies/${companyId}/groups/${g.id}`);
      success(`Grupo "${g.name}" removido.`);
      setRemoving(null);
      if (expanded === g.id) setExpanded(null);
      load();
    } catch (e: any) {
      showError(e?.response?.data?.detail ?? "Não foi possível remover o grupo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass-panel glass-blur-card glass-highlight-line rounded-[var(--radius-panel)] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-2">
          <UsersRound className="w-4 h-4 text-teal-500" />
          <h3 className="text-mac-body font-medium text-[var(--text-primary)]">Grupos</h3>
        </div>
        {canManage && !creating && (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus className="w-3.5 h-3.5" /> Novo grupo
          </Button>
        )}
      </div>

      {creating && (
        <div className="flex items-center gap-2 px-5 py-3 border-b border-[var(--border-default)]">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createGroup(); if (e.key === "Escape") setCreating(false); }}
            placeholder="Nome do grupo (ex: Grupo Financeiro)"
            className="flex-1 h-9 px-3 text-mac-body bg-[var(--bg-card)] border border-[var(--border-default)] rounded-[var(--radius-control)] text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-[3px] focus:ring-teal-500/70"
          />
          <Button size="sm" onClick={createGroup} loading={saving} disabled={!newName.trim()}>Criar</Button>
          <Button size="sm" variant="secondary" onClick={() => { setCreating(false); setNewName(""); }}>Cancelar</Button>
        </div>
      )}

      {loading ? (
        <div className="p-5 space-y-2">
          {[0, 1].map((i) => <div key={i} className="h-10 bg-[var(--bg-hover)] rounded-[var(--radius-control)] animate-pulse" />)}
        </div>
      ) : groups.length === 0 ? (
        <div className="py-6 px-5 text-mac-caption text-[var(--text-tertiary)]">
          Nenhum grupo ainda. Grupos permitem conceder acesso a vários usuários de uma vez — o acesso de um usuário via grupo é resolvido junto com as concessões diretas dele, com a mesma regra de especificidade (a mais próxima da pasta vence).
        </div>
      ) : (
        <ul>
          {groups.map((g) => (
            <div key={g.id}>
              <li
                className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--bg-hover)] border-b border-[var(--border-default)] cursor-pointer group"
                onClick={() => setExpanded(expanded === g.id ? null : g.id)}
              >
                <div className="w-8 h-8 rounded-full bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
                  <UsersRound className="w-4 h-4 text-indigo-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-mac-body font-medium text-[var(--text-primary)] truncate">{g.name}</p>
                  <p className="text-mac-caption text-[var(--text-tertiary)]">
                    {g.member_count} {g.member_count === 1 ? "membro" : "membros"} · {g.grant_count} {g.grant_count === 1 ? "concessão" : "concessões"}
                  </p>
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform duration-fast ${expanded === g.id ? "rotate-180" : ""}`} />
                {canManage && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setRemoving(g); }}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded-[6px] text-[var(--text-tertiary)] hover:text-red-500 hover:bg-red-500/10 transition-all duration-fast"
                    title="Excluir grupo"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </li>
              {expanded === g.id && (
                <GroupDetailPanel
                  companyId={companyId}
                  group={g}
                  members={members}
                  folders={folders}
                  canManage={canManage}
                  onClose={() => setExpanded(null)}
                  onChanged={load}
                />
              )}
            </div>
          ))}
        </ul>
      )}

      {removing && (
        <ConfirmModal
          title={`Excluir o grupo "${removing.name}"?`}
          description="Todos os membros e concessões de acesso deste grupo são removidos junto. Usuários que só tinham acesso via este grupo perdem esse acesso — o restante das concessões deles (diretas ou de outros grupos) não é afetado."
          confirmLabel="Excluir grupo"
          danger
          loading={busy}
          onConfirm={() => deleteGroup(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
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
  const [explaining, setExplaining] = useState<{ id: string; name: string } | null>(null);
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
                    <div className="flex items-center gap-1.5">
                      <p className="text-mac-body font-medium text-[var(--text-primary)] truncate">{first.full_name}</p>
                      {canManage && (
                        <button
                          onClick={() => setExplaining({ id: first.user_id, name: first.full_name })}
                          title="Explicar este acesso"
                          className="text-[var(--text-tertiary)] hover:text-teal-500 transition-colors duration-fast flex-shrink-0"
                        >
                          <HelpCircle className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
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

      {current && (
        <GroupsSection
          companyId={current.id}
          members={Object.values(byUser).map((g) => ({ user_id: g[0].user_id, full_name: g[0].full_name, username: g[0].username }))}
          folders={folders}
          canManage={canManage}
        />
      )}

      {creating && current && (
        <CreateMemberModal companyId={current.id} folders={folders} onClose={() => setCreating(false)} onDone={load} />
      )}

      {explaining && current && (
        <ExplainAccessModal
          companyId={current.id}
          userId={explaining.id}
          userName={explaining.name}
          folders={folders}
          onClose={() => setExplaining(null)}
        />
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
