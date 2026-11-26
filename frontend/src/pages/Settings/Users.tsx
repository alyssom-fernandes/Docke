import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  UserPlus, RefreshCw, Plus, Trash2, Check, AlertTriangle, Search, UsersRound, KeyRound, Ban, RotateCcw, Copy, ChevronRight, HelpCircle, Download, Smartphone,
} from "lucide-react";
import { usePageTitle } from "@/hooks/usePageTitle";
import api from "@/lib/api";
import { useCompany } from "@/lib/CompanyContext";
import { useToast } from "@/lib/toast";
import { useAuthContext } from "@/lib/AuthContext";
import { relativeDate } from "@/lib/date";
import Avatar from "@/components/ui/Avatar";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import ConfirmModal from "@/components/ui/ConfirmModal";
import Dropdown from "@/components/ui/Dropdown";
import { friendly } from "@/components/obligations/shared";

interface DirectGrant { access_id: string; role: string; folder_id: string | null; folder_name: string | null }
interface GroupGrantRef { group_id: string; group_name: string; role: string; folder_id: string | null; folder_name: string | null }
interface Person {
  user_id: string; username: string; full_name: string; email: string | null; is_active: boolean; role: string;
  must_change_password: boolean; mfa_enabled?: boolean; last_sign_in_at: string | null; grants: DirectGrant[]; via_groups: GroupGrantRef[]; company_count: number;
}
interface FolderOption { id: string; name: string; path: string }
interface GroupSummary { id: string; name: string; member_count: number; grant_count: number }
interface GroupDetail extends GroupSummary {
  members: { user_id: string; full_name: string; username: string }[];
  grants: { access_id: string; role: string; folder_id: string | null; folder_name: string | null }[];
}
interface ExplainResult {
  resolved: string | null;
  candidates: { source: "direto" | "grupo"; group_name: string | null; permission_level: string; folder_path: string | null; folder_name: string | null; is_winner: boolean }[];
}

const ROLE_LABEL: Record<string, string> = { visualizador: "Visualizador", operador: "Operador", admin: "Administrador" };
const ROLE_HELP: Record<string, string> = {
  visualizador: "Vê e baixa documentos e acompanha a atividade. Não cria, move nem exclui.",
  operador: "Também envia e move documentos no seu escopo; exclui só o que ele mesmo enviou. Não mexe em pastas.",
  admin: "Tudo na empresa ou na pasta: enviar, mover, excluir, versões, pessoas, obrigações e retenção.",
};
const ROLE_OPTS = Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label }));

function where(folder: string | null) { return folder ? `em ${folder}` : "na empresa toda"; }

function folderOptions(folders: FolderOption[]) {
  return [{ value: "", label: "Empresa toda" }, ...[...folders].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ value: f.id, label: f.name, depth: f.path.split(".").length - 1 }))];
}

function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = new Uint32Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => chars[n % chars.length]).join("");
}

/**
 * Pessoas e acessos (A9-16..A9-39): lista com acesso direto e por grupo,
 * busca e filtros; cada pessoa num painel com papel trocado no lugar,
 * explicar acesso, desativar, senha provisória e remover; grupos com
 * diálogos acessíveis. Erro é erro, não "nenhum usuário".
 */
export default function Users() {
  usePageTitle("Pessoas e acessos");
  const { current } = useCompany();
  const { user } = useAuthContext();
  const [params, setParams] = useSearchParams();
  const uid = useId();
  const folderFilter = params.get("folder");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error" | "forbidden">("loading");
  const [folders, setFolders] = useState<FolderOption[]>([]);
  const [q, setQ] = useState("");
  const [papel, setPapel] = useState("");
  const [estado, setEstado] = useState("ativas");
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [aba, setAba] = useState<"pessoas" | "grupos">("pessoas");

  function load() {
    if (!current) return;
    api.get<Person[]>(`/companies/${current.id}/people`)
      .then((r) => { setPeople(r.data ?? []); setState("ok"); })
      .catch((e) => setState(e?.response?.status === 403 ? "forbidden" : "error"));
    api.get<FolderOption[]>("/folders", { params: { company_id: current.id, flat: true } }).then((r) => setFolders(r.data ?? [])).catch(() => setFolders([]));
  }
  useEffect(load, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const folderName = folderFilter ? folders.find((f) => f.id === folderFilter)?.name : null;
  const visible = useMemo(() => {
    let list = people ?? [];
    if (estado === "ativas") list = list.filter((p) => p.is_active);
    if (estado === "desativadas") list = list.filter((p) => !p.is_active);
    if (estado === "grupo") list = list.filter((p) => p.via_groups.length > 0);
    if (papel) list = list.filter((p) => p.grants.some((g) => g.role === papel) || p.via_groups.some((g) => g.role === papel));
    if (folderFilter) list = list.filter((p) => p.grants.some((g) => !g.folder_id || g.folder_id === folderFilter) || p.via_groups.some((g) => !g.folder_id || g.folder_id === folderFilter));
    const s = q.trim().toLocaleLowerCase("pt-BR");
    if (s) list = list.filter((p) => `${p.full_name} ${p.username} ${p.email ?? ""}`.toLocaleLowerCase("pt-BR").includes(s));
    return list;
  }, [people, estado, papel, q, folderFilter]);

  const person = people?.find((p) => p.user_id === open) ?? null;

  function exportAccessCsv() {
    if (!people || !current) return;
    const papel: Record<string, string> = { admin: "Administrador", operador: "Operador", visualizador: "Visualizador" };
    const linhas: string[][] = [["Pessoa", "E-mail", "Situação", "Último acesso", "Papel", "Onde", "Origem"]];
    for (const p of people) {
      const base = [p.full_name, p.email ?? "", p.is_active ? "Ativa" : "Desativada", p.last_sign_in_at ? new Date(p.last_sign_in_at).toLocaleString("pt-BR") : "Nunca entrou"];
      for (const g of p.grants) linhas.push([...base, papel[g.role] ?? g.role, g.folder_name ?? "Empresa toda", "Direto"]);
      for (const g of p.via_groups) linhas.push([...base, papel[g.role] ?? g.role, g.folder_name ?? "Empresa toda", `Grupo ${g.group_name}`]);
      if (!p.grants.length && !p.via_groups.length) linhas.push([...base, "—", "—", "Sem acesso"]);
    }
    const csv = "\ufeff" + linhas.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    a.download = `acessos_${current.name.replace(/[^\w]+/g, "-")}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!current) return null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-mac-caption text-(--text-secondary) max-w-2xl">Quem acessa {current.name}, com que papel e onde. O acesso pode vir direto ou por um grupo.{user?.role !== "supremo" && " Contas novas são criadas pelo administrador geral."}</p>
        {state === "ok" && (
          <div className="flex flex-wrap gap-2">
            {/* Revisão de acessos (A9-21): a lista de quem acessa o quê, para conferir à mão. */}
            <Button variant="secondary" onClick={exportAccessCsv}><Download className="w-4 h-4" aria-hidden="true" /> Exportar acessos (CSV)</Button>
            {/* A9-42: só o administrador geral cria contas. */}
            {user?.role === "supremo" && <Button onClick={() => setCreating(true)}><UserPlus className="w-4 h-4" aria-hidden="true" /> Nova pessoa</Button>}
          </div>
        )}
      </div>

      <div role="tablist" aria-label="Pessoas ou grupos" className="flex items-center gap-0.5 p-0.5 rounded-full bg-(--bg-hover) w-fit">
        {([["pessoas", "Pessoas"], ["grupos", "Grupos"]] as const).map(([v, l]) => (
          <button key={v} role="tab" aria-selected={aba === v} onClick={() => setAba(v)}
            className={`px-3 h-8 pointer-coarse:h-10 rounded-full text-mac-body font-medium transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring) ${aba === v ? "bg-(--bg-card) text-(--text-primary) shadow-sm" : "text-(--text-secondary) hover:text-(--text-primary)"}`}>{l}</button>
        ))}
      </div>

      {state === "forbidden" ? (
        <p className="glass-panel glass-blur-card rounded-(--radius-panel) px-5 py-4 text-mac-body text-(--text-primary)">Só quem administra a empresa toda vê e gerencia as pessoas daqui.</p>
      ) : state === "error" ? (
        <div role="alert" className="glass-panel glass-blur-card rounded-(--radius-panel) flex flex-wrap items-center gap-3 px-5 py-4">
          <AlertTriangle className="w-4 h-4 text-(--text-warning)" aria-hidden="true" />
          <p className="flex-1 text-mac-body text-(--text-primary)">Não foi possível carregar as pessoas.</p>
          <Button variant="secondary" size="sm" onClick={load}><RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> Tentar de novo</Button>
        </div>
      ) : state === "loading" ? (
        <div className="space-y-2" aria-label="Carregando">{[0, 1, 2, 3].map((i) => <div key={i} className="h-16 rounded-(--radius-control) bg-(--bg-hover) animate-pulse" />)}</div>
      ) : aba === "grupos" ? (
        <GroupsTab companyId={current.id} people={people ?? []} folders={folders} onChanged={load} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-48 max-w-80">
              <label htmlFor={`${uid}-q`} className="sr-only">Buscar pessoa</label>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-(--text-secondary)" aria-hidden="true" />
              <input id={`${uid}-q`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, usuário ou e-mail"
                className="h-9 pointer-coarse:h-11 w-full rounded-full border border-(--border-control) bg-(--bg-card) pl-8 pr-3 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) placeholder:text-(--text-placeholder) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
            </div>
            <div className="w-44"><Dropdown ariaLabel="Filtrar por papel" value={papel} onChange={setPapel} options={[{ value: "", label: "Todos os papéis" }, ...ROLE_OPTS]} /></div>
            <div className="w-48"><Dropdown ariaLabel="Filtrar por estado" value={estado} onChange={setEstado}
              options={[{ value: "ativas", label: "Contas ativas" }, { value: "desativadas", label: "Desativadas" }, { value: "grupo", label: "Com acesso por grupo" }, { value: "todas", label: "Todas" }]} /></div>
            {folderFilter && (
              <button onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.delete("folder"); return n; }, { replace: true })}
                className="h-9 px-3 rounded-full bg-teal-500/12 text-mac-caption font-medium text-(--text-accent)">Com acesso a {folderName ?? "pasta"} ✕</button>
            )}
          </div>
          <p className="sr-only" role="status" aria-live="polite">{visible.length} pessoas</p>
          {visible.length === 0 ? <p className="text-mac-body text-(--text-secondary)">Ninguém com esses filtros.</p> : (
            <ul className="glass-panel glass-blur-card glass-highlight-line rounded-(--radius-panel) overflow-hidden">
              {visible.map((p) => {
                const resumo = [
                  ...p.grants.map((g) => `${ROLE_LABEL[g.role]} ${where(g.folder_name)}`),
                  ...p.via_groups.map((g) => `${ROLE_LABEL[g.role]} ${where(g.folder_name)} (grupo ${g.group_name})`),
                ];
                return (
                  <li key={p.user_id} className="border-b border-(--border-default) last:border-0">
                    <button onClick={() => setOpen(p.user_id)}
                      className="w-full text-left flex items-center gap-3 px-4 sm:px-5 py-3 min-h-16 hover:bg-(--bg-hover) transition-colors duration-fast focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-(--focus-ring)">
                      <Avatar name={p.full_name} size="md" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-mac-body text-(--text-primary) truncate">
                          {p.full_name}{p.user_id === user?.id && <span className="text-(--text-secondary)"> (você)</span>}
                          {!p.is_active && <span className="ml-2 text-mac-caption font-medium text-(--text-danger)">desativada</span>}
                          {p.must_change_password && <span className="ml-2 text-mac-caption font-medium text-(--text-warning)">senha provisória</span>}
                        </span>
                        <span className="block text-mac-caption text-(--text-secondary) truncate">{resumo.join(" · ") || "sem acesso"}</span>
                        <span className="block text-mac-caption text-(--text-secondary) truncate">
                          {p.email ?? p.username} · {p.last_sign_in_at ? `último acesso ${relativeDate(p.last_sign_in_at)}` : "nunca entrou"}
                        </span>
                      </span>
                      <ChevronRight className="w-4 h-4 text-(--text-secondary) shrink-0" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <details className="text-mac-caption text-(--text-secondary)">
            <summary className="cursor-pointer font-medium text-(--text-accent)">O que cada papel pode fazer</summary>
            <dl className="mt-2 space-y-1">{Object.entries(ROLE_HELP).map(([r, t]) => <div key={r}><dt className="inline font-medium text-(--text-primary)">{ROLE_LABEL[r]}: </dt><dd className="inline">{t}</dd></div>)}</dl>
          </details>
        </>
      )}

      {person && <PersonDialog companyId={current.id} person={person} folders={folders} isSelf={person.user_id === user?.id} onClose={() => setOpen(null)} onChanged={load} />}
      {creating && <NewPersonDialog companyId={current.id} folders={folders} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
    </div>
  );
}

function PersonDialog({ companyId, person, folders, isSelf, onClose, onChanged }: {
  companyId: string; person: Person; folders: FolderOption[]; isSelf: boolean; onClose: () => void; onChanged: () => void;
}) {
  const { success, error: showError } = useToast();
  const { user } = useAuthContext();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [newRole, setNewRole] = useState("visualizador");
  const [newFolder, setNewFolder] = useState("");
  const [confirm, setConfirm] = useState<null | { kind: "revoke"; grant: DirectGrant } | { kind: "remove" } | { kind: "deactivate" } | { kind: "mfa" }>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [explainFolder, setExplainFolder] = useState("");
  const [explain, setExplain] = useState<ExplainResult | null | "erro">(null);

  useEffect(() => {
    setExplain(null);
    api.get<ExplainResult>(`/companies/${companyId}/explain-access`, { params: { user_id: person.user_id, folder_id: explainFolder || undefined } })
      .then((r) => setExplain(r.data)).catch(() => setExplain("erro"));
  }, [companyId, person.user_id, explainFolder, person.grants.length, person.via_groups.length]);

  async function act(fn: () => Promise<unknown>, ok: string, fallback: string) {
    setBusy(true);
    try { await fn(); success(ok); onChanged(); return true; } catch (e) { showError(friendly(e, fallback)); return false; } finally { setBusy(false); }
  }

  const opts = folderOptions(folders);
  return (
    <>
      <Dialog onClose={onClose} title={person.full_name} description={`${person.email ?? person.username}${person.company_count > 1 ? ` · acessa ${person.company_count} empresas` : ""}`} size="lg" busy={busy}>
        <div className="space-y-6">
          {!person.is_active && <p className="rounded-(--radius-control) bg-red-500/10 px-3 py-2 text-mac-body text-(--text-primary)">Conta desativada: não entra no Docke. O histórico e os documentos dela continuam.</p>}

          <section aria-labelledby={`${uid}-dir`} className="space-y-2">
            <h3 id={`${uid}-dir`} className="text-mac-body font-semibold text-(--text-primary)">Acessos diretos</h3>
            {person.grants.length === 0 ? <p className="text-mac-body text-(--text-secondary)">Nenhum: o acesso vem só dos grupos abaixo.</p> : (
              <ul className="divide-y divide-(--border-default) rounded-(--radius-control) border border-(--border-default)">
                {person.grants.map((g) => (
                  <li key={g.access_id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                    <span className="flex-1 min-w-36 text-mac-body text-(--text-primary)">{g.folder_name ?? "Empresa toda"}</span>
                    <div className="w-44">
                      <Dropdown ariaLabel={`Papel ${where(g.folder_name)}`} value={g.role} disabled={busy}
                        onChange={(v) => act(() => api.patch(`/companies/${companyId}/access/${g.access_id}`, { permission_level: v }), `Agora é ${ROLE_LABEL[v]} ${where(g.folder_name)}.`, "Não foi possível trocar o papel.")}
                        options={ROLE_OPTS} />
                    </div>
                    <Button variant="icon" size="sm" aria-label={`Tirar acesso ${where(g.folder_name)}`} onClick={() => setConfirm({ kind: "revoke", grant: g })}>
                      <Trash2 className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-44"><label id={`${uid}-nr`} className="block text-mac-caption text-(--text-secondary) mb-1">Papel</label><Dropdown ariaLabelledby={`${uid}-nr`} value={newRole} onChange={setNewRole} options={ROLE_OPTS} /></div>
              <div className="w-56"><label id={`${uid}-nf`} className="block text-mac-caption text-(--text-secondary) mb-1">Onde</label><Dropdown ariaLabelledby={`${uid}-nf`} value={newFolder} onChange={setNewFolder} options={opts} /></div>
              <Button variant="secondary" size="sm" disabled={busy}
                onClick={() => act(() => api.post(`/companies/${companyId}/members/${person.user_id}/access`, { permission_level: newRole, folder_id: newFolder || null }), "Acesso adicionado.", "Não foi possível adicionar o acesso.")}>
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Adicionar acesso
              </Button>
            </div>
            <p className="text-mac-caption text-(--text-secondary)">{ROLE_HELP[newRole]}</p>
          </section>

          {person.via_groups.length > 0 && (
            <section aria-labelledby={`${uid}-gr`} className="space-y-2">
              <h3 id={`${uid}-gr`} className="text-mac-body font-semibold text-(--text-primary)">Acessos por grupo</h3>
              <ul className="space-y-1">
                {person.via_groups.map((g, i) => (
                  <li key={i} className="flex items-center gap-2 text-mac-body text-(--text-primary)">
                    <UsersRound className="w-4 h-4 text-(--text-secondary)" aria-hidden="true" /> {ROLE_LABEL[g.role]} {where(g.folder_name)} <span className="text-(--text-secondary)">pelo grupo {g.group_name}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby={`${uid}-ex`} className="space-y-2">
            <h3 id={`${uid}-ex`} className="flex items-center gap-1.5 text-mac-body font-semibold text-(--text-primary)"><HelpCircle className="w-4 h-4 text-(--text-accent)" aria-hidden="true" /> O que vê, e por quê</h3>
            <div className="w-64"><Dropdown ariaLabel="Lugar para conferir" value={explainFolder} onChange={setExplainFolder} options={opts} /></div>
            <div aria-live="polite">
              {explain === null ? <p className="text-mac-caption text-(--text-secondary)">Conferindo…</p>
                : explain === "erro" ? <p className="text-mac-body text-(--text-danger)">Não foi possível conferir agora. Isso não quer dizer que a pessoa não tenha acesso.</p>
                : explain.candidates.length === 0 ? <p className="text-mac-body text-(--text-primary)">Sem acesso {explainFolder ? "a esta pasta" : "à empresa toda"}: nenhuma concessão direta nem grupo cobre este lugar.</p>
                : (
                  <div className="space-y-1">
                    <p className="text-mac-body text-(--text-primary)">Resultado: <strong>{ROLE_LABEL[explain.resolved ?? ""] ?? explain.resolved}</strong> {explainFolder ? "nesta pasta (e nas subpastas)" : "na empresa toda"}. {ROLE_HELP[explain.resolved ?? ""]}</p>
                    <ul className="space-y-0.5">
                      {explain.candidates.map((c, i) => (
                        <li key={i} className={`flex items-start gap-1.5 text-mac-caption ${c.is_winner ? "text-(--text-primary)" : "text-(--text-secondary)"}`}>
                          {c.is_winner ? <Check className="w-3.5 h-3.5 mt-0.5 text-(--text-success)" aria-hidden="true" /> : <span className="w-3.5" />}
                          {c.source === "grupo" ? `Grupo ${c.group_name}` : "Concessão direta"}: {ROLE_LABEL[c.permission_level]} {c.folder_path ? `em ${c.folder_name ?? "pasta"}` : "na empresa toda"}
                          {c.is_winner ? " (vale esta)" : " (perde para uma mais específica)"}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
            </div>
          </section>

          {!isSelf && (
            <section aria-label="Conta" className="flex flex-wrap gap-2 border-t border-(--border-default) pt-4">
              {person.is_active ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirm({ kind: "deactivate" })}><Ban className="w-3.5 h-3.5" aria-hidden="true" /> Desativar conta</Button>
              ) : (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => api.post(`/companies/${companyId}/members/${person.user_id}/activate`), "Conta reativada.", "Não foi possível reativar.")}><RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reativar conta</Button>
              )}
              <Button variant="secondary" size="sm" disabled={busy || !person.is_active}
                onClick={async () => {
                  setBusy(true);
                  try { const r = await api.post(`/companies/${companyId}/members/${person.user_id}/reset-password`); setTempPassword(r.data.temporary_password); onChanged(); }
                  catch (e) { showError(friendly(e, "Não foi possível gerar a senha.")); } finally { setBusy(false); }
                }}>
                <KeyRound className="w-3.5 h-3.5" aria-hidden="true" /> Gerar senha provisória
              </Button>
              {/* Celular perdido: só o administrador geral zera o app autenticador. */}
              {user?.role === "supremo" && person.mfa_enabled && (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirm({ kind: "mfa" })}><Smartphone className="w-3.5 h-3.5" aria-hidden="true" /> Zerar verificação em duas etapas</Button>
              )}
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm({ kind: "remove" })}><Trash2 className="w-3.5 h-3.5 text-(--text-danger)" aria-hidden="true" /> Remover desta empresa</Button>
            </section>
          )}
        </div>
      </Dialog>

      {confirm?.kind === "revoke" && (
        <ConfirmModal title="Tirar este acesso?" loading={busy} confirmLabel="Tirar" danger
          description={<>{person.full_name} deixa de ser {ROLE_LABEL[confirm.grant.role]} {where(confirm.grant.folder_name)}.{person.grants.length === 1 && person.via_groups.length === 0 ? " É o último acesso dela: use “Remover desta empresa”." : ""}</>}
          onClose={() => setConfirm(null)}
          onConfirm={async () => { if (await act(() => api.delete(`/companies/${companyId}/access/${confirm.grant.access_id}`), "Acesso retirado.", "Não foi possível tirar o acesso.")) setConfirm(null); }} />
      )}
      {confirm?.kind === "deactivate" && (
        <ConfirmModal title={`Desativar a conta de ${person.full_name}?`} loading={busy} confirmLabel="Desativar" danger
          description={<>A pessoa não entra mais{person.company_count > 1 ? " em nenhuma das empresas" : ""} e o que estiver aberto para na próxima ação. Nada é apagado; dá para reativar.</>}
          onClose={() => setConfirm(null)}
          onConfirm={async () => { if (await act(() => api.post(`/companies/${companyId}/members/${person.user_id}/deactivate`), "Conta desativada.", "Não foi possível desativar.")) setConfirm(null); }} />
      )}
      {confirm?.kind === "remove" && (
        <ConfirmModal title={`Remover ${person.full_name} desta empresa?`} loading={busy} confirmLabel="Remover" danger
          description="Saem todos os acessos diretos e os grupos desta empresa. A conta continua (se ela acessa outras empresas) e o histórico fica."
          onClose={() => setConfirm(null)}
          onConfirm={async () => { if (await act(() => api.delete(`/companies/${companyId}/members/${person.user_id}`), "Removida da empresa.", "Não foi possível remover.")) { setConfirm(null); onClose(); } }} />
      )}
      {confirm?.kind === "mfa" && (
        <ConfirmModal title={`Zerar a verificação em duas etapas de ${person.full_name}?`} loading={busy} confirmLabel="Zerar" danger
          description="Use quando a pessoa perdeu ou trocou o celular. No próximo acesso ela cadastra o app de novo (se a regra da empresa exigir) ou entra só com a senha."
          onClose={() => setConfirm(null)}
          onConfirm={async () => { if (await act(() => api.post(`/companies/${companyId}/members/${person.user_id}/reset-mfa`), "Verificação zerada.", "Não foi possível zerar.")) setConfirm(null); }} />
      )}
      {tempPassword && <PasswordShown name={person.full_name} password={tempPassword} onClose={() => setTempPassword(null)} />}
    </>
  );
}

function PasswordShown({ name, password, onClose }: { name: string; password: string; onClose: () => void }) {
  const { success } = useToast();
  return (
    <Dialog onClose={onClose} title="Senha provisória" size="sm" description={`Entregue a ${name} por um canal seguro. No primeiro acesso ela cria a própria senha. Esta senha não aparece de novo.`}
      footer={<Button onClick={onClose}>Pronto</Button>}>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded-(--radius-control) bg-(--bg-hover) px-3 py-2 font-mono text-mac-callout text-(--text-primary) select-all">{password}</code>
        <Button variant="secondary" size="sm" onClick={() => navigator.clipboard.writeText(password).then(() => success("Senha copiada."))}><Copy className="w-3.5 h-3.5" aria-hidden="true" /> Copiar</Button>
      </div>
    </Dialog>
  );
}

function NewPersonDialog({ companyId, folders, onClose, onCreated }: { companyId: string; folders: FolderOption[]; onClose: () => void; onCreated: () => void }) {
  const { error: showError } = useToast();
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password] = useState(generatePassword);
  const [role, setRole] = useState("visualizador");
  const [folderId, setFolderId] = useState("");
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [touched, setTouched] = useState(false);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const errors = { name: !fullName.trim() ? "Informe o nome." : "", user: !/^[a-z0-9._-]{3,}$/.test(username) ? "Use 3 ou mais letras minúsculas, números, ponto ou hífen." : "", email: !emailOk ? "E-mail inválido." : "" };
  const invalid = Object.values(errors).some(Boolean);

  async function create() {
    setTouched(true);
    if (invalid) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/members`, { email: email.trim(), password, username, full_name: fullName.trim(), permission_level: role, folder_id: folderId || null });
      setDone(true);
    } catch (e) { showError(friendly(e, "Não foi possível criar a pessoa.")); } finally { setSaving(false); }
  }

  if (done) return <PasswordShown name={fullName.trim()} password={password} onClose={onCreated} />;
  return (
    <Dialog onClose={onClose} title="Nova pessoa" description="A conta já nasce pronta para entrar. Você entrega a senha inicial." size="md" busy={saving}
      footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button loading={saving} onClick={create}>Criar</Button></>}>
      <div className="space-y-4">
        <Input label="Nome completo" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Maria Silva" error={touched ? errors.name : undefined} autoFocus />
        <Input label="Nome de usuário" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, "."))} placeholder="maria.silva" error={touched ? errors.user : undefined} />
        <Input label="E-mail (usado para entrar)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="maria@empresa.com.br" error={touched ? errors.email : undefined} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><label id="np-role" className="block text-mac-body font-medium text-(--text-secondary) mb-1">Papel</label><Dropdown ariaLabelledby="np-role" value={role} onChange={setRole} options={ROLE_OPTS} /></div>
          <div><label id="np-f" className="block text-mac-body font-medium text-(--text-secondary) mb-1">Onde</label><Dropdown ariaLabelledby="np-f" value={folderId} onChange={setFolderId} options={folderOptions(folders)} /></div>
        </div>
        <p className="text-mac-caption text-(--text-secondary)">{ROLE_HELP[role]}</p>
      </div>
    </Dialog>
  );
}

function GroupsTab({ companyId, people, folders, onChanged }: { companyId: string; people: Person[]; folders: FolderOption[]; onChanged: () => void }) {
  const { success, error: showError } = useToast();
  const [groups, setGroups] = useState<GroupSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState("");
  const [open, setOpen] = useState<GroupSummary | null>(null);
  const [removing, setRemoving] = useState<GroupSummary | null>(null);
  const [busy, setBusy] = useState(false);
  function load() { setFailed(false); api.get<GroupSummary[]>(`/companies/${companyId}/groups`).then((r) => setGroups(r.data ?? [])).catch(() => setFailed(true)); }
  useEffect(load, [companyId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try { await api.post(`/companies/${companyId}/groups`, { name: name.trim() }); setName(""); success("Grupo criado. Abra para pôr pessoas e acessos."); load(); }
    catch (e) { showError(friendly(e, "Não foi possível criar o grupo.")); } finally { setBusy(false); }
  }

  if (failed) return <p role="alert" className="text-mac-body text-(--text-danger)">Não foi possível carregar os grupos. <button className="underline" onClick={load}>Tentar de novo</button></p>;
  if (!groups) return <div className="h-24 rounded bg-(--bg-hover) animate-pulse" />;
  return (
    <div className="space-y-3">
      <p className="text-mac-caption text-(--text-secondary) max-w-2xl">Um grupo junta pessoas que precisam do mesmo acesso (ex.: “Fiscal”, “RH”). Quem entra no grupo recebe os acessos dele; quem sai, perde.</p>
      <form onSubmit={(e) => { e.preventDefault(); create(); }} className="flex gap-2 max-w-md">
        <label htmlFor="novo-grupo" className="sr-only">Nome do grupo</label>
        <input id="novo-grupo" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do novo grupo" maxLength={60}
          className="h-9 pointer-coarse:h-11 flex-1 rounded-(--radius-control) border border-(--border-control) bg-(--bg-card) px-3 text-mac-body pointer-coarse:text-[16px] text-(--text-primary) focus:outline-hidden focus:ring-[3px] focus:ring-(--focus-ring)" />
        <Button type="submit" variant="secondary" disabled={!name.trim() || busy}><Plus className="w-3.5 h-3.5" aria-hidden="true" /> Criar</Button>
      </form>
      {groups.length === 0 ? <p className="text-mac-body text-(--text-secondary)">Nenhum grupo ainda.</p> : (
        <ul className="glass-panel glass-blur-card rounded-(--radius-panel) divide-y divide-(--border-default)">
          {groups.map((g) => (
            <li key={g.id} className="flex items-center gap-3 px-4 py-2.5 min-h-12">
              <UsersRound className="w-4 h-4 text-(--text-secondary)" aria-hidden="true" />
              <button onClick={() => setOpen(g)} className="flex-1 text-left min-w-0 rounded-[6px] hover:underline focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-(--focus-ring)">
                <span className="block text-mac-body text-(--text-primary)">{g.name}</span>
                <span className="block text-mac-caption text-(--text-secondary)">{g.member_count} {g.member_count === 1 ? "pessoa" : "pessoas"} · {g.grant_count} {g.grant_count === 1 ? "acesso" : "acessos"}</span>
              </button>
              <Button variant="icon" size="sm" aria-label={`Excluir grupo ${g.name}`} onClick={() => setRemoving(g)}><Trash2 className="w-4 h-4" aria-hidden="true" /></Button>
            </li>
          ))}
        </ul>
      )}
      {open && <GroupDialog companyId={companyId} group={open} people={people} folders={folders} onClose={() => { setOpen(null); load(); onChanged(); }} />}
      {removing && (
        <ConfirmModal title={`Excluir o grupo “${removing.name}”?`} confirmLabel="Excluir" danger loading={busy}
          description={`${removing.member_count} ${removing.member_count === 1 ? "pessoa perde" : "pessoas perdem"} os acessos que vinham dele (os diretos continuam).`}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            setBusy(true);
            try { await api.delete(`/companies/${companyId}/groups/${removing.id}`); success("Grupo excluído."); setRemoving(null); load(); onChanged(); }
            catch (e) { showError(friendly(e, "Não foi possível excluir.")); } finally { setBusy(false); }
          }} />
      )}
    </div>
  );
}

function GroupDialog({ companyId, group, people, folders, onClose }: { companyId: string; group: GroupSummary; people: Person[]; folders: FolderOption[]; onClose: () => void }) {
  const { success, error: showError } = useToast();
  const [data, setData] = useState<GroupDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState("");
  const [role, setRole] = useState("visualizador");
  const [folder, setFolder] = useState("");
  function load() { setFailed(false); api.get<GroupDetail>(`/companies/${companyId}/groups/${group.id}`).then((r) => setData(r.data)).catch(() => setFailed(true)); }
  useEffect(load, [group.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function act(fn: () => Promise<unknown>, ok: string, fallback: string) {
    setBusy(true);
    try { await fn(); success(ok); load(); } catch (e) { showError(friendly(e, fallback)); } finally { setBusy(false); }
  }
  const fora = people.filter((p) => p.is_active && !data?.members.some((m) => m.user_id === p.user_id));
  return (
    <Dialog onClose={onClose} title={`Grupo ${group.name}`} size="lg" busy={busy}>
      {failed ? <p role="alert" className="text-mac-body text-(--text-danger)">Não foi possível abrir o grupo. <button className="underline" onClick={load}>Tentar de novo</button></p> : !data ? <div className="h-32 rounded bg-(--bg-hover) animate-pulse" /> : (
        <div className="space-y-6">
          <section aria-labelledby="gd-acc" className="space-y-2">
            <h3 id="gd-acc" className="text-mac-body font-semibold text-(--text-primary)">Acessos do grupo</h3>
            {data.grants.length === 0 ? <p className="text-mac-body text-(--text-secondary)">Nenhum: o grupo ainda não dá acesso a nada.</p> : (
              <ul className="space-y-1">{data.grants.map((g) => (
                <li key={g.access_id} className="flex items-center gap-2 text-mac-body text-(--text-primary)">
                  <span className="flex-1">{ROLE_LABEL[g.role]} {where(g.folder_name)}</span>
                  <Button variant="icon" size="sm" aria-label={`Tirar ${ROLE_LABEL[g.role]} ${where(g.folder_name)} do grupo`} disabled={busy}
                    onClick={() => act(() => api.delete(`/companies/${companyId}/groups/${group.id}/access/${g.access_id}`), "Acesso tirado do grupo.", "Não foi possível tirar.")}><Trash2 className="w-4 h-4" aria-hidden="true" /></Button>
                </li>))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-44"><Dropdown ariaLabel="Papel do grupo" value={role} onChange={setRole} options={ROLE_OPTS} /></div>
              <div className="w-56"><Dropdown ariaLabel="Onde" value={folder} onChange={setFolder} options={folderOptions(folders)} /></div>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(() => api.post(`/companies/${companyId}/groups/${group.id}/access`, { permission_level: role, folder_id: folder || null }), "Acesso dado ao grupo.", "Não foi possível dar o acesso.")}><Plus className="w-3.5 h-3.5" aria-hidden="true" /> Dar acesso</Button>
            </div>
          </section>
          <section aria-labelledby="gd-mem" className="space-y-2">
            <h3 id="gd-mem" className="text-mac-body font-semibold text-(--text-primary)">Pessoas ({data.members.length})</h3>
            <ul className="space-y-1">{data.members.map((m) => (
              <li key={m.user_id} className="flex items-center gap-2 text-mac-body text-(--text-primary)">
                <Avatar name={m.full_name} size="sm" /><span className="flex-1">{m.full_name}</span>
                <Button variant="icon" size="sm" aria-label={`Tirar ${m.full_name} do grupo`} disabled={busy}
                  onClick={() => act(() => api.delete(`/companies/${companyId}/groups/${group.id}/members/${m.user_id}`), `${m.full_name} saiu do grupo e perdeu os acessos dele.`, "Não foi possível tirar.")}><Trash2 className="w-4 h-4" aria-hidden="true" /></Button>
              </li>))}
            </ul>
            {fora.length > 0 && (
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-64"><Dropdown ariaLabel="Pessoa para pôr no grupo" value={add} onChange={setAdd} placeholder="Escolha a pessoa" options={fora.map((p) => ({ value: p.user_id, label: p.full_name }))} /></div>
                <Button variant="secondary" size="sm" disabled={!add || busy} onClick={() => act(async () => { await api.post(`/companies/${companyId}/groups/${group.id}/members`, { user_id: add }); setAdd(""); }, "Pessoa adicionada ao grupo.", "Não foi possível adicionar.")}><Plus className="w-3.5 h-3.5" aria-hidden="true" /> Pôr no grupo</Button>
              </div>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}
